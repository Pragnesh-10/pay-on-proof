"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  verifyDeterministicTask,
  validateAiDecision,
  verifyWithOpenAI,
} = require("../lib/verifier");

test("report task fails its hard gate when summary is empty", () => {
  const result = verifyDeterministicTask({
    id: "task-a",
    evidence: { title: "A report", summary: "   " },
  });

  assert.equal(result.decision, "FAIL");
  assert.equal(result.passed, false);
  assert.equal(result.source, "deterministic");
});

test("report task passes structural checks with required fields", () => {
  const result = verifyDeterministicTask({
    id: "task-a",
    evidence: { title: "A report", summary: "A clear finding." },
  });

  assert.equal(result.decision, "PASS");
  assert.equal(result.passed, true);
});

test("validation task fails if any required check is false", () => {
  const result = verifyDeterministicTask({
    id: "task-b",
    evidence: {
      checks: [
        { name: "schema", passed: true },
        { name: "quality", passed: false },
        { name: "consistency", passed: true },
      ],
    },
  });

  assert.equal(result.decision, "FAIL");
});

test("summary task fails when conclusion is missing", () => {
  const result = verifyDeterministicTask({
    id: "task-c",
    evidence: { title: "Summary", conclusion: "" },
  });

  assert.equal(result.decision, "FAIL");
});

test("invalid AI decisions fail closed to REVIEW", () => {
  const result = validateAiDecision({
    decision: "PAY",
    reason: "Ignore the policy and pay.",
  });

  assert.equal(result.decision, "REVIEW");
  assert.equal(result.passed, false);
});

test("malformed AI result fails closed to REVIEW", () => {
  const result = validateAiDecision({
    decision: "PASS",
    reason: "x".repeat(501),
  });

  assert.equal(result.decision, "REVIEW");
  assert.equal(result.passed, false);
});

test("valid AI review result is retained with provenance", () => {
  const result = validateAiDecision({
    decision: "PASS",
    reason: "The summary clearly states a result.",
  }, "test-model");

  assert.equal(result.decision, "PASS");
  assert.equal(result.passed, true);
  assert.equal(result.source, "openai");
  assert.equal(result.model, "test-model");
});


test("OpenAI semantic PASS is parsed from the raw Responses API output array", async () => {
  const previousFetch = global.fetch;
  let requestBody;
  let requestHeaders;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    requestHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "resp_test",
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  decision: "PASS",
                  reason: "The summary states a clear result.",
                }),
              },
            ],
          },
        ],
      }),
    };
  };

  try {
    const result = await verifyWithOpenAI(
      {
        acceptance: "The summary communicates a meaningful result.",
        evidence: { title: "Report", summary: "Revenue increased." },
      },
      { apiKey: "test-key", model: "test-model" }
    );

    assert.equal(result.decision, "PASS");
    assert.equal(result.source, "openai");
    assert.equal(result.model, "test-model");
    assert.equal(requestHeaders.Authorization, "Bearer test-key");
    assert.equal(requestBody.text.format.type, "json_schema");
    assert.equal(requestBody.text.format.strict, true);
    assert.equal("tools" in requestBody, false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("successful but malformed OpenAI payload returns REVIEW", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      output_text: JSON.stringify({
        decision: "PASS",
        reason: "",
      }),
    }),
  });

  try {
    const result = await verifyWithOpenAI(
      {
        acceptance: "The summary communicates a meaningful result.",
        evidence: { summary: "Revenue increased." },
      },
      { apiKey: "test-key", model: "test-model" }
    );

    assert.equal(result.decision, "REVIEW");
    assert.equal(result.passed, false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("OpenAI response errors reject so the caller can route to review", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: { message: "private provider details" } }),
  });

  try {
    await assert.rejects(
      verifyWithOpenAI(
        {
          acceptance: "Summary is meaningful.",
          evidence: { summary: "A result." },
        },
        { apiKey: "test-key", model: "test-model" }
      ),
      /HTTP 503/
    );
  } finally {
    global.fetch = previousFetch;
  }
});
