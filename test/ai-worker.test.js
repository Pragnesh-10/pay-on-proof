"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateReferenceWorkerOutput,
  MAX_PROMPT_BYTES,
} = require("../lib/ai-worker");

const sourceRecords = [
  { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget" },
  { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable" },
];
const criteria = {
  keyField: "id",
  preserveFields: ["id", "quantity", "unitPrice", "description"],
  derivedFields: [
    { field: "lineTotal", operation: "multiply", inputs: ["quantity", "unitPrice"] },
  ],
};

function mockFetch(records, { model = "test-model", status = 200 } = {}) {
  return async (_url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const request = JSON.parse(options.body);
    assert.equal(request.response_format.type, "json_object");
    return new Response(JSON.stringify({
      model,
      choices: [{
        message: {
          content: JSON.stringify({ records }),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("AI worker generates structured output but returns no verification or payment decision", async () => {
  const result = await generateReferenceWorkerOutput({
    sourceRecords,
    criteria,
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: mockFetch([
      { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget", lineTotal: 37.5 },
      { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable", lineTotal: 14 },
    ]),
  });

  const rows = JSON.parse(result.outputContent);
  assert.equal(result.provider, "groq");
  assert.equal(result.model, "test-model");
  assert.equal(result.recordCount, 2);
  assert.equal(rows[0].lineTotal, 37.5);
  assert.match(result.outputSha256, /^[a-f0-9]{64}$/);
  assert.equal("decision" in result, false);
  assert.equal("passed" in result, false);
  assert.equal(result.usage.promptTokens, 100);
});

test("AI worker rejects missing credentials before any network request", async () => {
  let called = false;
  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords,
      criteria,
      apiKey: "",
      fetchImpl: async () => { called = true; },
    }),
    /not configured/
  );
  assert.equal(called, false);
});

test("AI worker refuses to send buyer data to unapproved endpoints", async () => {
  let called = false;
  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords,
      criteria,
      apiKey: "test-key",
      endpoint: "https://example.com/collect",
      fetchImpl: async () => { called = true; },
    }),
    /only to the official Groq endpoint/
  );
  assert.equal(called, false);
});

test("AI worker bounds records and prompt size before sending buyer data", async () => {
  let called = false;
  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords: Array.from({ length: 51 }, (_, i) => ({ id: String(i) })),
      criteria,
      apiKey: "test-key",
      fetchImpl: async () => { called = true; },
    }),
    /at most 50/
  );
  assert.equal(called, false);

  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords: [{ id: "A", value: "x".repeat(MAX_PROMPT_BYTES) }],
      criteria,
      apiKey: "test-key",
      fetchImpl: async () => { called = true; },
    }),
    /exceeds 12 KB/
  );
  assert.equal(called, false);
});

test("AI worker rejects malformed or unexpected provider output", async () => {
  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords,
      criteria,
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: "not json" } }],
      }), { status: 200 }),
    }),
    /invalid JSON/
  );

  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords,
      criteria,
      apiKey: "test-key",
      fetchImpl: mockFetch([{ id: "INV-1" }, null]),
    }),
    /non-object record/
  );

  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords,
      criteria,
      apiKey: "test-key",
      fetchImpl: async () => new Response("{}", { status: 429 }),
    }),
    /HTTP 429/
  );
});

test("AI worker handles provider refusals and transport timeouts without producing a result", async () => {
  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords,
      criteria,
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { refusal: "cannot process", content: "" } }],
      }), { status: 200 }),
    }),
    /usable worker output/
  );

  await assert.rejects(
    () => generateReferenceWorkerOutput({
      sourceRecords,
      criteria,
      apiKey: "test-key",
      timeoutMs: 100,
      fetchImpl: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    }),
    /timed out/
  );
});
