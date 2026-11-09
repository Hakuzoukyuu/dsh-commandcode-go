import test from "node:test";
import assert from "node:assert/strict";

import {
  ALPHA_MAX_TOKENS,
  alphaThreadId,
  parseAlphaEvent,
  streamAlpha,
  toAlphaEnvelope,
} from "../lib/alpha.js";

function responseFrom(lines, status = 200) {
  const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/x-ndjson" } });
}

async function collect(iterator) {
  const chunks = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

test("alphaThreadId is stable, deterministic, and UUID v5 shaped", () => {
  const a = alphaThreadId("session-1");
  const b = alphaThreadId("session-1");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, alphaThreadId("session-2"));
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(alphaThreadId(uuid), uuid);
});

test("envelope keeps an empty system prompt as a single space", () => {
  const body = toAlphaEnvelope({
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    threadId: alphaThreadId("s"),
  });
  assert.equal(body.params.system, " ");
  assert.equal(body.params.stream, true);
  assert.equal(body.permissionMode, "standard");
  assert.equal(body.threadId, alphaThreadId("s"));
});

test("envelope replays historical reasoning and tool results", () => {
  const body = toAlphaEnvelope({
    model: "deepseek/deepseek-v4-flash",
    system: "be brief",
    messages: [
      { role: "user", content: [{ type: "text", text: "read a" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I should read the file." },
          { type: "text", text: "Reading." },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: { type: "text", value: "contents" },
          },
        ],
      },
    ],
    threadId: alphaThreadId("s"),
  });
  assert.equal(body.params.system, "be brief");
  assert.deepEqual(body.params.messages[1].content[0], {
    type: "reasoning",
    text: "I should read the file.",
  });
  assert.equal(body.params.messages[1].content[2].type, "tool-call");
  assert.equal(body.params.messages[2].role, "tool");
  assert.equal(body.params.messages[2].content[0].toolCallId, "call_1");
  assert.equal(body.params.messages[2].content[0].output.value, "contents");
});

test("envelope encodes DSH 0.2.x text tool results", () => {
  const body = toAlphaEnvelope({
    model: "deepseek/deepseek-v4.1-flash",
    messages: [
      { role: "user", content: [{ type: "text", text: "send a meme" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_meme", name: "send_meme", arguments: "{}" },
        ],
      },
      {
        role: "tool",
        source: { kind: "tool", callId: "call_meme" },
        toolCallId: "call_meme",
        content: [{ type: "text", text: "no meme found" }],
      },
    ],
    threadId: alphaThreadId("s"),
  });
  const toolMessage = body.params.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "the tool result must survive encoding");
  assert.deepEqual(toolMessage.content[0], {
    type: "tool-result",
    toolCallId: "call_meme",
    toolName: "send_meme",
    output: { type: "text", value: "no meme found" },
  });
});

test("envelope clamps the alpha output cap and sends explicit reasoning effort", () => {
  const body = toAlphaEnvelope({
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 999999,
    effort: "off",
    threadId: alphaThreadId("s"),
  });
  assert.equal(body.params.max_tokens, ALPHA_MAX_TOKENS);
  assert.equal(body.params.reasoning_effort, "off");
  assert.equal(ALPHA_MAX_TOKENS, 131072);
});

test("parseAlphaEvent tolerates SSE framing, comments, and [DONE]", () => {
  assert.deepEqual(parseAlphaEvent('data: {"type":"text-delta","text":"x"}'), {
    type: "text-delta",
    text: "x",
  });
  assert.equal(parseAlphaEvent(": keep-alive"), null);
  assert.equal(parseAlphaEvent("event: message"), null);
  assert.deepEqual(parseAlphaEvent("[DONE]"), { type: "done" });
  assert.equal(parseAlphaEvent("not json"), null);
});

test("streamAlpha translates reasoning, text, tools, usage, and finish", async () => {
  const chunks = await collect(
    streamAlpha({
      url: "https://example.test/alpha/generate",
      headers: {},
      body: {},
      fetchImpl: async () =>
        responseFrom([
          { type: "reasoning-delta", text: "plan" },
          { type: "text-delta", text: "hello" },
          { type: "tool-input-start", id: "call_1", toolName: "read" },
          { type: "tool-input-delta", id: "call_1", delta: '{"path":"a"}' },
          {
            type: "finish",
            finishReason: "tool-calls",
            totalUsage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
          },
        ]),
    }),
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    [
      "block-start",
      "reasoning-delta",
      "block-end",
      "block-start",
      "text-delta",
      "block-end",
      "block-start",
      "tool-call-delta",
      "block-end",
      "usage",
      "finish",
    ],
  );
  assert.deepEqual(chunks[0], { type: "block-start", index: 0, blockType: "reasoning" });
  assert.deepEqual(chunks[2].block, { type: "reasoning", text: "plan" });
  assert.deepEqual(chunks[3], { type: "block-start", index: 1, blockType: "text" });
  assert.deepEqual(chunks[5].block, { type: "text", text: "hello" });
  assert.deepEqual(chunks[8].block, {
    type: "tool-call",
    id: "call_1",
    name: "read",
    arguments: '{"path":"a"}',
  });
  assert.deepEqual(chunks[9].usage, {
    inputTokens: 8,
    outputTokens: 3,
    cacheReadTokens: 2,
  });
  assert.deepEqual(chunks[10].reason, { kind: "tool-calls" });
});

test("streamAlpha reports an empty response as a failure", async () => {
  const chunks = await collect(
    streamAlpha({
      url: "https://example.test/alpha/generate",
      headers: {},
      body: {},
      fetchImpl: async () => responseFrom([{ type: "finish", finishReason: "stop" }]),
    }),
  );
  assert.deepEqual(chunks[0].reason, {
    kind: "error",
    failure: { message: "Command Code returned an empty response", code: "EMPTY_RESPONSE" },
  });
});

test("streamAlpha rejects a stream without finish", async () => {
  const iterator = streamAlpha({
    url: "https://example.test/alpha/generate",
    headers: {},
    body: {},
    fetchImpl: async () => responseFrom([{ type: "text-delta", text: "partial" }]),
  });
  await assert.rejects(async () => {
    for await (const _ of iterator) {
      // Drain.
    }
  }, /alpha transport ended without a finish event/);
});

test("streamAlpha classifies an HTTP 401 as AUTH", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 });
  await assert.rejects(
    collect(
      streamAlpha({
        url: "https://example.test/alpha/generate",
        headers: {},
        body: {},
        fetchImpl,
      }),
    ),
    (error) => {
      assert.equal(error.code, "AUTH");
      assert.equal(error.failure.code, "AUTH");
      return true;
    },
  );
});
