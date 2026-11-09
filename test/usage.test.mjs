import test from "node:test";
import assert from "node:assert/strict";

import {
  UsageError,
  fetchUsage,
  planInfo,
  projectUsage,
  readUsage,
} from "../lib/usage.js";

const WHOAMI = {
  success: true,
  user: { id: "u1", name: "Mo", email: "mo@example.com", userName: "exblowa4k5" },
  org: null,
};

const CREDITS = {
  credits: {
    monthlyCredits: 9.886072866,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.1121208, cap: 3, exceeded: false, resetAt: 1794128826142 },
    weekly: { used: 0.113927134, cap: 6, exceeded: false, resetAt: 1794689090588 },
  },
  sandboxAccess: false,
};

const SUBSCRIPTION = {
  success: true,
  data: {
    status: "active",
    planId: "individual-go-v1",
    currentPeriodStart: "2026-11-07T14:15:18.000Z",
    currentPeriodEnd: "2026-12-07T14:15:18.000Z",
    cancelAtPeriodEnd: true,
  },
};

const SUMMARY = {
  totalCount: 55,
  totalCost: 0.1204,
  totalTokens: 3501145,
  totalTokensIn: 3000000,
  totalTokensOut: 501145,
  successRate: 0.98,
  periodStart: "2026-11-07T14:15:18.000Z",
  daily: [],
};

function stubFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init });
    const table = {
      "/alpha/whoami": WHOAMI,
      "/alpha/billing/credits": CREDITS,
      "/alpha/billing/subscriptions": SUBSCRIPTION,
      "/alpha/usage/summary": SUMMARY,
      ...overrides,
    };
    const body = table[parsed.pathname];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

test("planInfo matches the CLI plan prefixes", () => {
  assert.deepEqual(planInfo("individual-go-v1"), {
    id: "individual-go-v1",
    name: "Go",
    monthlyCredits: 10,
  });
  assert.equal(planInfo("individual-goat")?.name, "GOAT");
  assert.equal(planInfo("individual-pro-v1")?.monthlyCredits, 80);
  assert.equal(planInfo("individual-provider")?.name, "Provider");
  assert.equal(planInfo("teams-pro")?.monthlyCredits, 40);
  assert.equal(planInfo("unknown-plan"), null);
  assert.equal(planInfo(undefined), null);
});

test("projectUsage folds credits, windows and period summary", () => {
  const now = Date.parse("2026-11-08T04:00:00.000Z");
  const view = projectUsage(
    { whoami: WHOAMI, credits: CREDITS, subscription: SUBSCRIPTION, summary: SUMMARY },
    { now },
  );

  assert.equal(view.ok, true);
  assert.equal(view.account.userName, "exblowa4k5");
  assert.equal(view.plan.name, "Go");
  assert.equal(view.plan.monthlyCredits, 10);
  assert.equal(view.plan.cancelAtPeriodEnd, true);
  assert.equal(view.plan.daysLeft, 30);

  assert.equal(view.credits.totalRemaining, 9.886072866);
  assert.equal(view.credits.totalPool, 10);
  assert.ok(Math.abs(view.credits.used - 0.113927134) < 1e-9);
  assert.ok(Math.abs(view.credits.usagePercent - 1.13927134) < 1e-6);

  assert.equal(view.windows.limited, true);
  assert.equal(view.windows.fiveHour.cap, 3);
  assert.equal(view.windows.weekly.used, 0.113927134);
  assert.equal(view.windows.fiveHour.resetInMs, 1794128826142 - now);

  assert.equal(view.usage.requests, 55);
  assert.equal(view.usage.totalTokens, 3501145);
  assert.equal(
    view.links.billing,
    "https://commandcode.ai/exblowa4k5/settings/billing",
  );
  assert.equal(view.links.usage, "https://commandcode.ai/exblowa4k5/settings/usage");
});

