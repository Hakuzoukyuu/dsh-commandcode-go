/**
 * DSH LLM adapter for the Command Code Go subscription.
 *
 * This is intentionally a plain object rather than an `LlmAdapter` subclass:
 * DSH's adapter registry is duck-typed, and avoiding `@deepseek-ai/dsh-llm`
 * imports lets the plugin load from any profile.  `attributionHeaders()` is
 * reproduced as a fixed, truthful User-Agent; the request never impersonates
 * the official Command Code CLI.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ALPHA_MAX_TOKENS,
  DEFAULT_USER_AGENT,
  alphaEndpoint,
  alphaFailure,
  alphaThreadId,
  alphaHeaders,
  streamAlpha,
  toAlphaEnvelope,
} from "./alpha.js";
import { ROUTE } from "./config.js";

const IMAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_LONG_EDGE = 1568;
const IMAGE_TOTAL_BASE64_BUDGET = 20 * 1024 * 1024;

const RETRYABLE_CODES = [
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "PROVIDER_ERROR",
  "STREAM_CLOSED",
];

function asInteger(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function requestOutputCap(info, config) {
  const desired = Math.max(1024, Math.min(ALPHA_MAX_TOKENS, asInteger(config.defaultMaxTokens, 32768)));
  const modelMax = asInteger(info.maxOutputTokens, ALPHA_MAX_TOKENS);
  const context = asInteger(
    info.context?.contextWindow ?? info.context_length,
    config.defaultContextWindow ?? 262144,
  );
  return Math.max(1024, Math.min(desired, modelMax, context, ALPHA_MAX_TOKENS));
}

export function resolveMaxTokens(requested, info, config) {
  const cap = requestOutputCap(info, config);
  const n = asInteger(requested, 0);
  if (!n) return cap;
  return Math.max(1024, Math.min(n, cap, ALPHA_MAX_TOKENS));
}

function authFileKey() {
  const explicit = process.env.COMMANDCODE_AUTH_FILE;
  const path = explicit || join(homedir(), ".commandcode", "auth.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const candidates = [
      data?.apiKey,
      data?.api_key,
      data?.accessToken,
      data?.access_token,
      data?.token,
      data?.key,
      data?.auth?.apiKey,
      data?.auth?.accessToken,
      data?.account?.apiKey,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // Missing or malformed CLI credentials are expected when the user has not
    // logged in; the Settings key remains the primary source.
  }
  return undefined;
}

export function resolveApiKey(config) {
  if (typeof config.apiKey === "string" && config.apiKey.trim()) {
    return config.apiKey.trim();
  }
  const names = [
    config.apiKeyEnv,
    "CMD_API_KEY",
    "COMMAND_CODE_API_KEY",
  ].filter((name) => typeof name === "string" && name.trim());
  for (const name of [...new Set(names)]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const stored = authFileKey();
  if (stored) return stored;
  throw alphaFailure(
    "No Command Code API key is configured. Add one in Settings → Plugins → Command Code Go, set CMD_API_KEY, or log in with the Command Code CLI.",
    "AUTH",
  );
}

function imageTarget(ref) {
  const width = asInteger(ref?.width, 0);
  const height = asInteger(ref?.height, 0);
  if (!width && !height) {
    return { width: IMAGE_LONG_EDGE, height: IMAGE_LONG_EDGE, maxBytes: IMAGE_MAX_BYTES };
  }
  const longEdge = Math.max(width, height);
  const scale = longEdge > IMAGE_LONG_EDGE ? IMAGE_LONG_EDGE / longEdge : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    maxBytes: IMAGE_MAX_BYTES,
  };
}

const TEMPERATURE_PINNED = new Set(["moonshotai/Kimi-K3.1-Pro"]);

function isTemperaturePinned(model) {
  return TEMPERATURE_PINNED.has(model) || TEMPERATURE_PINNED.has(String(model).toLowerCase());
}

function imageRefId(block) {
  const ref = block?.attachment ?? block?.image ?? block?.ref ?? block;
  const id = ref?.id ?? ref?.attachmentId ?? ref?.attachment_id ?? block?.id;
  return id === undefined || id === null ? null : String(id);
}

function isOffloaded(block) {
  const ref = block?.attachment ?? block?.image ?? block?.ref ?? block;
  return Boolean(block?.offloaded || block?.offload || ref?.offloaded || ref?.offload);
}

function bufferOf(data) {
  if (typeof data === "string") {
    const comma = data.indexOf(",");
    const base64 = data.startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data;
    return Buffer.from(base64, "base64");
  }
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Resolve attachment refs into the base64 payloads the alpha wire expects.
 * Images are only sent to models whose catalog entry advertises image input.
 */
