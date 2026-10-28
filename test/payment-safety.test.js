"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyCaptureFailure,
  isUnresolvedCapture,
} = require("../lib/payment-safety");

test("capture network failures remain UNKNOWN", () => {
  assert.equal(classifyCaptureFailure(new Error("fetch failed")), "UNKNOWN");
});

test("capture timeout, conflict, throttling, and server errors remain UNKNOWN", () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503]) {
    assert.equal(
      classifyCaptureFailure({ status }),
      "UNKNOWN",
      `HTTP ${status} must remain unresolved`
    );
  }
});

test("definitive client rejection is marked FAILED", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(
      classifyCaptureFailure({ status }),
      "FAILED",
      `HTTP ${status} is a definitive rejection`
    );
  }
});

test("unknown or invalid status is conservative", () => {
  assert.equal(classifyCaptureFailure({ status: "not-a-status" }), "UNKNOWN");
  assert.equal(classifyCaptureFailure({ status: 200 }), "UNKNOWN");
});

test("only in-progress, pending, and unknown attempts are unresolved", () => {
  for (const status of ["IN_PROGRESS", "PENDING", "UNKNOWN"]) {
    assert.equal(isUnresolvedCapture({ status }), true);
  }
  for (const status of ["COMPLETED", "FAILED", "VOIDED"]) {
    assert.equal(isUnresolvedCapture({ status }), false);
  }
  assert.equal(isUnresolvedCapture(null), false);
});
