"use strict";

const { verifyDeterministicTask } = require("./verifier");
const { createProofReceipt } = require("./proof-receipt");

const SCENARIOS = Object.freeze({
  pass: Object.freeze({
    id: "pass",
    title: "PASS — evidence satisfies the criteria",
    description: "Required report fields are present. The hypothetical payment is eligible for capture.",
    task: {
      taskId: "sim-report-pass",
      title: "Generate a report",
      amount: "15.00",
      acceptance: "Report contains a title and a meaningful summary of the result.",
      evidence: {
        title: "Quarterly Analysis",
        summary: "Revenue increased by 8% compared with the previous quarter.",
      },
      verification: "PASS",
      verificationSource: "simulation",
      verificationModel: null,
      reason: "Simulated PASS scenario: required report fields are present. This is not a live AI decision.",
    },
    paymentOutcome: "WOULD_CAPTURE",
  }),
  review: Object.freeze({
    id: "review",
    title: "REVIEW — evidence needs a person",
    description: "The evidence is intentionally ambiguous. The hypothetical payment is held for a human decision.",
    task: {
      taskId: "sim-report-review",
      title: "Review an ambiguous report",
      amount: "15.00",
      acceptance: "The report must state a clear, specific result supported by evidence.",
      evidence: {
        title: "Quarterly Analysis",
        summary: "Performance may have changed, depending on the metrics selected.",
      },
      verification: "REVIEW",
      verificationSource: "simulation",
      verificationModel: null,
      reason: "Simulated REVIEW scenario: the summary is ambiguous. A real reviewer must inspect the evidence before any payment is considered.",
    },
    paymentOutcome: "HELD_FOR_HUMAN_REVIEW",
  }),
  fail: Object.freeze({
    id: "fail",
    title: "FAIL — required evidence is missing",
    description: "The summary has no conclusion. No payment is eligible for capture.",
    task: {
      taskId: "sim-summary-fail",
      title: "Produce a summary",
      amount: "15.00",
      acceptance: "The summary must contain a conclusion.",
      evidence: {
        title: "Short Summary",
        conclusion: "",
      },
      verification: "FAIL",
      verificationSource: "simulation",
      verificationModel: null,
      reason: "Simulated FAIL scenario: required conclusion is missing. Human review cannot turn missing required fields into a PASS.",
    },
    paymentOutcome: "NO_CAPTURE",
  }),
});

function listScenarios() {
  return Object.values(SCENARIOS).map(({ id, title, description }) => ({
    id,
    title,
    description,
  }));
}

function simulateScenario(scenarioId, { now = () => new Date().toISOString() } = {}) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) {
    const error = new Error("Unknown scenario. Choose pass, review, or fail.");
    error.status = 400;
    throw error;
  }

  const taskDefinition = scenario.task;
  const evaluatedAt = now();
  const task = {
    ...structuredClone(taskDefinition),
    evaluatedAt,
    captureId: null,
    captureStatus: "NOT_ATTEMPTED",
    events: [
      {
        type: "SIMULATION_VERIFICATION",
        at: evaluatedAt,
        decision: taskDefinition.verification,
        source: "simulation",
      },
    ],
  };

  // Sanity check the FAIL sample against the same deterministic task rules.
  // REVIEW is intentionally scripted because a deterministic verifier should
  // not pretend ambiguity is an AI verdict.
  if (scenarioId === "fail") {
    const check = verifyDeterministicTask({
      id: "task-c",
      evidence: task.evidence,
    });
    if (check.decision !== "FAIL") {
      throw new Error("FAIL scenario fixture no longer fails its required gate.");
    }
    task.reason = check.reason;
  }

  const proofReceipt = createProofReceipt({
    task,
    generatedAt: evaluatedAt,
    simulated: true,
  });

  return {
    scenario: {
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
    },
    simulationOnly: true,
    paymentSideEffects: false,
    task,
    paymentOutcome: scenario.paymentOutcome,
    actualCapturedAmount: "0.00",
    proofReceipt,
    message: "Simulation complete. No PayPal payment endpoint was called and no payment was captured.",
  };
}

module.exports = { listScenarios, simulateScenario };
