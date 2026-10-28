"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProofReceipt, sha256, verifyProofReceipt } = require("../lib/proof-receipt");
const { listScenarios, simulateScenario } = require("../lib/scenario-simulator");

function task(overrides = {}) {
  return {
    taskId: "task-x",
    title: "Test task",
    amount: "15.00",
    acceptance: "Evidence must contain a result.",
    evidence: { result: "done" },
    verification: "PASS",
    verificationSource: "deterministic",
    verificationModel: null,
    reason: "Required evidence is present.",
    evaluatedAt: "2026-10-28T00:00:00.000Z",
    captureId: "capture-1",
    captureStatus: "COMPLETED",
    events: [],
    ...overrides,
  };
}

test("proof receipt includes content hashes and a receipt hash", () => {
  const receipt = createProofReceipt({
    authorizationId: "auth-1",
    task: task(),
    generatedAt: "2026-10-28T00:01:00.000Z",
  });

  assert.equal(receipt.task.evidenceSha256, sha256({ result: "done" }));
  assert.equal(receipt.task.criteriaSha256, sha256("Evidence must contain a result."));
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.payment.captureId, "capture-1");
  assert.equal(receipt.payment.authoritative, true);
});

test("receipt verifier detects changed acceptance criteria", () => {
  const receipt = createProofReceipt({
    task: task(),
    generatedAt: "2026-10-28T00:01:00.000Z",
    simulated: true,
  });
  const tampered = JSON.parse(JSON.stringify(receipt));
  tampered.task.acceptanceCriteria = "A different criterion";

  const result = verifyProofReceipt(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.checks.find((check) => check.id === "criteria-hash").status, "FAIL");
});

test("evidence hashes are stable across object key order and change when evidence changes", () => {
  const a = createProofReceipt({
    task: task({ evidence: { a: 1, b: 2 }, captureId: null }),
    generatedAt: "2026-10-28T00:01:00.000Z",
    simulated: true,
  });
  const b = createProofReceipt({
    task: task({ evidence: { b: 2, a: 1 }, captureId: null }),
    generatedAt: "2026-10-28T00:01:00.000Z",
    simulated: true,
  });
  const changed = createProofReceipt({
    task: task({ evidence: { a: 1, b: 3 }, captureId: null }),
    generatedAt: "2026-10-28T00:01:00.000Z",
    simulated: true,
  });

  assert.equal(a.task.evidenceSha256, b.task.evidenceSha256);
  assert.notEqual(a.task.evidenceSha256, changed.task.evidenceSha256);
  assert.equal(a.receiptSha256, b.receiptSha256);
  assert.notEqual(a.receiptSha256, changed.receiptSha256);
});

test("simulation receipts are explicitly non-authoritative and contain no capture ID", () => {
  const result = simulateScenario("pass", {
    now: () => "2026-10-28T00:00:00.000Z",
  });

  assert.equal(result.simulationOnly, true);
  assert.equal(result.paymentSideEffects, false);
  assert.equal(result.actualCapturedAmount, "0.00");
  assert.equal(result.proofReceipt.mode, "SIMULATION_ONLY");
  assert.equal(result.proofReceipt.payment.authoritative, false);
  assert.equal(result.proofReceipt.payment.captureId, null);
  assert.equal(result.proofReceipt.payment.outcome, "WOULD_CAPTURE");
});

test("three-scenario simulator has explicit PASS REVIEW FAIL outcomes without PayPal side effects", () => {
  assert.deepEqual(
    listScenarios().map((scenario) => scenario.id),
    ["pass", "review", "fail"]
  );
  assert.equal(simulateScenario("pass").task.verification, "PASS");
  assert.equal(simulateScenario("review").task.verification, "REVIEW");
  assert.equal(simulateScenario("fail").task.verification, "FAIL");
  assert.equal(simulateScenario("review").paymentOutcome, "HELD_FOR_HUMAN_REVIEW");
  assert.equal(simulateScenario("fail").paymentOutcome, "NO_CAPTURE");
  assert.throws(() => simulateScenario("other"), /Unknown scenario/);
});

test("human review outcome is visible in receipts without replacing the original verifier decision", () => {
  const receipt = createProofReceipt({
    authorizationId: "auth-1",
    task: task({
      verification: "REVIEW",
      captureStatus: "NOT_ATTEMPTED",
      captureId: null,
      review: {
        status: "REJECTED",
        reviewer: "Local reviewer",
        notes: "Evidence is not sufficient.",
        reviewedAt: "2026-10-28T01:00:00.000Z",
      },
    }),
    generatedAt: "2026-10-28T01:01:00.000Z",
  });

  assert.equal(receipt.verification.originalDecision, "REVIEW");
  assert.equal(receipt.verification.effectiveDecision, "HUMAN_REJECTED");
  assert.equal(receipt.payment.outcome, "REJECTED_BY_REVIEWER");
});
