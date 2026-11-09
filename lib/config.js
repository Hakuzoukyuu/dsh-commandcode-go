/**
 * Configuration schema for dsh-commandcode-go.
 *
 * DSH is deliberately not a runtime dependency of this plugin: the plugin has
 * to load from any profile, including profiles whose node_modules do not
 * contain the `@deepseek-ai/*` packages.  The settings service only needs a
 * Standard Schema validator plus a Schemastery-shaped `toJSON()` tree, so the
 * schema below is hand-written.  The root is volatile, which makes every field
 * editable in the auto-generated Settings page.
 */

export const ROUTE = "commandcode-go";
export const NAMESPACE = "dsh-commandcode-go";

export const PLANS = [
  "individual-go",
  "individual-goat",
  "individual-pro",
  "individual-provider",
  "individual-max",
  "all",
];

export const DEFAULTS = Object.freeze({
  apiKey: "",
  apiKeyEnv: "CMD_API_KEY",
  baseURL: "https://api.commandcode.ai/provider/v1",
  alphaVersion: "1.88.3",
  plan: "individual-go",
  models: [],
  defaultMaxTokens: 32768,
  defaultContextWindow: 262144,
  streamTimeoutMs: 300000,
  retries: 3,
  usageWidget: true,
  usageRefreshSeconds: 60,
});

const NUMBER_FIELDS = {
  defaultMaxTokens: [1024, 131072],
  defaultContextWindow: [1024, 100000000],
  streamTimeoutMs: [1000, 3600000],
  retries: [0, 10],
  usageRefreshSeconds: [15, 3600],
};

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(message, path) {
  return { message, path };
}

function asString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value.trim() : undefined;
}

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

function normalizeModels(value) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    return [...new Set(value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
  }
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const id = item.trim();
    if (id) out.push(id);
  }
  return [...new Set(out)];
}

/**
 * Validate and fill defaults.  This is also the callable shape consumed by
 * DSH's loader (`Config(value)`), and `Config["~standard"].validate` is used
 * by the settings service.
 */
export function normalizeConfig(input) {
  if (input === undefined || input === null) input = {};
  if (!isObject(input)) throw new Error("Command Code Go config must be an object");

  const issues = [];
  const value = {};

  value.apiKey = asString(input.apiKey, DEFAULTS.apiKey);
  if (value.apiKey === undefined) issues.push(bad("apiKey must be a string", ["apiKey"]));

  value.apiKeyEnv = asString(input.apiKeyEnv, DEFAULTS.apiKeyEnv);
  if (!value.apiKeyEnv) value.apiKeyEnv = DEFAULTS.apiKeyEnv;

  value.baseURL = asString(input.baseURL, DEFAULTS.baseURL) || DEFAULTS.baseURL;
  try {
    const url = new URL(value.baseURL);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
  } catch {
    issues.push(bad("baseURL must be an absolute http(s) URL", ["baseURL"]));
  }

  value.alphaVersion = asString(input.alphaVersion, DEFAULTS.alphaVersion) || DEFAULTS.alphaVersion;

  const usageWidget = asBoolean(input.usageWidget, DEFAULTS.usageWidget);
  if (usageWidget === undefined) issues.push(bad("usageWidget must be a boolean", ["usageWidget"]));
  else value.usageWidget = usageWidget;

  value.plan = asString(input.plan, DEFAULTS.plan) || DEFAULTS.plan;
  if (!PLANS.includes(value.plan)) {
    issues.push(bad(`plan must be one of ${PLANS.join(", ")}`, ["plan"]));
  }

  const models = normalizeModels(input.models);
  if (models === undefined) issues.push(bad("models must be an array of model ids", ["models"]));
  else value.models = models;

  for (const [field, [min, max]] of Object.entries(NUMBER_FIELDS)) {
    const n = asInteger(input[field], DEFAULTS[field]);
    if (n === undefined) {
      issues.push(bad(`${field} must be an integer`, [field]));
      continue;
    }
    if (n < min || n > max) {
      issues.push(bad(`${field} must be between ${min} and ${max}`, [field]));
      continue;
    }
    value[field] = n;
  }

  if (issues.length > 0) {
    const error = new Error(issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    error.issues = issues;
    throw error;
  }
  return value;
}

const SCHEMA = {
  uid: 12,
  refs: {
    1: {
      type: "string",
      meta: {
        role: "secret",
        description: "Command Code API key (starts with user_). Stored in the DSH profile patch.",
      },
    },
    2: {
      type: "string",
      meta: {
        default: DEFAULTS.apiKeyEnv,
        description: "Environment variable used when the API key field is empty.",
      },
    },
    3: {
      type: "string",
      meta: {
        default: DEFAULTS.baseURL,
        description: "Provider base URL. Only its origin is used for the alpha endpoint.",
      },
    },
    4: {
      type: "string",
      meta: {
        default: DEFAULTS.alphaVersion,
        description: "Value sent as x-command-code-version.",
      },
    },
    5: {
      type: "string",
      meta: {
        default: DEFAULTS.plan,
        description: `Plan filter: ${PLANS.join(", ")}.`,
      },
    },
    6: {
      type: "array",
      meta: {
        default: [],
        description: "Optional explicit model id list and order. Empty means the live catalog.",
      },
      inner: 7,
    },
    7: { type: "string", meta: {} },
    8: {
      type: "number",
      meta: { default: DEFAULTS.defaultMaxTokens, description: "Preferred output token cap." },
    },
    9: {
      type: "number",
      meta: { default: DEFAULTS.defaultContextWindow, description: "Fallback context window." },
    },
    10: {
      type: "number",
      meta: { default: DEFAULTS.streamTimeoutMs, description: "Alpha stream timeout in milliseconds." },
    },
    11: {
      type: "number",
      meta: { default: DEFAULTS.retries, description: "Retries DSH may perform for retryable failures." },
    },
    13: {
      type: "boolean",
      meta: {
        default: DEFAULTS.usageWidget,
        description: "Show the movable Command Code usage window in the Web UI.",
      },
    },
    14: {
      type: "number",
      meta: {
        default: DEFAULTS.usageRefreshSeconds,
        description: "Usage window refresh interval in seconds.",
      },
    },
    12: {
      type: "object",
      meta: { default: {}, volatile: true },
      dict: {
        apiKey: 1,
        apiKeyEnv: 2,
        baseURL: 3,
        alphaVersion: 4,
        plan: 5,
        models: 6,
        defaultMaxTokens: 8,
        defaultContextWindow: 9,
        streamTimeoutMs: 10,
        retries: 11,
        usageWidget: 13,
        usageRefreshSeconds: 14,
      },
    },
  },
};

export function Config(input) {
  return normalizeConfig(input);
}

Config.type = "object";
Config.meta = {
  default: {},
  volatile: true,
  description: "Command Code Go alpha transport",
};
Config.toJSON = () => structuredClone(SCHEMA);
Config["~standard"] = {
  version: 1,
  vendor: "dsh-commandcode-go",
  validate(value) {
    try {
      return { value: normalizeConfig(value) };
    } catch (error) {
      return {
        issues: Array.isArray(error?.issues)
          ? error.issues
          : [{ message: error instanceof Error ? error.message : String(error), path: [] }],
      };
    }
  },
};
