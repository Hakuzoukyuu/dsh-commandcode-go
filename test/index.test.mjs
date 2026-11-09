import test from "node:test";
import assert from "node:assert/strict";

import plugin, { Config, inject, name } from "../lib/index.js";
import { ROUTE } from "../lib/config.js";

function fakeContext(liveConfig, options = {}) {
  const state = { routes: undefined, adapter: undefined, route: undefined, injected: undefined, effects: [] };
  const ctx = {
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    settings: {
      describe: () => [{ ns: name, value: liveConfig }],
    },
    llm: {
      registerAdapter(routes, adapter) {
        state.routes = routes;
        state.adapter = adapter;
        return { replace() {}, dispose() {} };
      },
    },
    get: () => undefined,
    inject(deps, callback) {
      state.injected = deps;
      if (!options.web) return;
      callback({
        effect(register, label) {
          state.effects.push(label);
          register();
        },
        webServer: {
          register(route) {
            state.route = route;
            return { dispose() {} };
          },
        },
      });
    },
  };
  return { ctx, state };
}

test("plugin entry exposes the expected loader contract", () => {
  assert.equal(plugin.name, name);
  assert.deepEqual(plugin.inject, ["llm", "settings"]);
  assert.equal(inject, plugin.inject);
  assert.equal(typeof Config, "function");
  assert.equal(Config.type, "object");
});

test("apply registers the Command Code Go route and adapter", () => {
  const { ctx, state } = fakeContext({
    apiKey: "user_live",
    plan: "individual-go",
  });
  plugin.apply(ctx, {});
  assert.deepEqual(state.routes, [ROUTE]);
  assert.equal(state.adapter.providerInfo(ROUTE).name, "Command Code Go");
  assert.equal(typeof state.adapter.prepareCall, "function");
  assert.equal(typeof state.adapter.imageRequestTarget, "function");
});

test("live settings are read back through Settings.describe()", async () => {
  const { ctx, state } = fakeContext({ apiKey: "user_live", retries: 1 });
  plugin.apply(ctx, { retries: 9 });
  assert.equal(state.adapter.providerRetryPolicy().maxRetries, 1);
});

test("apply rejects an invalid initial config", () => {
  const { ctx } = fakeContext(undefined);
  assert.throws(() => plugin.apply(ctx, { models: [1] }), /models must be an array/);
});

test("apply registers the usage route for the Web carrier", async () => {
  const { ctx, state } = fakeContext(
    { apiKey: "user_test", usageWidget: true, usageRefreshSeconds: 45 },
    { web: true },
  );
  plugin.apply(ctx, {});
  assert.deepEqual(state.injected, ["webServer"]);
  assert.equal(state.route.kind, "exact");
  assert.equal(state.route.path, "/dsh-commandcode-go/usage");
  assert.equal(state.effects.length, 1);
  assert.match(state.effects[0], /usage endpoint/);

  const payloads = {
    "/alpha/whoami": {
      success: true,
      user: { userName: "exblowa4k5" },
      org: null,
    },
    "/alpha/billing/credits": {
      credits: { monthlyCredits: 9.5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 3, exceeded: false, resetAt: 1794128826142 },
        weekly: { used: 1, cap: 6, exceeded: false, resetAt: 1794689090588 },
      },
    },
    "/alpha/billing/subscriptions": {
      data: {
        status: "active",
        planId: "individual-go-v1",
        currentPeriodStart: "2026-11-07T14:15:18.000Z",
        currentPeriodEnd: "2026-12-07T14:15:18.000Z",
      },
    },
    "/alpha/usage/summary": { totalCount: 3, totalCost: 0.5, totalTokens: 1200 },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(JSON.stringify(payloads[new URL(String(url)).pathname]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const response = await state.route.resource(
      new Request("http://localhost/dsh-commandcode-go/usage"),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.widgetEnabled, true);
    assert.equal(body.refreshSeconds, 45);
    assert.equal(body.credits.totalRemaining, 9.5);
    assert.equal(body.links.billing, "https://commandcode.ai/exblowa4k5/settings/billing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usage route keeps reporting the widget switch when it fails", async () => {
  const { ctx, state } = fakeContext(
    { apiKeyEnv: "CC_TEST_UNSET_KEY", usageWidget: false },
    { web: true },
  );
  const previous = process.env.COMMANDCODE_AUTH_FILE;
  process.env.COMMANDCODE_AUTH_FILE = "/nonexistent/commandcode-auth.json";
  try {
    plugin.apply(ctx, {});
    const response = await state.route.resource(
      new Request("http://localhost/dsh-commandcode-go/usage"),
    );
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.widgetEnabled, false);
    assert.equal(body.refreshSeconds, 60);
    assert.equal(body.error.code, "AUTH");
  } finally {
    if (previous === undefined) delete process.env.COMMANDCODE_AUTH_FILE;
    else process.env.COMMANDCODE_AUTH_FILE = previous;
  }
});
