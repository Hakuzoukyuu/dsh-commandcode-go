import test from "node:test";
import assert from "node:assert/strict";

/**
 * Smoke-renders the browser bundle with a tiny React stand-in. This catches
 * render-path typos and slot wiring without a browser; the real visual check
 * happens in the running Web GUI after a Host restart.
 */

function fakeReact(values = {}) {
  let index = 0;
  const Fragment = Symbol("Fragment");
  const refs = [];
  const slots = [];
  const useState = (initial) => {
    const at = index++;
    const value = at in values ? values[at] : typeof initial === "function" ? initial() : initial;
    return [value, () => {}];
  };
  const useRef = (initial) => {
    index++;
    const ref = { current: initial };
    refs.push(ref);
    return ref;
  };
  const useCallback = (callback) => {
    index++;
    return callback;
  };
  const useEffect = () => {
    index++;
  };
  const createElement = (type, props, ...children) => {
    if (type === Fragment) return { kind: "fragment", children };
    if (typeof type === "function") {
      return type({ ...(props || {}), children });
    }
    if (typeof type === "string") {
      slots.push(typeof props?.className === "string" ? props.className : type);
      return { kind: type, props: props || {}, children };
    }
    return { kind: "component", props: props || {}, children };
  };
  return {
    React: { createElement, useState, useEffect, useRef, useCallback, Fragment },
    hookIndex: () => index,
    classNames: () => slots,
  };
}

function installWindow() {
  const storage = new Map();
  const captured = { options: null };
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    __ModuleLoader__: {
      load(options) {
        captured.options = options;
      },
    },
  };
  return captured;
}

function sampleView() {
  return {
    ok: true,
    widgetEnabled: true,
    refreshSeconds: 60,
    generatedAt: "2026-11-08T17:04:52.660Z",
    account: { name: "Hakuzoukyuu", userName: "exblowa4k5", email: null, org: null },
    plan: {
      id: "individual-go-v1",
      name: "Go",
      monthlyCredits: 10,
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodStart: "2026-11-07T14:15:18.000Z",
      currentPeriodEnd: "2026-12-07T14:15:18.000Z",
      daysLeft: 29,
    },
    credits: {
      monthlyRemaining: 9.8699538,
      purchasedRemaining: 0,
      freeRemaining: 0,
      totalRemaining: 9.8699538,
      totalPool: 10,
      used: 0.1300462,
      usagePercent: 1.300462,
    },
    windows: {
      limited: true,
      fiveHour: { used: 0, cap: 3, exceeded: false, percent: 0, resetAt: null, resetInMs: null },
      weekly: { used: 0.13, cap: 6, exceeded: false, percent: 2.16, resetAt: 1794689090588, resetInMs: 531597928 },
    },
    usage: {
      totalCost: 0.13,
      totalTokens: 4142547,
      totalTokensIn: 4115920,
      totalTokensOut: 26627,
      requests: 55,
      successRate: 0.98,
    },
    links: {
      billing: "https://commandcode.ai/exblowa4k5/settings/billing",
      usage: "https://commandcode.ai/exblowa4k5/settings/usage",
    },
  };
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node !== "object") return "";
  const props = node.props || {};
  const own = Object.values(props)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String);
  return own.concat(textOf(node.children)).join(" ");
}

let renderSeq = 0;

async function render(values) {
  const captured = installWindow();
  await import(`../client.js?smoke=${++renderSeq}`);
  assert.ok(captured.options, "bundle did not call __ModuleLoader__.load");
  assert.equal(captured.options.id, "dsh-commandcode-go");

  const fake = fakeReact(values);
  const moduleExports = captured.options.factory((specifier) => {
    assert.equal(specifier, "react");
    return fake.React;
  });
  assert.deepEqual(moduleExports.inject, ["slots"]);

  let registration = null;
  const ctx = {
    slots: {
      inject(owner, callback) {
        assert.equal(owner, "shell.overlay");
        callback();
      },
      register(options, component) {
        registration = { options, component };
        return () => {};
      },
    },
  };
  moduleExports.apply(ctx);
  assert.ok(registration, "apply did not register a slot entry");
  assert.equal(registration.options.name, "shell.overlay");
  assert.equal(registration.options.id, "commandcode-usage");
  return { registration, fake };
}

test("client bundle registers one shell.overlay entry", async () => {
  const { registration } = await render({ 5: true });
  const tree = registration.component();
  assert.equal(tree.kind, "fragment");
  assert.ok(textOf(tree).includes("Command Code"));
});

test("client bundle renders credits, windows and the billing link", async () => {
  const { registration, fake } = await render({
    3: sampleView(),
    5: false,
  });
  const tree = registration.component();
  const text = textOf(tree);
  assert.ok(text.includes("$9.87"), text);
  assert.ok(text.includes("剩余 / $10.00"), text);
  assert.ok(text.includes("5 小时窗口"), text);
  assert.ok(text.includes("每周窗口"), text);
  assert.ok(text.includes("查看账单与用量"), text);
  assert.ok(text.includes("https://commandcode.ai/exblowa4k5/settings/billing"), text);
  assert.ok(fake.classNames().some((name) => name.includes("ccu-root")));
});

test("client bundle renders an error with a retry action", async () => {
  const { registration } = await render({
    3: null,
    4: "无法连接 Command Code：boom",
    5: false,
  });
  const text = textOf(registration.component());
  assert.ok(text.includes("无法连接 Command Code：boom"), text);
  assert.ok(text.includes("重新获取"), text);
});

test("client bundle hides itself when the widget config is off", async () => {
  const view = { ...sampleView(), widgetEnabled: false };
  const { registration } = await render({ 3: view, 5: false });
  assert.equal(registration.component(), null);
});
