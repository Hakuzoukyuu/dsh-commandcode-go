/**
 * Command Code account/usage fetcher for the floating usage widget.
 *
 * The official CLI reads the same four alpha endpoints; this module mirrors
 * that read-only traffic (no prompt content, no generate calls).  It is kept
 * free of DSH imports and of Node-only APIs beyond `fetch`, so the projection
 * stays unit-testable with a stub transport.
 */

import { resolveApiKey } from "./adapter.js";

export const USAGE_PATH = "/dsh-commandcode-go/usage";

export const USAGE_ENDPOINTS = Object.freeze({
  whoami: "/alpha/whoami?limits=1",
  credits: "/alpha/billing/credits",
  subscriptions: "/alpha/billing/subscriptions",
  summary: "/alpha/usage/summary",
});

/** Plan ids the CLI knows about, mapped to display name and monthly credits. */
const PLAN_TABLE = [
  ["individual-go", { name: "Go", monthlyCredits: 10 }],
  ["individual-goat", { name: "GOAT", monthlyCredits: 70 }],
  ["individual-pro-v1", { name: "Pro", monthlyCredits: 80 }],
  ["individual-pro", { name: "Pro", monthlyCredits: 30 }],
  ["individual-provider", { name: "Provider", monthlyCredits: 15 }],
  ["individual-max", { name: "Max", monthlyCredits: 150 }],
  ["individual-ultra", { name: "Ultra", monthlyCredits: 300 }],
  ["teams-pro", { name: "Teams Pro", monthlyCredits: 40 }],
].sort((a, b) => b[0].length - a[0].length);

const AUTH_CODES = new Set(["AUTH"]);
const STALE_CODES = new Set(["AUTH", "UNREACHABLE", "TIMEOUT", "HTTP", "UNKNOWN"]);

export class UsageError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "UsageError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function usageFailure(code, message, status) {
  return new UsageError(code, message, status);
}

export function isAuthFailure(error) {
  return AUTH_CODES.has(error?.code);
}

