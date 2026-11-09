import test from "node:test";
import assert from "node:assert/strict";

import { Config, DEFAULTS, NAMESPACE, PLANS } from "../lib/config.js";

test("Config fills defaults and normalizes the model list", () => {
  const value = Config({ models: "a, b a", defaultMaxTokens: "4096" });
  assert.equal(value.apiKey, "");
  assert.equal(value.apiKeyEnv, "CMD_API_KEY");
  assert.equal(value.alphaVersion, "1.88.3");
  assert.equal(value.plan, "individual-go");
  assert.deepEqual(value.models, ["a", "b"]);
  assert.equal(value.defaultMaxTokens, 4096);
  assert.equal(NAMESPACE, "dsh-commandcode-go");
  assert.deepEqual(PLANS.slice(0, 1), ["individual-go"]);
});

test("Config exposes a volatile, secret-aware Schemastery tree", () => {
  const json = Config.toJSON();
  assert.equal(Config.type, "object");
  assert.equal(Config.meta.volatile, true);
  assert.equal(json.refs[json.uid].type, "object");
  assert.equal(json.refs[json.uid].meta.volatile, true);
  assert.equal(json.refs[json.uid].dict.apiKey, 1);
  assert.equal(json.refs["1"].meta.role, "secret");
  assert.equal(json.refs["1"].meta.default, undefined);
  assert.equal(json.refs[json.uid].dict.defaultMaxTokens, 8);
});

test("Config rejects invalid plans and URLs through Standard Schema", () => {
  assert.throws(() => Config({ plan: "enterprise" }), /plan must be one of/);
  assert.throws(() => Config({ baseURL: "file:///tmp/x" }), /baseURL/);
  const result = Config["~standard"].validate({ plan: "enterprise" });
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.issues[0].path, ["plan"]);
});

test("Config is cloned and defaults stay immutable", () => {
  const one = Config({});
  one.models.push("x");
  const two = Config({});
  assert.deepEqual(two.models, []);
  assert.equal(DEFAULTS.plan, "individual-go");
});
