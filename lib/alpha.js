/**
 * Command Code CLI alpha transport.
 *
 * Command Code's Go subscription has no official API. Its CLI talks to
 * POST https://api.commandcode.ai/alpha/generate with a JSON envelope and reads
 * back newline-delimited JSON.  This module mirrors that exchange without
 * starting a local HTTP server: DSH calls the adapter, the adapter calls the
 * alpha endpoint, and NDJSON is translated into DSH assistant-stream chunks.
 *
 * The wire is undocumented and can change without notice.
 */

import { createHash } from "node:crypto";

export const ALPHA_PATH = "/alpha/generate";
export const ALPHA_MAX_TOKENS = 131072;
export const DEFAULT_USER_AGENT =
  "deepseek-harness/0.2.1 (+https://github.com/deepseek-ai/deepseek-harness)";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Build a transport error carrying the failure shape DSH preserves. */
export function alphaFailure(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.failure = { message, code, ...extra };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) error[key] = value;
  }
  return error;
}

export function alphaEndpoint(baseURL) {
  const url = new URL(baseURL);
  return `${url.origin}${ALPHA_PATH}`;
}

/**
 * The endpoint requires a UUID.  A stable conversation seed keeps the
 * provider-side prompt prefix cache warm across turns.
 */
export function alphaThreadId(seed) {
  const input = String(seed ?? "");
  if (UUID_RE.test(input)) return input;
  const bytes = createHash("sha1")
    .update(`dsh-commandcode-go:${input}`)
    .digest();
  const id = Buffer.from(bytes.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x50;
  id[8] = (id[8] & 0x3f) | 0x80;
  const hex = id.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function alphaHeaders({ apiKey, alphaVersion, threadId, userAgent }) {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/x-ndjson, text/event-stream, application/json",
    "x-command-code-version": alphaVersion,
    "x-cli-environment": "external",
    "x-project-slug": "dsh",
    "x-session-id": threadId,
    "x-taste-learning": "false",
    "x-co-flag": "false",
    "user-agent": userAgent || DEFAULT_USER_AGENT,
  };
}

function textOf(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text ?? "";
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function safeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function imagePart(block, images) {
  const ref = block?.attachment ?? block?.image ?? block?.ref ?? block;
  const id = ref?.id ?? ref?.attachmentId ?? ref?.attachment_id ?? block?.id;
  if (id === undefined || id === null) return null;
  const image = images.get(String(id));
  if (!image) return null;
  const mediaType = image.mediaType || ref.mediaType || "image/png";
  const base64 =
    typeof image.data === "string"
      ? image.data
      : Buffer.from(image.data).toString("base64");
  const imageURL = base64.startsWith("data:")
    ? base64
    : `data:${mediaType};base64,${base64}`;
  return {
    type: "image",
    image: imageURL,
    mediaType,
  };
}

function toolResultContent(block, message, toolNames) {
  const toolCallId = String(
    block.toolCallId ?? block.tool_call_id ?? block.id ?? message.toolCallId ?? "",
  );
  const toolName =
    block.toolName ??
    block.tool_name ??
    message.toolName ??
    toolNames.get(toolCallId) ??
    "";
  let output = block.output ?? block.result;
  if (output === undefined) {
    const text = textOf(block.content ?? block.text);
    output = { type: "text", value: text };
  } else if (typeof output === "string") {
    output = { type: "text", value: output };
  } else if (typeof output === "object" && typeof output.type !== "string") {
    output = { type: "json", value: output };
  }
  return { type: "tool-result", toolCallId, toolName, output };
}

function isToolResultMessage(message) {
  if (message?.role === "tool") return true;
  if (message?.role !== "user") return false;
  if (message.source?.kind === "tool") return true;
  const content = message.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => part?.type === "tool-result")
  );
}

/**
 * Convert DSH messages into the AI-SDK-shaped messages the alpha endpoint
 * accepts.  System messages are folded into params.system by the caller.
 */