export async function collectImages({ messages, info, attachments, signal }) {
  const result = new Map();
  if (!info.inputModalities?.includes("image")) return result;

  const refs = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "image" && block?.type !== "attachment") continue;
      if (isOffloaded(block)) continue;
      const id = imageRefId(block);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      refs.push({ id, block });
    }
  }
  if (refs.length === 0) return result;

  if (!attachments || typeof attachments.readImageRequest !== "function") {
    throw alphaFailure(
      `Model "${info.id}" accepts images, but DSH's attachment service is unavailable. Remove the image or choose a text-only model.`,
      "INVALID_REQUEST",
    );
  }

  const encoded = [];
  for (const { id, block } of refs) {
    const ref = block.attachment ?? block.image ?? block.ref ?? block;
    let version;
    try {
      version = await attachments.readImageRequest(ref, imageTarget(ref), signal);
    } catch (error) {
      if (error?.failure) throw error;
      throw alphaFailure(
        `Could not read image attachment ${id}: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_REQUEST",
      );
    }
    const bytes = bufferOf(version?.data);
    if (!bytes || bytes.byteLength === 0) {
      throw alphaFailure(`Image attachment ${id} is unavailable`, "INVALID_REQUEST");
    }
    const mediaType = version?.mediaType ?? ref?.mediaType ?? "image/png";
    const base64Bytes = Math.ceil(bytes.byteLength / 3) * 4;
    encoded.push({ id, bytes, mediaType, base64Bytes });
  }

  let total = 0;
  for (const item of encoded) total += item.base64Bytes;
  if (total > IMAGE_TOTAL_BASE64_BUDGET) {
    let excess = total - IMAGE_TOTAL_BASE64_BUDGET;
    let drop = 0;
    for (const item of [...encoded].sort((a, b) => b.base64Bytes - a.base64Bytes)) {
      excess -= item.base64Bytes;
      drop += 1;
      if (excess <= 0) break;
    }
    throw alphaFailure(
      `The request contains ${encoded.length} images (${total} base64 bytes); the alpha transport allows ${IMAGE_TOTAL_BASE64_BUDGET}. Offload ${drop} image(s) and retry.`,
      "IMAGE_OFFLOAD_REQUIRED",
      { offloadImages: drop },
    );
  }

  for (const item of encoded) {
    result.set(item.id, { data: item.bytes, mediaType: item.mediaType });
  }
  return result;
}

function firstUserText(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "text" && part.text) return part.text;
    }
  }
  return "";
}

function sessionSeed(options) {
  if (options.sessionId !== undefined && options.sessionId !== null) {
    return String(options.sessionId);
  }
  if (options.conversationId !== undefined && options.conversationId !== null) {
    return String(options.conversationId);
  }
  return `${options.system ?? ""}\n${firstUserText(options.messages)}`;
}

function reasoningInfo(model) {
  const seen = new Set();
  const efforts = [];
  for (const effort of model.reasoningEfforts ?? []) {
    if (!effort?.id || seen.has(effort.id)) continue;
    seen.add(effort.id);
    efforts.push({ id: effort.id, name: effort.name || effort.id });
  }
  if (efforts.length === 0) return undefined;
  const preferred = ["high", "max", "medium", "low", "off"].find((id) => seen.has(id));
  return { efforts, defaultEffort: preferred ?? efforts[0].id };
}

function notFound(model) {
  return alphaFailure(
    `Unknown Command Code model "${model}". Check the model list in Settings → Plugins → Command Code Go, or clear the explicit model list to use the live catalog.`,
    "INVALID_REQUEST",
  );
}

export function createAdapter({ getConfig, catalog, getAttachments, logger, fetchImpl = fetch }) {
  function providerInfo(provider) {
    return { id: provider, name: "Command Code Go" };
  }

  function imageRequestPricing() {
    return undefined;
  }

  function imageRequestTarget(_provider, _model, image) {
    return imageTarget(image);
  }

  function providerRetryPolicy() {
    const config = getConfig();
    return {
      mode: "normal",
      maxRetries: Math.max(0, Math.min(10, asInteger(config.retries, 3))),
      retryableCodes: [...RETRYABLE_CODES],
      // DSH consumes an adapter's policy as-is (unlike provider config, which
      // is normalized by resolveRetryPolicy), so the backoff fields are flat.
      initialDelayMs: 800,
      maxDelayMs: 15000,
      jitterRatio: 0.1,
    };
  }

  async function listModels(provider, options = {}) {
    if (provider !== ROUTE) throw notFound(provider);
    const config = getConfig();
    const models = await catalog.list({
      plan: config.plan,
      ids: config.models,
      signal: options.signal,
    });
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
    }));
  }

  async function resolveModel(provider, model, signal) {
    const config = getConfig();
    return resolveModelWith(provider, model, signal, config);
  }

  async function resolveModelWith(provider, model, signal, config) {
    if (provider !== ROUTE) throw notFound(provider);
    const info = await catalog.lookup(model, { signal });
    if (!info) throw notFound(model);
    const modalities = info.inputModalities?.includes("text")
      ? [...info.inputModalities]
      : ["text", ...(info.inputModalities ?? [])];
    const resolved = {
      provider,
      id: info.id,
      name: info.name,
      context: { contextWindow: info.context_length },
      defaultMaxTokens: requestOutputCap(info, config),
      inputModalities: modalities,
    };
    if (info.description) resolved.description = info.description;
    const reasoning = reasoningInfo(info);
    if (reasoning) resolved.reasoning = reasoning;
    return resolved;
  }

  async function prepareCall(provider, model, signal) {
    const config = getConfig();
    const info = await resolveModelWith(provider, model, signal, config);
    return {
      model: info,
      stream: (options) =>
        streamCall({ ...options, provider, model, info }, config),
    };
  }

  async function* streamCall(options, config) {
    const provider = options.provider ?? ROUTE;
    if (provider !== ROUTE) throw notFound(provider);
    const info = options.info;
    if (!info) throw notFound(options.model);
    const apiKey = resolveApiKey(config);
    const images = await collectImages({
      messages: options.messages,
      info,
      attachments: getAttachments(),
      signal: options.signal,
    });
    const maxTokens = resolveMaxTokens(options.maxTokens, info, config);
    const effort =
      typeof options.reasoningEffort === "string" ? options.reasoningEffort : undefined;
    const temperature = isTemperaturePinned(info.id) ? undefined : options.temperature;
    const threadId = alphaThreadId(sessionSeed(options));
    const body = toAlphaEnvelope({
      model: info.id,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      images,
      maxTokens,
      temperature,
      effort,
      threadId,
    });
    const headers = alphaHeaders({
      apiKey,
      alphaVersion: config.alphaVersion,
      threadId,
      userAgent: DEFAULT_USER_AGENT,
    });
    logger?.debug?.("commandcode-go: calling %s with %s (thread %s)", info.id, config.plan, threadId);
    yield* streamAlpha({
      url: alphaEndpoint(config.baseURL),
      headers,
      body,
      signal: options.signal,
      timeoutMs: config.streamTimeoutMs,
      fetchImpl,
    });
  }

  return {
    providerInfo,
    providerRetryPolicy,
    imageRequestPricing,
    imageRequestTarget,
    listModels,
    resolveModel,
    prepareCall,
  };
}
