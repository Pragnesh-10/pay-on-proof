"use strict";

const crypto = require("node:crypto");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function effectiveDecision(task) {
  if (task?.review?.status === "APPROVED") return "HUMAN_APPROVED";
  if (task?.review?.status === "REJECTED") return "HUMAN_REJECTED";
  return task?.verification || "UNKNOWN";
}

function paymentOutcome(task, simulated) {
  const status = task?.captureStatus || "NOT_ATTEMPTED";

  if (simulated) {
    if (task?.verification === "PASS") return "WOULD_CAPTURE";
    if (task?.verification === "REVIEW") return "HELD_FOR_HUMAN_REVIEW";
    return "NO_CAPTURE";
  }

  if (status === "COMPLETED") return "CAPTURE_COMPLETED";
  if (status === "PENDING") return "CAPTURE_PENDING";
  if (status === "UNKNOWN" || status === "IN_PROGRESS") return "OUTCOME_UNCERTAIN";
  if (status === "FAILED") return "CAPTURE_FAILED";
  if (task?.review?.status === "REJECTED") return "REJECTED_BY_REVIEWER";
  if (task?.review?.status === "APPROVED") return "REVIEW_APPROVED_CAPTURE_NOT_CONFIRMED";
  if (task?.verification === "REVIEW") return "HELD_FOR_HUMAN_REVIEW";
  if (task?.verification === "FAIL") return "NO_CAPTURE";
  return "NOT_ATTEMPTED";
}

/**
 * Build an inspectable evidence receipt. Hashes prove byte-level integrity of
 * the recorded snapshot; they do not prove that claims inside the evidence are
 * true or that the evidence came from a trusted source.
 */
function createProofReceipt({
  authorizationId = null,
  currency = "USD",
  authorizationStatus = null,
  task,
  generatedAt = new Date().toISOString(),
  simulated = false,
}) {
  if (!task || typeof task !== "object" || !task.taskId) {
    throw new TypeError("A recorded task is required to create a proof receipt.");
  }

  const evidence = canonicalize(task.evidence ?? {});
  const criteria = task.acceptance ?? "";
  const body = {
    schemaVersion: "1.0",
    mode: simulated ? "SIMULATION_ONLY" : "PAYMENT_SESSION",
    generatedAt,
    authorizationId: simulated ? null : authorizationId,
    currency,
    task: {
      id: task.taskId,
      title: task.title || task.taskId,
      amount: task.amount || "0.00",
      acceptanceCriteria: canonicalize(criteria),
      evidence,
      evidenceSha256: sha256(evidence),
      criteriaSha256: sha256(criteria),
    },
    artifact: task.artifact ? canonicalize(task.artifact) : null,
    verification: {
      originalDecision: task.verification || "UNKNOWN",
      effectiveDecision: effectiveDecision(task),
      source: task.verificationSource || "unknown",
      model: task.verificationModel || null,
      verifierVersion: task.verifierVersion || "1.0.0",
      checks: Array.isArray(task.verificationChecks) ? canonicalize(task.verificationChecks) : [],
      reason: task.reason || "No verifier explanation was recorded.",
      evaluatedAt: task.evaluatedAt || null,
    },
    review: task.review
      ? {
          status: task.review.status,
          reviewer: task.review.reviewer || null,
          notes: task.review.notes || "",
          reviewedAt: task.review.reviewedAt || null,
        }
      : null,
    payment: {
      authoritative: !simulated,
      authorizationStatus: simulated ? null : authorizationStatus,
      outcome: paymentOutcome(task, simulated),
      captureStatus: task.captureStatus || "NOT_ATTEMPTED",
      captureId: simulated ? null : task.captureId || null,
      amount: task.amount || "0.00",
      currency,
    },
    events: Array.isArray(task.events) ? task.events : [],
    limitations: [
      "Hashes show whether this recorded snapshot changes; they do not establish that the evidence is true.",
      "AI-assisted decisions are advisory and may be wrong.",
      simulated
        ? "This is a simulation-only receipt. No PayPal payment request was made."
        : "This receipt reflects the local demo record. Confirm financial state with PayPal when a capture is pending or uncertain.",
    ],
  };

  return {
    ...body,
    receiptSha256: sha256(body),
  };
}