function asFinite(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function max0(value) {
  return Math.max(0, asFinite(value));
}

/** Resolve a plan id like `individual-go-v1` to its prefix entry. */
export function planInfo(planId) {
  if (typeof planId !== "string" || !planId) return null;
  const normalized = planId.toLowerCase().replace(/_/g, "-");
  for (const [prefix, info] of PLAN_TABLE) {
    if (normalized.startsWith(prefix)) return { id: planId, ...info };
  }
  return null;
}

function apiOrigin(config) {
  const base = typeof config?.baseURL === "string" ? config.baseURL : "";
  try {
    return new URL(base || "https://api.commandcode.ai/provider/v1").origin;
  } catch {
    return "https://api.commandcode.ai";
  }
}

async function readJson(fetchImpl, url, apiKey, alphaVersion) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "x-command-code-version": alphaVersion,
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw usageFailure(
      timedOut ? "TIMEOUT" : "UNREACHABLE",
      timedOut
        ? "Command Code 用量接口超时，稍后重试。"
        : `无法连接 Command Code：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      (body && typeof body.message === "string" && body.message) ||
      (body && typeof body.error === "string" && body.error) ||
      `Command Code 返回 HTTP ${response.status}`;
    const code =
      response.status === 401 || response.status === 403
        ? "AUTH"
        : response.status === 429
          ? "RATE_LIMIT"
          : "HTTP";
    throw usageFailure(code, message, response.status);
  }
  if (!body || typeof body !== "object") {
    throw usageFailure("BAD_RESPONSE", "Command Code 用量接口返回了无法解析的内容。");
  }
  return body;
}

/**
 * Fetch the account, credits, subscription and period summary.
 * Throws `UsageError`; callers turn it into the widget's error payload.
 */
export async function fetchUsage({ config, fetchImpl = fetch, logger } = {}) {
  if (typeof fetchImpl !== "function") throw usageFailure("UNKNOWN", "缺少 fetch 实现。");
  let apiKey;
  try {
    apiKey = resolveApiKey(config ?? {});
  } catch (error) {
    throw usageFailure("AUTH", error instanceof Error ? error.message : "未配置 Command Code API key。");
  }

  const origin = apiOrigin(config);
  const alphaVersion = config?.alphaVersion || "1.88.3";
  const get = (path) => readJson(fetchImpl, `${origin}${path}`, apiKey, alphaVersion);

  const whoami = await get(USAGE_ENDPOINTS.whoami);
  const orgId = typeof whoami?.org?.id === "string" && whoami.org.id ? whoami.org.id : null;
  const suffix = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

  const [credits, subscription] = await Promise.all([
    get(`${USAGE_ENDPOINTS.credits}${suffix}`),
    get(`${USAGE_ENDPOINTS.subscriptions}${suffix}`),
  ]);

  const periodStart = subscription?.data?.currentPeriodStart;
  const summaryPath =
    typeof periodStart === "string" && periodStart
      ? `${USAGE_ENDPOINTS.summary}?since=${encodeURIComponent(periodStart)}`
      : USAGE_ENDPOINTS.summary;
  let summary = null;
  try {
    summary = await get(summaryPath);
  } catch (error) {
    // The summary is supporting detail; credits and windows still render.
    logger?.debug?.("commandcode-go: usage summary unavailable (%s)", error?.message);
  }

  return { whoami, credits, subscription, summary };
}

function projectWindow(window, now) {
  if (!window || typeof window !== "object") return null;
  const used = max0(window.used);
  const cap = max0(window.cap);
  const resetAtValue = Number(window.resetAt);
  const resetAt = Number.isFinite(resetAtValue) && resetAtValue > 0 ? resetAtValue : null;
  return {
    used,
    cap,
    exceeded: window.exceeded === true,
    percent: cap > 0 ? Math.min(100, (used / cap) * 100) : 0,
    resetAt,
    resetInMs: resetAt === null ? null : Math.max(0, resetAt - now),
  };
}

function daysUntil(iso, now) {
  if (typeof iso !== "string") return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 86400000));
}

/**
 * Fold the raw alpha payloads into the compact view the widget renders.
 * Pure function: same input and `now` always produce the same output.
 */
export function projectUsage(raw, { now = Date.now(), studioOrigin = "https://commandcode.ai" } = {}) {
  const whoami = raw?.whoami ?? null;
  const creditsBody = raw?.credits ?? null;
  const subscription = raw?.subscription?.data ?? null;
  const summary = raw?.summary ?? null;

  const plan = planInfo(subscription?.planId ?? null);
  const credit = creditsBody?.credits ?? {};
  const monthlyRemaining = max0(credit.monthlyCredits);
  const purchasedRemaining = max0(credit.purchasedCredits);
  const freeRemaining = max0(credit.freeCredits);
  const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;
  const totalSpent = max0(summary?.totalCost);

  const activePlanCredits =
    subscription?.status === "active" && plan ? plan.monthlyCredits : null;
  const totalPool =
    activePlanCredits !== null
      ? Math.max(activePlanCredits, monthlyRemaining) + purchasedRemaining + freeRemaining
      : totalSpent + totalRemaining;
  const used = Math.max(0, totalPool - totalRemaining);
  const usagePercent = totalPool > 0 ? Math.min(100, (used / totalPool) * 100) : 0;

  const userName =
    (typeof whoami?.org?.login === "string" && whoami.org.login) ||
    (typeof whoami?.user?.userName === "string" && whoami.user.userName) ||
    null;
  const encodedUser = userName ? encodeURIComponent(userName) : null;
  const billingUrl = encodedUser ? `${studioOrigin}/${encodedUser}/settings/billing` : null;
  const usageUrl = encodedUser ? `${studioOrigin}/${encodedUser}/settings/usage` : null;

  const windowLimits = creditsBody?.windowLimits ?? null;

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    account: {
      name: typeof whoami?.user?.name === "string" ? whoami.user.name : null,
      userName,
      email: typeof whoami?.user?.email === "string" ? whoami.user.email : null,
      org: typeof whoami?.org?.name === "string" ? whoami.org.name : null,
    },
    plan: plan
      ? {
          id: subscription?.planId ?? null,
          name: plan.name,
          monthlyCredits: plan.monthlyCredits,
          status: subscription?.status ?? null,
          cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd === true,
          currentPeriodStart: subscription?.currentPeriodStart ?? null,
          currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
          daysLeft: daysUntil(subscription?.currentPeriodEnd, now),
        }
      : null,
    credits: {
      monthlyRemaining,
      purchasedRemaining,
      freeRemaining,
      totalRemaining,
      totalPool,
      used,
      usagePercent,
    },
    windows: {
      limited: windowLimits?.limited === true,
      fiveHour: projectWindow(windowLimits?.fiveHour, now),
      weekly: projectWindow(windowLimits?.weekly, now),
    },
    usage: {
      totalCost: totalSpent,
      totalTokens: max0(summary?.totalTokens),
      totalTokensIn: max0(summary?.totalTokensIn),
      totalTokensOut: max0(summary?.totalTokensOut),
      requests: max0(summary?.totalCount),
      successRate: Number.isFinite(Number(summary?.successRate)) ? Number(summary.successRate) : null,
    },
    links: { billing: billingUrl, usage: usageUrl },
  };
}

function errorBody(error, now) {
  return {
    ok: false,
    generatedAt: new Date(now).toISOString(),
    error: {
      code: typeof error?.code === "string" ? error.code : "UNKNOWN",
      message: error instanceof Error ? error.message : String(error ?? "未知错误"),
    },
  };
}

/**
 * One usage request as served to the widget: fetch, project, and degrade to a
 * renderable error instead of breaking the route.
 */
export async function readUsage({
  config,
  fetchImpl = fetch,
  logger,
  now = Date.now(),
  studioOrigin,
} = {}) {
  try {
    const raw = await fetchUsage({ config, fetchImpl, logger });
    return projectUsage(raw, { now, ...(studioOrigin ? { studioOrigin } : {}) });
  } catch (error) {
    return errorBody(error, now);
  }
}

/** Whether a failed view is worth caching for a while (auth/config problems). */
export function isStaleError(view) {
  return view?.ok === false && STALE_CODES.has(view?.error?.code);
}