test("a reset window with resetAt 0 reports no countdown", () => {
  const view = projectUsage(
    {
      whoami: WHOAMI,
      credits: {
        credits: CREDITS.credits,
        windowLimits: {
          limited: true,
          fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
          weekly: { used: 0.5, cap: 6, exceeded: false, resetAt: 1794689090588 },
        },
      },
      subscription: SUBSCRIPTION,
      summary: SUMMARY,
    },
    { now: Date.parse("2026-11-08T04:00:00.000Z") },
  );
  assert.equal(view.windows.fiveHour.resetAt, null);
  assert.equal(view.windows.fiveHour.resetInMs, null);
  assert.equal(view.windows.weekly.resetAt, 1794689090588);
});

test("projectUsage falls back to spend + remaining without an active plan", () => {
  const view = projectUsage(
    {
      whoami: WHOAMI,
      credits: CREDITS,
      subscription: { data: { status: "canceled", planId: "individual-go-v1" } },
      summary: SUMMARY,
    },
    { now: Date.parse("2026-11-08T04:00:00.000Z") },
  );
  assert.equal(view.plan.status, "canceled");
  assert.ok(Math.abs(view.credits.totalPool - (0.1204 + 9.886072866)) < 1e-9);
  assert.equal(view.plan.daysLeft, null);
});

test("fetchUsage calls the alpha endpoints with the resolved key", async () => {
  const { impl, calls } = stubFetch();
  const raw = await fetchUsage({
    config: { apiKey: "user_test", alphaVersion: "1.88.5" },
    fetchImpl: impl,
  });

  assert.equal(raw.whoami.user.userName, "exblowa4k5");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url.pathname, "/alpha/whoami");
  assert.equal(calls[0].init.headers.authorization, "Bearer user_test");
  assert.equal(calls[0].init.headers["x-command-code-version"], "1.88.5");
  assert.equal(
    calls[3].url.searchParams.get("since"),
    "2026-11-07T14:15:18.000Z",
  );
});

test("fetchUsage scopes billing calls to the org when whoami returns one", async () => {
  const { impl, calls } = stubFetch({
    "/alpha/whoami": { ...WHOAMI, org: { id: "org_123", name: "Acme", login: "acme" } },
  });
  await fetchUsage({ config: { apiKey: "user_test" }, fetchImpl: impl });
  const creditsCall = calls.find((call) => call.url.pathname === "/alpha/billing/credits");
  assert.equal(creditsCall.url.searchParams.get("orgId"), "org_123");
});

test("fetchUsage tolerates a missing usage summary", async () => {
  const { impl } = stubFetch({ "/alpha/usage/summary": undefined });
  const raw = await fetchUsage({ config: { apiKey: "user_test" }, fetchImpl: impl });
  assert.equal(raw.summary, null);
  assert.equal(raw.credits.credits.monthlyCredits, 9.886072866);
});

test("readUsage turns a missing key into a renderable auth error", async () => {
  const previous = process.env.COMMANDCODE_AUTH_FILE;
  process.env.COMMANDCODE_AUTH_FILE = "/nonexistent/commandcode-auth.json";
  try {
    const view = await readUsage({
      config: { apiKeyEnv: "CC_TEST_UNSET_KEY" },
      fetchImpl: async () => {
        throw new Error("should not be called");
      },
    });
    assert.equal(view.ok, false);
    assert.equal(view.error.code, "AUTH");
  } finally {
    if (previous === undefined) delete process.env.COMMANDCODE_AUTH_FILE;
    else process.env.COMMANDCODE_AUTH_FILE = previous;
  }
});

test("readUsage maps a 401 to AUTH and a 429 to RATE_LIMIT", async () => {
  const unauthorized = await readUsage({
    config: { apiKey: "bad" },
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "invalid token" }), { status: 401 }),
  });
  assert.equal(unauthorized.error.code, "AUTH");
  assert.match(unauthorized.error.message, /invalid token/);

  const limited = await readUsage({
    config: { apiKey: "bad" },
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "slow down" }), { status: 429 }),
  });
  assert.equal(limited.error.code, "RATE_LIMIT");
});

test("UsageError carries a code and status", () => {
  const error = new UsageError("AUTH", "nope", 401);
  assert.equal(error.code, "AUTH");
  assert.equal(error.status, 401);
  assert.ok(error instanceof Error);
});
