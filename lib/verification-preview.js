"use strict";

/**
 * Build a verification-only preview. The evaluator may call an LLM, but this
 * module has no PayPal client and never creates/captures/voids a payment.
 */
async function createVerificationPreview(
  tasks,
  evaluateTask,
  { mode = "deterministic", now = () => new Date().toISOString() } = {}
) {
  if (!Array.isArray(tasks) || typeof evaluateTask !== "function") {
    throw new TypeError("Tasks and an evaluator function are required.");
  }

  const results = [];
  for (const task of tasks) {
    let verification;
    try {
      verification = await evaluateTask(task);
    } catch {
      verification = {
        decision: "REVIEW",
        source: "unknown",
        model: null,
        reason: "Verification failed unexpectedly; human review is required.",
      };
    }

    const allowed = ["PASS", "FAIL", "REVIEW"];
    if (!verification || !allowed.includes(verification.decision)) {
      verification = {
        decision: "REVIEW",
        source: "unknown",
        model: null,
        reason: "Verification returned an invalid decision; human review is required.",
      };
    }

    results.push({
      taskId: task.id,
      title: task.title,
      amount: task.amount,
      acceptance: task.acceptance,
      evidence: task.evidence,
      verification: verification.decision,
      verificationSource: verification.source || "unknown",
      verificationModel: verification.model || null,
      reason: verification.reason || "No verifier explanation was provided.",
      captureId: null,
      captureStatus: "NOT_ATTEMPTED",
      evaluatedAt: now(),
    });
  }

  return {
    mode,
    paymentSideEffects: false,
    tasks: results,
    totals: {
      captured: "0.00",
      uncertain: "0.00",
    },
    message:
      mode === "hybrid"
        ? "Verification preview complete. No PayPal payment request was made."
        : "Preview used deterministic checks because GROQ_API_KEY is not configured. No PayPal payment request was made.",
  };
}

module.exports = { createVerificationPreview };