function encodeMessages(messages, images) {
  const out = [];
  const toolNames = new Map();
  const systemParts = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;

    if (role === "system") {
      const text = textOf(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (isToolResultMessage(message)) {
      // DSH 0.2.x stores a tool result as
      // {role:"tool", toolCallId, content:[{type:"text",text}]}.
      // Legacy messages may instead carry explicit tool-result parts.
      const explicit = Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === "tool-result")
        : [];
      const blocks = explicit.length > 0
        ? explicit
        : [{ ...message, type: "tool-result", content: message.content }];
      const results = blocks.map((block) =>
        toolResultContent(block, message, toolNames),
      );
      const previous = out.at(-1);
      if (previous?.role === "tool") previous.content.push(...results);
      else out.push({ role: "tool", content: results });
      continue;
    }

    if (role === "assistant") {
      const content = [];
      const parts = Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: textOf(message.content) }];
      for (const part of parts) {
        if (typeof part === "string") {
          if (part) content.push({ type: "text", text: part });
          continue;
        }
        if (part?.type === "text" && part.text) {
          content.push({ type: "text", text: part.text });
        } else if (part?.type === "reasoning" || part?.type === "thinking") {
          // The CLI replays historical reasoning as a plain text part.  DeepSeek
          // thinking-mode tool loops reject the next request without it.
          const text = part.text ?? part.reasoning ?? "";
          if (text) content.push({ type: "reasoning", text });
        } else if (part?.type === "tool-call") {
          const toolCallId = String(part.toolCallId ?? part.tool_call_id ?? part.id ?? "");
          const toolName = part.toolName ?? part.tool_name ?? part.name ?? "";
          if (toolCallId) toolNames.set(toolCallId, toolName);
          content.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input: safeJson(part.input ?? part.arguments ?? {}),
          });
        }
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }

    const content = [];
    const parts = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: textOf(message.content) }];
    for (const part of parts) {
      if (typeof part === "string") {
        if (part) content.push({ type: "text", text: part });
        continue;
      }
      if (part?.type === "text" && part.text) {
        content.push({ type: "text", text: part.text });
      } else if (part?.type === "image" || part?.type === "attachment") {
        const image = imagePart(part, images);
        if (image) content.push(image);
      }
    }
    if (content.length > 0) out.push({ role: "user", content });
  }

  return { messages: out, systemParts };
}

function localDate(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * Build the CLI envelope.  `params.system` must be at least a single space:
 * an empty string makes the upstream inject its own large default prompt.
 */
export function toAlphaEnvelope({
  model,
  system,
  messages,
  tools,
  images = new Map(),
  maxTokens,
  temperature,
  effort,
  threadId,
  now,
}) {
  const encoded = encodeMessages(messages, images);
  const explicitSystem = Array.isArray(system) ? system.join("\n\n") : textOf(system);
  const systemParts = [...encoded.systemParts];
  if (explicitSystem) systemParts.unshift(explicitSystem);
  const systemText = systemParts.filter(Boolean).join("\n\n").trim() || " ";

  const params = {
    model,
    system: systemText,
    messages: encoded.messages,
    tools: (Array.isArray(tools) ? tools : []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.parameters ?? tool.inputSchema ?? { type: "object" },
    })),
    stream: true,
  };
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    params.max_tokens = Math.min(ALPHA_MAX_TOKENS, Math.floor(maxTokens));
  }
  if (Number.isFinite(temperature) && temperature >= 0) {
    params.temperature = temperature;
  }
  if (effort) params.reasoning_effort = String(effort);

  return {
    config: {
      workingDir: "",
      date: localDate(now),
      environment: "external",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: "",
    skills: "",
    permissionMode: "standard",
    params,
    threadId,
  };
}

