/**
 * Live Command Code model catalog.
 *
 * The catalog endpoint is public and does not need a subscription key.  The
 * plugin uses it for model names, context windows, image support, reasoning
 * efforts and minimum-plan gating.  A small static list keeps the provider
 * usable while offline.
 */

import { DEFAULT_USER_AGENT } from "./alpha.js";

export const PLAN_RANK = Object.freeze({
  "individual-go": 1,
  "individual-goat": 2,
  "individual-pro": 3,
  "individual-provider": 4,
  "individual-max": 5,
});

export const CATALOG_TTL_MS = 10 * 60 * 1000;
export const CATALOG_FAILURE_TTL_MS = 30 * 1000;

export const FALLBACK_MODELS = [
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    context_length: 1050000,
    inputModalities: ["text", "image"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    display: { order: 1 },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    context_length: 1000000,
    inputModalities: ["text"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["off", "low", "high", "max"],
    display: { order: 2 },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    context_length: 1000000,
    inputModalities: ["text"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["off", "low", "high", "max"],
    display: { order: 3 },
  },
  {
    id: "moonshotai/Kimi-K3",
    name: "Kimi K3",
    context_length: 1000000,
    inputModalities: ["text", "image"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["low", "high", "max"],
    display: { order: 4 },
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3 Flash",
    context_length: 1048576,
    maxOutputTokens: 131072,
    inputModalities: ["text", "image"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["off", "low", "high", "max"],
    display: { order: 5 },
  },
  {
    id: "Qwen/Qwen3.8-Max",
    name: "Qwen3.8 Max",
    context_length: 1000000,
    inputModalities: ["text", "image"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["low", "medium", "high"],
    display: { order: 6 },
  },
];

const EFFORT_LABELS = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function positive(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function modelName(raw) {
  const label = raw.display?.label;
  if (typeof label === "string" && label.trim()) return label.trim();
  if (typeof raw.name === "string" && raw.name.trim()) return raw.name.trim();
  return String(raw.id);
}

export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter((alias) => typeof alias === "string" && alias.trim()).map((a) => a.trim())
    : [];
  const modalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.filter((m) => typeof m === "string")
    : ["text"];
  const efforts = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.reasoningEfforts) ? raw.reasoningEfforts : []) {
    const effortId =
      typeof item === "string" ? item : typeof item?.id === "string" ? item.id : "";
    if (!effortId || seen.has(effortId)) continue;
    seen.add(effortId);
    efforts.push({
      id: effortId,
      name:
        (typeof item === "object" && typeof item.name === "string" && item.name) ||
        EFFORT_LABELS[effortId] ||
        effortId,
    });
  }
  return {
    id,
    name: modelName(raw),
    aliases,
    description:
      typeof raw.display?.description === "string" ? raw.display.description : undefined,
    category: typeof raw.category === "string" ? raw.category : undefined,
    context_length: positive(raw.context_length ?? raw.contextLength, 262144),
    maxOutputTokens: positive(raw.maxOutputTokens ?? raw.max_output_tokens, null),
    inputModalities: modalities.length > 0 ? modalities : ["text"],
    minimumPlan:
      typeof raw.minimumPlan === "string" && raw.minimumPlan
        ? raw.minimumPlan
        : "individual-go",
    reasoningEfforts: efforts,
    displayOrder: positive(raw.display?.order, 9999),
    raw,
  };
}

export function normalizeCatalog(payload) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data)) throw new Error("Command Code catalog response has no data array");
  const models = [];
  for (const item of data) {
    const model = normalizeModel(item);
    if (model) models.push(model);
  }
  if (models.length === 0) throw new Error("Command Code catalog is empty");
  return {
    version:
      typeof payload?.catalogVersion === "string"
        ? payload.catalogVersion
        : typeof payload?.catalogVersion === "number"
          ? String(payload.catalogVersion)
          : null,
    models,
  };
}

export function planAllows(model, plan) {
  if (plan === "all") return true;
  const rank = PLAN_RANK[plan] ?? PLAN_RANK["individual-go"];
  return (PLAN_RANK[model.minimumPlan] ?? 99) <= rank;
}

function unknownModel(id) {
  return normalizeModel({
    id,
    name: id,
    context_length: 262144,
    inputModalities: ["text", "image"],
    minimumPlan: "individual-go",
    reasoningEfforts: [],
  });
}

function sortModels(models) {
  return [...models].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name),
  );
}

export function createCatalog({ getConfig, logger, fetchImpl = fetch } = {}) {
  let models = [];
  let version = null;
  let loadedAt = 0;
  let failedAt = 0;
  let inflight = null;

  function installFallback() {
    if (models.length > 0) return;
    models = FALLBACK_MODELS.map(normalizeModel).filter(Boolean);
    version = "fallback";
  }

  function ensureFallback() {
    if (models.length === 0) installFallback();
  }

  async function fetchRemote(config, signal) {
    const origin = new URL(config.baseURL).origin;
    const url = `${origin}/provider/v1/models?view=client`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8000);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": DEFAULT_USER_AGENT,
        },
        signal: controller.signal,
      });
      if (response.ok === false) {
        throw new Error(`catalog request returned HTTP ${response.status}`);
      }
      return normalizeCatalog(await response.json());
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timedOut) throw new Error("catalog request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function load({ force = false, signal } = {}) {
    if (!force && models.length > 0 && Date.now() - loadedAt < CATALOG_TTL_MS) {
      return { version, models };
    }
    if (!force && failedAt > 0 && Date.now() - failedAt < CATALOG_FAILURE_TTL_MS) {
      ensureFallback();
      return { version, models };
    }
    if (inflight) return inflight;

    inflight = (async () => {
      const config = getConfig();
      try {
        const result = await fetchRemote(config, signal);
        models = result.models;
        version = result.version;
        loadedAt = Date.now();
        failedAt = 0;
      } catch (error) {
        failedAt = Date.now();
        ensureFallback();
        logger?.warn?.(
          "commandcode-go: could not refresh the model catalog; using the built-in list (%s)",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        inflight = null;
      }
      return { version, models };
    })();
    return inflight;
  }

  function find(id) {
    const needle = String(id);
    return (
      models.find((model) => model.id === needle) ??
      models.find((model) => model.aliases.includes(needle)) ??
      null
    );
  }

  async function lookup(id, { signal } = {}) {
    await load({ signal });
    return find(id);
  }

  async function list({ plan = "individual-go", ids = [], signal } = {}) {
    await load({ signal });
    if (ids.length > 0) {
      return ids.map((id) => find(id) ?? unknownModel(id));
    }
    return sortModels(models.filter((model) => planAllows(model, plan)));
  }

  return {
    load,
    lookup,
    list,
    version: () => version,
    fallback: () => {
      if (models.length === 0) installFallback();
      return models;
    },
  };
}
