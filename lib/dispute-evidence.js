"use strict";

const { sha256, verifyProofReceipt } = require("./proof-receipt");

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requestedSellerEvidence(dispute) {
  return (Array.isArray(dispute?.evidences) ? dispute.evidences : [])
    .filter((evidence) => evidence?.source === "REQUESTED_FROM_SELLER");
}

function hasProvideEvidenceAction(dispute) {
  return (Array.isArray(dispute?.links) ? dispute.links : []).some((link) =>
    String(link?.rel || "").toLowerCase().replaceAll("_", "-") === "provide-evidence"
  );
}

function buildMerchantNotes(receipt) {
  const task = receipt.task || {};
  const verification = receipt.verification || {};
  const payment = receipt.payment || {};
  const checks = (Array.isArray(verification.checks) ? verification.checks : [])
    .slice(0, 10)
    .map((check) => {
      const outcome = String(check.status || (check.passed ? "PASS" : "FAIL")).toUpperCase();
      return "- " + String(check.label || check.id || "Check").slice(0, 100) +
        ": " + outcome + ". " + String(check.details || "").slice(0, 180);
    });

  const lines = [
    "Pay-on-Proof task evidence summary",
    "Task ID: " + String(task.id || "not recorded"),
    "Task: " + String(task.title || "Untitled task").slice(0, 120),
    "Agreed task amount: " + String(task.amount || "not recorded") + " " + String(payment.currency || receipt.currency || "USD"),
    "Recorded verification decision: " + String(verification.effectiveDecision || verification.originalDecision || "UNKNOWN"),
    "Verification time: " + String(verification.evaluatedAt || "not recorded"),
    "Buyer contract ID: " + String(task.acceptanceCriteria?.contractId || "not recorded"),
    "Buyer source SHA-256: " + String(task.acceptanceCriteria?.sourceArtifact?.sha256 || "not recorded"),
    "Worker output: " + String(receipt.artifact?.fileName || "not recorded"),
    "Worker output SHA-256: " + String(receipt.artifact?.sha256 || "not recorded"),
    "PayPal authorization ID: " + String(receipt.authorizationId || "not recorded"),
    "PayPal capture ID: " + String(payment.captureId || "not recorded"),
    "Recorded payment status: " + String(payment.captureStatus || payment.outcome || "not recorded"),
    "Recorded verification checks:",
    ...(checks.length ? checks : ["- No individual checks were recorded."]),
    "Integrity note: SHA-256 values identify recorded bytes/snapshots; they do not prove source authenticity, factual truth, or independent delivery.",
    "This is a merchant-prepared summary of local application records, not a PayPal decision or guarantee of dispute outcome.",
  ];

  return lines.join("\n").slice(0, 1900);
}