/** Parse one NDJSON line, tolerating SSE `data:` framing and `[DONE]`. */
export function parseAlphaEvent(line) {
  let text = String(line ?? "").trim();
  if (!text || text.startsWith(":")) return null;
  if (/^(event|id|retry):/i.test(text)) return null;
  if (/^data:/i.test(text)) text = text.slice(5).trim();
  if (!text) return null;
  if (text === "[DONE]") return { type: "done" };
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function classifyAlphaError(text, status) {
  const body = String(text ?? "").toLowerCase();
  if (
    status === 401 ||
    /invalid.{0,20}(api key|token)|unauthor|authentication|not authenticated/.test(body)
  ) {
    return "AUTH";
  }
  if (
    /upgrade_required|upgrade required|api access|plan required|not available on your plan|not included in your plan|requires a (higher|paid)/.test(
      body,
    )
  ) {
    return "FORBIDDEN";
  }
  if (
    status === 402 ||
    /quota|credit|payment required|insufficient (balance|funds)/.test(body)
  ) {
    return "QUOTA";
  }
  if (status === 403) return "FORBIDDEN";
  if (status === 429 || /rate.?limit|too many requests/.test(body)) return "RATE_LIMIT";
  if (
    status === 400 ||
    /validation|bad request|invalid uuid|invalid request|expected\b/.test(body)
  ) {
    return "INVALID_REQUEST";
  }
  if (status >= 500 || /internal server|server error|bad gateway/.test(body)) return "SERVER";
  if (/timeout|timed out/.test(body)) return "TIMEOUT";
  if (/abort/.test(body)) return "ABORTED";
  return "PROVIDER_ERROR";
}

function number(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Convert upstream usage into DSH's disjoint token accounting. */
export function alphaUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const cached =
    number(usage.cachedInputTokens ?? usage.cacheReadInputTokens ?? usage.cached_tokens);
  const rawInput =
    number(usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens);
  const input = Math.max(0, rawInput - cached);
  const output =
    number(usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens);
  const result = { inputTokens: input, outputTokens: output };
  const total = number(usage.totalTokens ?? usage.total_tokens);
  if (total > 0) result.totalTokens = total;
  if (cached > 0) result.cacheReadTokens = cached;
  const reasoning = number(usage.reasoningTokens ?? usage.reasoning_tokens);
  if (reasoning > 0) result.reasoningTokens = reasoning;
  return result;
}

function closeText(state) {
  if (!state.text) return [];
  const block = state.text;
  state.text = null;
  return [
    {
      type: "block-end",
      index: block.index,
      block: { type: "text", text: block.text },
    },
  ];
}

function closeReasoning(state) {
  if (!state.reasoning) return [];
  const block = state.reasoning;
  state.reasoning = null;
  return [
    {
      type: "block-end",
      index: block.index,
      block: { type: "reasoning", text: block.text },
    },
  ];
}

function closeTools(state) {
  const chunks = [];
  for (const block of state.toolOrder) {
    if (block.closed) continue;
    block.closed = true;
    chunks.push({
      type: "block-end",
      index: block.index,
      block: {
        type: "tool-call",
        id: block.id,
        name: block.name,
        arguments: block.arguments || "{}",
      },
    });
  }
  state.tools.clear();
  return chunks;
}

function closeAll(state) {
  return [...closeText(state), ...closeReasoning(state), ...closeTools(state)];
}

function ensureText(state) {
  const chunks = [];
  chunks.push(...closeReasoning(state));
  chunks.push(...closeTools(state));
  if (!state.text) {
    const block = { index: state.nextIndex++, text: "" };
    state.text = block;
    chunks.push({ type: "block-start", index: block.index, blockType: "text" });
  }
  return chunks;
}

function ensureReasoning(state) {
  const chunks = [];
  chunks.push(...closeText(state));
  chunks.push(...closeTools(state));
  if (!state.reasoning) {
    const block = { index: state.nextIndex++, text: "" };
    state.reasoning = block;
    chunks.push({ type: "block-start", index: block.index, blockType: "reasoning" });
  }
  return chunks;
}

function ensureTool(state, id, name) {
  const toolId = String(id || `tool-${state.toolOrder.length + 1}`);
  const chunks = [];
  let block = state.tools.get(toolId);
  if (!block) {
    chunks.push(...closeText(state));
    chunks.push(...closeReasoning(state));
    block = {
      index: state.nextIndex++,
      id: toolId,
      name: name || "",
      arguments: "",
      closed: false,
    };
    state.tools.set(toolId, block);
    state.toolOrder.push(block);
    chunks.push({ type: "block-start", index: block.index, blockType: "tool-call" });
  } else if (name && !block.name) {
    block.name = name;
  }
  return { block, chunks };
}

function toolInputText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function handleEvent(event, state) {
  const chunks = [];
  const type = String(event.type ?? "");
  if (type === "text-delta") {
    const text = typeof event.text === "string" ? event.text : "";
    if (!text) return { chunks, stop: false };
    chunks.push(...ensureText(state));
    state.text.text += text;
    state.sawContent = true;
    chunks.push({ type: "text-delta", index: state.text.index, text });
    return { chunks, stop: false };
  }
  if (type === "reasoning-delta" || type === "reasoning") {
    const text = typeof event.text === "string" ? event.text : "";
    if (!text) return { chunks, stop: false };
    chunks.push(...ensureReasoning(state));
    state.reasoning.text += text;
    state.sawContent = true;
    chunks.push({ type: "reasoning-delta", index: state.reasoning.index, text });
    return { chunks, stop: false };
  }
  if (type === "tool-input-start" || type === "tool-call") {
    const id = event.id ?? event.toolCallId ?? event.tool_call_id;
    const name = event.toolName ?? event.tool_name ?? event.name ?? "";
    const { block, chunks: opened } = ensureTool(state, id, name);
    chunks.push(...opened);
    state.sawContent = true;
    const input = toolInputText(event.input ?? event.arguments);
    if (input && !block.arguments) {
      block.arguments = input;
      chunks.push({
        type: "tool-call-delta",
        index: block.index,
        id: block.id,
        name: block.name,
        argumentsDelta: input,
      });
    }
    return { chunks, stop: false };
  }
  if (type === "tool-input-delta") {
    const id = event.id ?? event.toolCallId ?? event.tool_call_id;
    const name = event.toolName ?? event.tool_name ?? event.name ?? "";
    const { block, chunks: opened } = ensureTool(state, id, name);
    chunks.push(...opened);
    state.sawContent = true;
    const delta =
      typeof event.delta === "string"
        ? event.delta
        : typeof event.argumentsDelta === "string"
          ? event.argumentsDelta
          : "";
    if (delta) {
      block.arguments += delta;
      chunks.push({
        type: "tool-call-delta",
        index: block.index,
        id: block.id,
        name: block.name,
        argumentsDelta: delta,
      });
    }
    return { chunks, stop: false };
  }
  if (type === "finish-step") {
    const usage = alphaUsage(event.totalUsage ?? event.usage ?? event.total_usage);
    if (usage) state.usage = usage;
    if (state.finishReason === null) {
      state.finishReason =
        event.finishReason ?? event.finish_reason ?? event.reason ?? null;
    }
    return { chunks, stop: false };
  }
  if (type === "finish") {
    const usage = alphaUsage(event.totalUsage ?? event.usage ?? event.total_usage);
    if (usage) state.usage = usage;
    state.finishReason = event.finishReason ?? event.finish_reason ?? event.reason ?? null;
    const reason = String(state.finishReason ?? "").toLowerCase();
    if (reason === "error") {
      state.error = {
        message:
          event.error?.message ?? event.message ?? "Command Code reported an error finish",
        code: event.error?.code ?? event.code ?? "PROVIDER_ERROR",
      };
    }
    state.finished = true;
    return { chunks, stop: true };
  }
  if (type === "error") {
    state.error = {
      message:
        event.error?.message ?? event.message ?? "Command Code reported a stream error",
      code: event.error?.code ?? event.code ?? "PROVIDER_ERROR",
    };
    state.finished = true;
    return { chunks, stop: true };
  }
  if (type === "done") return { chunks, stop: true };
  return { chunks, stop: false };
}

function finishReason(state) {
  if (state.error) {
    return {
      kind: "error",
      failure: {
        message: String(state.error.message || "Command Code stream failed"),
        code: state.error.code || "PROVIDER_ERROR",
      },
    };
  }
  if (!state.sawContent) {
    return {
      kind: "error",
      failure: {
        message: "Command Code returned an empty response",
        code: "EMPTY_RESPONSE",
      },
    };
  }
  const raw = String(state.finishReason ?? "").toLowerCase();
  if (raw === "aborted") return { kind: "aborted" };
  if (["length", "max_tokens", "max-tokens"].includes(raw)) return { kind: "max-tokens" };
  if (raw.startsWith("tool")) return { kind: "tool-calls" };
  return { kind: "stop" };
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * POST an envelope and translate its NDJSON response into DSH chunks.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export async function* streamAlpha({
  url,
  headers,
  body,
  signal,
  timeoutMs = 300000,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    throw alphaFailure("Command Code request was aborted", "ABORTED");
  }
  signal?.addEventListener("abort", abort, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  let reader;
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw alphaFailure(`Command Code request timed out after ${timeoutMs} ms`, "TIMEOUT");
      }
      if (signal?.aborted) {
        throw alphaFailure("Command Code request was aborted", "ABORTED");
      }
      throw alphaFailure(
        `Command Code request failed: ${error instanceof Error ? error.message : String(error)}`,
        "TRANSPORT",
      );
    }

    if (response.ok === false) {
      let text = "";
      try {
        text = truncate(await response.text(), 800);
      } catch {
        text = "";
      }
      const status = Number(response.status) || 0;
      const detail = text || response.statusText || "request failed";
      throw alphaFailure(
        `Command Code API ${status || "error"}: ${detail}`,
        classifyAlphaError(text, status),
        { status: status || undefined },
      );
    }
    if (!response.body) {
      throw alphaFailure(
        "alpha transport ended without a finish event (stream closed early)",
        "STREAM_CLOSED",
      );
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = {
      text: null,
      reasoning: null,
      tools: new Map(),
      toolOrder: [],
      nextIndex: 0,
      sawContent: false,
      usage: null,
      finishReason: null,
      error: null,
      finished: false,
    };
    let buffer = "";
    let stopped = false;

    const processLine = (line) => {
      const event = parseAlphaEvent(line);
      if (!event) return { chunks: [], stop: false };
      return handleEvent(event, state);
    };

    while (true) {
      let read;
      try {
        read = await reader.read();
      } catch (error) {
        if (timedOut) {
          throw alphaFailure(
            `Command Code request timed out after ${timeoutMs} ms`,
            "TIMEOUT",
          );
        }
        if (signal?.aborted) {
          throw alphaFailure("Command Code request was aborted", "ABORTED");
        }
        throw alphaFailure(
          `Command Code stream failed: ${error instanceof Error ? error.message : String(error)}`,
          "TRANSPORT",
        );
      }
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const result = processLine(line);
        for (const chunk of result.chunks) yield chunk;
        if (result.stop) {
          stopped = true;
          break;
        }
      }
      if (stopped || state.finished) break;
    }

    if (!state.finished) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const result = processLine(buffer);
        for (const chunk of result.chunks) yield chunk;
        if (result.stop) stopped = true;
      }
    }

    if (!state.finished) {
      throw alphaFailure(
        "alpha transport ended without a finish event (stream closed early)",
        "STREAM_CLOSED",
      );
    }

    for (const chunk of closeAll(state)) yield chunk;
    if (state.usage) yield { type: "usage", usage: state.usage };
    yield { type: "finish", reason: finishReason(state) };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed.
      }
    }
  }
}
