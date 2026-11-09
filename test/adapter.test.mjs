import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config } from "../lib/config.js";
import { ROUTE } from "../lib/config.js";
import {
  collectImages,
  createAdapter,
  requestOutputCap,
  resolveApiKey,
} from "../lib/adapter.js";
import { normalizeModel } from "../lib/catalog.js";

function fakeCatalog(model) {
  return {
    list: async () => [model],
    lookup: async (id) => (id === model.id || model.aliases.includes(id) ? model : null),
  };
}

function streamResponse(lines) {
  const payload = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

test("provider metadata and retry policy have the DSH 0.2.1 shape", () => {
  const model = normalizeModel({
    id: "m",
    name: "M",
    context_length: 100000,
    inputModalities: ["text"],
    minimumPlan: "individual-go",
  });
  const adapter = createAdapter({
    getConfig: () => Config({ retries: 2 }),
    catalog: fakeCatalog(model),
    getAttachments: () => undefined,
    fetchImpl: async () => streamResponse([]),
  });
  assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: "Command Code Go" });
  const policy = adapter.providerRetryPolicy();
  assert.equal(policy.mode, "normal");
  assert.equal(policy.maxRetries, 2);
  assert.equal(policy.initialDelayMs, 800);
  assert.equal(policy.maxDelayMs, 15000);
  assert.equal(policy.jitterRatio, 0.1);
  assert.ok(policy.retryableCodes.includes("STREAM_CLOSED"));
  assert.ok(!policy.retryableCodes.includes("ABORTED"));
});

test("resolveModel reports context, modalities, and a capped default", async () => {
  const model = normalizeModel({
    id: "vision",
    name: "Vision",
    context_length: 128000,
    inputModalities: ["image"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["low", "high"],
  });
  const adapter = createAdapter({
    getConfig: () => Config({ defaultMaxTokens: 32768 }),
    catalog: fakeCatalog(model),
    getAttachments: () => undefined,
  });
  const resolved = await adapter.resolveModel(ROUTE, "vision");
  assert.equal(resolved.provider, ROUTE);
  assert.equal(resolved.id, "vision");
  assert.deepEqual(resolved.context, { contextWindow: 128000 });
  assert.equal(resolved.defaultMaxTokens, 32768);
  assert.deepEqual(resolved.inputModalities, ["text", "image"]);
  assert.equal(resolved.reasoning.defaultEffort, "high");
});

test("requestOutputCap respects model ceiling, context, and the gateway cap", () => {
  assert.equal(
    requestOutputCap(
      { context: { contextWindow: 1000000 }, maxOutputTokens: 64000 },
      { defaultMaxTokens: 32768 },
    ),
    32768,
  );
  assert.equal(
    requestOutputCap(
      { context: { contextWindow: 4096 }, maxOutputTokens: 64000 },
      { defaultMaxTokens: 32768 },
    ),
    4096,
  );
  assert.equal(
    requestOutputCap(
      { context: { contextWindow: 1000000 }, maxOutputTokens: 200000 },
      { defaultMaxTokens: 200000 },
    ),
    131072,
  );
});

test("resolveApiKey prefers the configured key and falls back to env", () => {
  assert.equal(resolveApiKey({ apiKey: "user_config", apiKeyEnv: "CC_TEST_KEY" }), "user_config");
  process.env.CC_TEST_KEY = "user_env";
  try {
    assert.equal(resolveApiKey({ apiKey: "", apiKeyEnv: "CC_TEST_KEY" }), "user_env");
  } finally {
    delete process.env.CC_TEST_KEY;
  }
  const previousAuthFile = process.env.COMMANDCODE_AUTH_FILE;
  process.env.COMMANDCODE_AUTH_FILE = "/nonexistent/commandcode-auth.json";
  try {
    assert.throws(() => resolveApiKey({ apiKey: "", apiKeyEnv: "CC_MISSING" }), /No Command Code API key/);
  } finally {
    if (previousAuthFile === undefined) delete process.env.COMMANDCODE_AUTH_FILE;
    else process.env.COMMANDCODE_AUTH_FILE = previousAuthFile;
  }
});

test("collectImages rejects images when the attachment service is absent", async () => {
  const model = normalizeModel({
    id: "vision",
    name: "Vision",
    context_length: 100000,
    inputModalities: ["text", "image"],
    minimumPlan: "individual-go",
  });
  await assert.rejects(
    collectImages({
      messages: [
        {
          role: "user",
          content: [{ type: "image", attachment: { id: "img_1", width: 3000, height: 1000 } }],
        },
      ],
      info: model,
      attachments: undefined,
    }),
    /attachment service is unavailable/,
  );
});

test("prepareCall streams through the alpha endpoint and omits pinned temperature", async () => {
  const model = normalizeModel({
    id: "moonshotai/Kimi-K3.1-Pro",
    name: "Kimi K3.1 Pro",
    context_length: 1000000,
    inputModalities: ["text", "image"],
    minimumPlan: "individual-go",
    reasoningEfforts: ["off", "high"],
  });
  let captured;
  const adapter = createAdapter({
    getConfig: () =>
      Config({
        apiKey: "user_test",
        alphaVersion: "1.88.3",
        defaultMaxTokens: 4096,
      }),
    catalog: fakeCatalog(model),
    getAttachments: () => undefined,
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return streamResponse([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    },
  });
  const call = await adapter.prepareCall(ROUTE, model.id);
  const chunks = [];
  for await (const chunk of call.stream({
    model: model.id,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "think" },
          { type: "text", text: "hi" },
        ],
      },
    ],
    reasoningEffort: "off",
    temperature: 0.7,
  })) {
    chunks.push(chunk);
  }
  assert.equal(captured.url, "https://api.commandcode.ai/alpha/generate");
  assert.equal(captured.init.headers["x-command-code-version"], "1.88.3");
  assert.equal(captured.body.params.reasoning_effort, "off");
  assert.equal(captured.body.params.temperature, undefined);
  assert.deepEqual(captured.body.params.messages[1].content[0], {
    type: "reasoning",
    text: "think",
  });
  assert.equal(chunks.at(-1).type, "finish");
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
});

test("resolveApiKey reads the Command Code CLI auth file as a fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ccgo-auth-"));
  const file = join(dir, "auth.json");
  const previous = process.env.COMMANDCODE_AUTH_FILE;
  const previousMissing = process.env.DSH_CCGO_TEST_MISSING;
  try {
    writeFileSync(file, JSON.stringify({ accessToken: "user_from_file" }));
    process.env.COMMANDCODE_AUTH_FILE = file;
    delete process.env.DSH_CCGO_TEST_MISSING;
    const key = resolveApiKey({ apiKey: "", apiKeyEnv: "DSH_CCGO_TEST_MISSING" });
    assert.equal(key, "user_from_file");
    assert.equal(
      resolveApiKey({ apiKey: "user_from_settings", apiKeyEnv: "DSH_CCGO_TEST_MISSING" }),
      "user_from_settings",
    );
  } finally {
    if (previous === undefined) delete process.env.COMMANDCODE_AUTH_FILE;
    else process.env.COMMANDCODE_AUTH_FILE = previous;
    if (previousMissing !== undefined) process.env.DSH_CCGO_TEST_MISSING = previousMissing;
    rmSync(dir, { recursive: true, force: true });
  }
});
