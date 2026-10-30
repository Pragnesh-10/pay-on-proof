"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProofReceipt } = require("../lib/proof-receipt");
const {
  createDisputeEvidencePackage,
  verifyDisputeEvidencePackage,
} = require("../lib/dispute-evidence");

function receipt(overrides = {}) {
  const task = {
    taskId: "reference-task-1",
    title: "Invoice reconciliation",
    amount: "10.00",
    acceptance: {
      contractId: "contract-1",
      sourceArtifact: {
        fileName: "buyer-invoices.json",
        format: "json",
        sha256: "a".repeat(64),
        recordCount: 2,
      },
      criteria: {
        keyField: "id",
        preserveFields: ["quantity", "unitPrice"],
        derivedFields: [
          { field: "lineTotal", operation: "multiply", inputs: ["quantity", "unitPrice"] },
        ],
      },
    },
    evidence: {
      sourceArtifactSha256: "a".repeat(64),
      outputArtifactSha256: "b".repeat(64),
    },
    verification: "PASS",
    verificationSource: "reference-backed",
    verifierVersion: "1.1.0",
    verificationChecks: [
      { id: "derived:lineTotal", label: "Calculated field", passed: true, details: "Every total matches." },
    ],
    reason: "All contracted checks passed.",
    evaluatedAt: "2026-10-30T10:00:00.000Z",
    artifact: {
      fileName: "worker-output.json",
      format: "json",
      sha256: "b".repeat(64),
      recordCount: 2,
    },
    captureId: "CAPTURE-123",
    captureStatus: "COMPLETED",
    events: [{ type: "CAPTURE_RESPONSE", status: "COMPLETED", captureId: "CAPTURE-123" }],
    ...overrides,
  };
  return createProofReceipt({
    authorizationId: "AUTH-123",
    currency: "USD",
    authorizationStatus: "PARTIALLY_CAPTURED",
    task,
    generatedAt: "2026-10-30T10:01:00.000Z",
  });
}

function dispute(overrides = {}) {
  return {
    dispute_id: "PP-D-123",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_life_cycle_stage: "INQUIRY",
    dispute_amount: { currency_code: "USD", value: "10.00" },
    seller_response_due_date: "2026-11-05T00:00:00.000Z",
    disputed_transactions: [{
      seller_transaction_id: "CAPTURE-123",
      transaction_status: "COMPLETED",
      gross_amount: { currency_code: "USD", value: "10.00" },
    }],
    evidences: [{
      evidence_type: "OTHER",
      source: "REQUESTED_FROM_SELLER",
      dispute_life_cycle_stage: "INQUIRY",
    }],
    links: [{ rel: "provide-evidence", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-123/provide-evidence", method: "POST" }],
    ...overrides,
  };
}

test("creates dispute evidence package only for a matching completed PayPal capture", () => {
  const result = createDisputeEvidencePackage({
    receipt: receipt(),
    dispute: dispute(),
    generatedAt: "2026-10-30T10:02:00.000Z",
  });

  assert.equal(result.packageType, "PAYPAL_DISPUTE_EVIDENCE_DRAFT");
  assert.equal(result.dispute.disputeId, "PP-D-123");
  assert.equal(result.dispute.matchedSellerTransactionId, "CAPTURE-123");
  assert.equal(result.submissionEligibility.canSubmitOtherEvidenceNote, true);
  assert.match(result.merchantNotesDraft, /Buyer contract ID: contract-1/);
  assert.match(result.merchantNotesDraft, /Worker output SHA-256:/);
  assert.ok(result.merchantNotesDraft.length <= 2000);
  assert.equal(verifyDisputeEvidencePackage(result).valid, true);
});

test("dispute evidence package rejects a dispute for a different payment capture", () => {
  assert.throws(
    () => createDisputeEvidencePackage({
      receipt: receipt(),
      dispute: dispute({
        disputed_transactions: [{ seller_transaction_id: "SOME-OTHER-CAPTURE" }],
      }),
    }),
    /does not identify this task's recorded capture/
  );
});

test("package stays review-only when PayPal is not awaiting seller OTHER evidence", () => {
  const result = createDisputeEvidencePackage({
    receipt: receipt(),
    dispute: dispute({
      status: "UNDER_REVIEW",
      evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" }],
      links: [],
    }),
  });

  assert.equal(result.submissionEligibility.canSubmitOtherEvidenceNote, false);
  assert.ok(result.submissionEligibility.reasons.length >= 3);
});

test("simulation and non-completed receipt cannot become dispute evidence", () => {
  const simulated = createProofReceipt({
    task: {
      taskId: "simulation",
      title: "Simulation",
      verification: "PASS",
      captureStatus: "NOT_ATTEMPTED",
    },
    simulated: true,
  });
  assert.throws(
    () => createDisputeEvidencePackage({ receipt: simulated, dispute: dispute() }),
    /Simulation-only/
  );

  assert.throws(
    () => createDisputeEvidencePackage({
      receipt: receipt({ captureStatus: "PENDING" }),
      dispute: dispute(),
    }),
    /Only a confirmed COMPLETED capture/
  );
});

test("package integrity verifier catches changes to notes or embedded receipt", () => {
  const evidencePackage = createDisputeEvidencePackage({
    receipt: receipt(),
    dispute: dispute(),
    generatedAt: "2026-10-30T10:02:00.000Z",
  });
  const changed = JSON.parse(JSON.stringify(evidencePackage));
  changed.merchantNotesDraft += "\nAltered note";
  assert.equal(verifyDisputeEvidencePackage(changed).valid, false);

  const changedReceipt = JSON.parse(JSON.stringify(evidencePackage));
  changedReceipt.embeddedReceipt.payment.amount = "999.00";
  assert.equal(verifyDisputeEvidencePackage(changedReceipt).valid, false);
});
