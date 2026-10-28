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
