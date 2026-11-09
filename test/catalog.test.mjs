import test from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_MODELS,
  createCatalog,
  normalizeCatalog,
  normalizeModel,
  planAllows,
} from "../lib/catalog.js";

const CATALOG = {
  catalogVersion: "test-1",
  data: [
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      context_length: 1000000,
      inputModalities: ["text"],
      minimumPlan: "individual-go",
      reasoningEfforts: ["off", "low", "high"],
      display: { label: "DeepSeek V4 Flash", order: 2 },
    },
    {
      id: "moonshotai/Kimi-K3",
      name: "Kimi K3",
      aliases: ["kimi-k3"],
      context_length: 1000000,
      inputModalities: ["text", "image"],
      minimumPlan: "individual-go",
      reasoningEfforts: [{ id: "high", name: "High" }],
      display: { order: 1 },
    },
    {
      id: "individual-goat-only",
      name: "Goat only",
      minimumPlan: "individual-goat",
    },
  ],
};

test("normalizeModel keeps aliases, modalities, and reasoning labels", () => {
  const model = normalizeModel(CATALOG.data[1]);
  assert.equal(model.id, "moonshotai/Kimi-K3");
  assert.deepEqual(model.aliases, ["kimi-k3"]);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.deepEqual(model.reasoningEfforts, [{ id: "high", name: "High" }]);
  assert.equal(model.displayOrder, 1);
});

test("planAllows ranks Goat above Go and all above everything", () => {
  const go = normalizeModel(CATALOG.data[0]);
  const goat = normalizeModel(CATALOG.data[2]);
  assert.equal(planAllows(go, "individual-go"), true);
  assert.equal(planAllows(goat, "individual-go"), false);
  assert.equal(planAllows(goat, "individual-goat"), true);
  assert.equal(planAllows(goat, "all"), true);
});

test("normalizeCatalog rejects malformed payloads", () => {
  assert.throws(() => normalizeCatalog({}), /no data array/);
  assert.throws(() => normalizeCatalog({ data: [] }), /empty/);
  assert.equal(normalizeCatalog(CATALOG).models.length, 3);
});

test("catalog fetches once, filters by plan, and resolves aliases", async () => {
  let calls = 0;
  const catalog = createCatalog({
    getConfig: () => ({ baseURL: "https://api.commandcode.ai/provider/v1" }),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    },
  });
  const models = await catalog.list({ plan: "individual-go" });
  assert.deepEqual(models.map((model) => model.id).sort(), [
    "deepseek/deepseek-v4-flash",
    "moonshotai/Kimi-K3",
  ]);
  assert.equal((await catalog.lookup("kimi-k3")).id, "moonshotai/Kimi-K3");
  assert.equal(calls, 1);
});

test("catalog falls back to the built-in Go list when the network fails", async () => {
  const catalog = createCatalog({
    getConfig: () => ({ baseURL: "https://api.commandcode.ai/provider/v1" }),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const models = await catalog.list({ plan: "individual-go" });
  assert.ok(models.length >= FALLBACK_MODELS.length - 1);
  assert.ok(models.some((model) => model.id === "gpt-6-luna"));
  assert.equal(catalog.version(), "fallback");
});
