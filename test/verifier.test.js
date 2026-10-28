"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  verifyDeterministicTask,
  validateAiDecision,
  verifyWithGroq,
} = require("../lib/verifier");
const {
  createVerificationPreview,
} = require("../lib/verification-preview");

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
  }, "openai/gpt-oss-20b");

  assert.equal(result.decision, "PASS");
  assert.equal(result.passed, true);
  assert.equal(result.source, "groq");
  assert.equal(result.model, "openai/gpt-oss-20b");
});


test("Groq semantic PASS is parsed from the raw Responses API output array", async () => {
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
        choices: [{
          message: {
            content: JSON.stringify({
              decision: "PASS",
              reason: "The summary states a clear result.",
            }),
          },
          finish_reason: "stop",
        }],
      }),
    };
  };

  try {
    const result = await verifyWithGroq(
      {
        acceptance: "The summary communicates a meaningful result.",
        evidence: { title: "Report", summary: "Revenue increased." },
      },
      { apiKey: "test-key", model: "openai/gpt-oss-20b" }
    );

    assert.equal(result.decision, "PASS");
    assert.equal(result.source, "groq");
    assert.equal(result.model, "openai/gpt-oss-20b");
    assert.equal(requestHeaders.Authorization, "Bearer test-key");
    assert.equal(requestBody.response_format.type, "json_schema");
    assert.equal(requestBody.response_format.json_schema.strict, true);
    assert.equal(requestBody.model, "openai/gpt-oss-20b");
    assert.equal("tools" in requestBody, false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("successful but malformed Groq payload returns REVIEW", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: "PASS",
            reason: "",
          }),
        },
        finish_reason: "stop",
      }],
    }),
  });

  try {
    const result = await verifyWithGroq(
      {
        acceptance: "The summary communicates a meaningful result.",
        evidence: { summary: "Revenue increased." },
      },
      { apiKey: "test-key", model: "openai/gpt-oss-20b" }
    );

    assert.equal(result.decision, "REVIEW");
    assert.equal(result.passed, false);
  } finally {
    global.fetch = previousFetch;
  }
});


test("verification preview records decisions but never marks captures attempted", async () => {
  const tasks = [
    {
      id: "a",
      title: "Good task",
      amount: "5.00",
      acceptance: "Criterion",
      evidence: { result: "proof" },
    },
    {
      id: "b",
      title: "Ambiguous task",
      amount: "7.00",
      acceptance: "Criterion",
      evidence: {},
    },
  ];
  let calls = 0;
  const preview = await createVerificationPreview(
    tasks,
    async () => {
      calls += 1;
      return calls === 1
        ? { decision: "PASS", source: "groq", model: "openai/gpt-oss-20b", reason: "Clear result." }
        : { decision: "REVIEW", source: "groq", model: "openai/gpt-oss-20b", reason: "Ambiguous." };
    },
    { mode: "hybrid", now: () => "2026-01-01T00:00:00.000Z" }
  );

  assert.equal(calls, 2);
  assert.equal(preview.paymentSideEffects, false);
  assert.equal(preview.totals.captured, "0.00");
  assert.equal(preview.totals.uncertain, "0.00");
  assert.deepEqual(
    preview.tasks.map((task) => task.verification),
    ["PASS", "REVIEW"]
  );
  assert.ok(preview.tasks.every((task) => task.captureStatus === "NOT_ATTEMPTED"));
  assert.ok(preview.tasks.every((task) => task.captureId === null));
  assert.equal(preview.tasks[0].verificationSource, "groq");
});

test("verification preview fails closed if an evaluator throws or returns an invalid decision", async () => {
  const tasks = [
    { id: "a", title: "A", amount: "1.00", acceptance: "A", evidence: {} },
    { id: "b", title: "B", amount: "1.00", acceptance: "B", evidence: {} },
  ];
  const preview = await createVerificationPreview(tasks, async (task) => {
    if (task.id === "a") throw new Error("provider outage");
    return { decision: "CAPTURE", reason: "invalid" };
  });

  assert.deepEqual(
    preview.tasks.map((task) => task.verification),
    ["REVIEW", "REVIEW"]
  );
  assert.ok(preview.tasks.every((task) => task.captureStatus === "NOT_ATTEMPTED"));
});

test("Groq response errors reject so the caller can route to review", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: { message: "private provider details" } }),
  });

  try {
    await assert.rejects(
      verifyWithGroq(
        {
          acceptance: "Summary is meaningful.",
          evidence: { summary: "A result." },
        },
        { apiKey: "test-key", model: "openai/gpt-oss-20b" }
      ),
      /HTTP 503/
    );
  } finally {
    global.fetch = previousFetch;
  }
});