/**
 * Verify receipt structure and hashes without trusting the receipt's own
 * result. Supplying original artifactContent also checks the raw source bytes.
 */
function verifyProofReceipt(receipt, { artifactContent } = {}) {
  const checks = [];
  const warnings = [];
  const add = (id, label, passed, details) => checks.push({
    id,
    label,
    status: passed ? "PASS" : "FAIL",
    details,
  });

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return {
      valid: false,
      artifactContentChecked: false,
      checks: [{ id: "receipt-shape", label: "Receipt is an object", status: "FAIL", details: "A JSON receipt object is required." }],
      warnings: [],
    };
  }

  add("receipt-shape", "Receipt structure", receipt.schemaVersion === "1.0" &&
    receipt.task && typeof receipt.task === "object" && typeof receipt.receiptSha256 === "string",
    "Receipt schema, task, and receipt hash must be present.");

  const evidence = receipt.task && Object.prototype.hasOwnProperty.call(receipt.task, "evidence")
    ? receipt.task.evidence : {};
  const criteria = receipt.task && Object.prototype.hasOwnProperty.call(receipt.task, "acceptanceCriteria")
    ? receipt.task.acceptanceCriteria : "";

  const evidenceHashValid = typeof receipt.task?.evidenceSha256 === "string" &&
    receipt.task.evidenceSha256 === sha256(evidence);
  add("evidence-hash", "Evidence hash", evidenceHashValid,
    evidenceHashValid ? "Recorded evidence matches its SHA-256 digest." : "Evidence content does not match the recorded digest.");

  const criteriaHashValid = typeof receipt.task?.criteriaSha256 === "string" &&
    receipt.task.criteriaSha256 === sha256(criteria);
  add("criteria-hash", "Acceptance-criteria hash", criteriaHashValid,
    criteriaHashValid ? "Acceptance criteria match their SHA-256 digest." : "Acceptance criteria do not match the recorded digest.");

  const body = { ...receipt };
  delete body.receiptSha256;
  const receiptHashValid = typeof receipt.receiptSha256 === "string" &&
    receipt.receiptSha256 === sha256(body);
  add("receipt-hash", "Receipt hash", receiptHashValid,
    receiptHashValid ? "Receipt body matches its SHA-256 digest." : "One or more receipt fields changed after the receipt was generated.");

  let artifactContentChecked = false;
  if (receipt.artifact && typeof receipt.artifact.sha256 === "string") {
    if (typeof artifactContent === "string") {
      artifactContentChecked = true;
      const rawHash = crypto.createHash("sha256").update(artifactContent, "utf8").digest("hex");
      const artifactHashValid = rawHash === receipt.artifact.sha256;
      add("artifact-content", "Original artifact content", artifactHashValid,
        artifactHashValid ? "The supplied artifact bytes match the recorded artifact digest." : "The supplied artifact bytes do not match the recorded artifact digest.");
    } else {
      warnings.push("The original artifact was not supplied; its raw content digest was not checked.");
      checks.push({
        id: "artifact-content",
        label: "Original artifact content",
        status: "SKIPPED",
        details: "Supply the original file content to compare the raw artifact digest.",
      });
    }
  } else if (typeof artifactContent === "string") {
    add("artifact-content", "Original artifact content", false,
      "The receipt does not contain an artifact digest to compare.");
  }

  return {
    valid: checks.every((check) => check.status !== "FAIL"),
    artifactContentChecked,
    checks,
    warnings,
  };
}

module.exports = {
  canonicalize,
  sha256,
  createProofReceipt,
  verifyProofReceipt,
};