function createDisputeEvidencePackage({ receipt, dispute, generatedAt = new Date().toISOString() }) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw createError("A Proof Receipt object is required.");
  }
  const receiptCheck = verifyProofReceipt(receipt);
  if (!receiptCheck.valid) {
    throw createError("The Proof Receipt failed integrity verification; refusing to prepare dispute evidence.");
  }
  if (receipt.mode !== "PAYMENT_SESSION" || receipt.payment?.authoritative !== true) {
    throw createError("Simulation-only receipts cannot be used to prepare PayPal dispute evidence.", 409);
  }
  if (receipt.payment?.captureStatus !== "COMPLETED" || !receipt.payment?.captureId) {
    throw createError("Only a confirmed COMPLETED capture can be linked to a PayPal dispute evidence package.", 409);
  }
  if (!dispute || typeof dispute !== "object" || !dispute.dispute_id) {
    throw createError("A PayPal dispute details response is required.");
  }

  const captureId = receipt.payment.captureId;
  const transactions = Array.isArray(dispute.disputed_transactions)
    ? dispute.disputed_transactions : [];
  const matchingTransaction = transactions.find(
    (transaction) => transaction?.seller_transaction_id === captureId
  );
  if (!matchingTransaction) {
    throw createError(
      "The PayPal dispute does not identify this task's recorded capture as its seller transaction. No evidence package was prepared.",
      409
    );
  }

  const requested = requestedSellerEvidence(dispute);
  const requestedEvidenceTypes = [...new Set(
    requested.map((item) => item.evidence_type).filter((value) => typeof value === "string")
  )];
  const provideEvidenceActionAvailable = hasProvideEvidenceAction(dispute);
  const otherEvidenceRequested = requested.some((item) => item.evidence_type === "OTHER");
  const eligibilityReasons = [];
  if (dispute.status !== "WAITING_FOR_SELLER_RESPONSE") {
    eligibilityReasons.push("PayPal is not currently waiting for a seller response.");
  }
  if (!otherEvidenceRequested) {
    eligibilityReasons.push("PayPal has not requested OTHER evidence from the seller. Use only the evidence types PayPal requests.");
  }
  if (!provideEvidenceActionAvailable) {
    eligibilityReasons.push("The dispute response does not expose a provide-evidence action at its current lifecycle stage.");
  }

  const body = {
    schemaVersion: "1.0",
    packageType: "PAYPAL_DISPUTE_EVIDENCE_DRAFT",
    generatedAt,
    dispute: {
      disputeId: dispute.dispute_id,
      reason: dispute.reason || null,
      status: dispute.status || null,
      lifecycleStage: dispute.dispute_life_cycle_stage || null,
      amount: dispute.dispute_amount || null,
      sellerResponseDueDate: dispute.seller_response_due_date || null,
      requestedEvidenceTypes,
      matchedSellerTransactionId: matchingTransaction.seller_transaction_id,
    },
    task: {
      id: receipt.task.id,
      title: receipt.task.title,
      amount: receipt.task.amount,
      acceptanceCriteria: receipt.task.acceptanceCriteria,
      criteriaSha256: receipt.task.criteriaSha256,
    },
    evidence: {
      receiptSha256: receipt.receiptSha256,
      evidenceSha256: receipt.task.evidenceSha256,
      buyerSource: receipt.task.acceptanceCriteria?.sourceArtifact || null,
      workerOutput: receipt.artifact || null,
      verification: receipt.verification,
      payment: receipt.payment,
      events: receipt.events || [],
    },
    merchantNotesDraft: buildMerchantNotes(receipt),
    submissionEligibility: {
      canSubmitOtherEvidenceNote:
        dispute.status === "WAITING_FOR_SELLER_RESPONSE" &&
        otherEvidenceRequested &&
        provideEvidenceActionAvailable,
      reasons: eligibilityReasons,
    },
    embeddedReceipt: receipt,
    limitations: [
      "This package is a merchant evidence-preparation aid, not a determination that a dispute should be won.",
      "The package links a local task record to the PayPal dispute only when seller_transaction_id exactly matches the recorded capture ID.",
      "A receipt hash detects changes to the recorded snapshot; it does not prove source authenticity, factual truth, or independent delivery.",
      "A merchant must review every statement and provide any additional evidence PayPal requests before submission.",
      "PayPal controls dispute adjudication. This package does not guarantee a favorable outcome.",
    ],
  };

  return {
    ...body,
    packageSha256: sha256(body),
  };
}

function verifyDisputeEvidencePackage(evidencePackage) {
  if (!evidencePackage || typeof evidencePackage !== "object" || Array.isArray(evidencePackage)) {
    return { valid: false, receiptValid: false, packageHashValid: false };
  }

  const body = { ...evidencePackage };
  delete body.packageSha256;
  const packageHashValid = typeof evidencePackage.packageSha256 === "string" &&
    evidencePackage.packageSha256 === sha256(body);
  const receiptCheck = verifyProofReceipt(evidencePackage.embeddedReceipt);

  return {
    valid: packageHashValid && receiptCheck.valid,
    receiptValid: receiptCheck.valid,
    packageHashValid,
    receiptChecks: receiptCheck.checks,
  };
}

module.exports = {
  createDisputeEvidencePackage,
  verifyDisputeEvidencePackage,
  buildMerchantNotes,
  hasProvideEvidenceAction,
  requestedSellerEvidence,
};
