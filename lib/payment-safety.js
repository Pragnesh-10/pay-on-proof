"use strict";

const AMBIGUOUS_HTTP_STATUSES = new Set([408, 409, 425, 429]);
const UNRESOLVED_CAPTURE_STATUSES = new Set(["IN_PROGRESS", "UNKNOWN", "PENDING"]);

/**
 * An exception during capture does not necessarily mean PayPal did not capture.
 * Keep an amount reserved unless the response is a definitive client rejection.
 * Ambiguous attempts must be reconciled with the same PayPal-Request-Id.
 */
function classifyCaptureFailure(error) {
  const status = Number(error?.status);
  if (!Number.isInteger(status) || status < 400 || status >= 600) {
    return "UNKNOWN";
  }

  if (status >= 500 || AMBIGUOUS_HTTP_STATUSES.has(status)) {
    return "UNKNOWN";
  }

  return "FAILED";
}

function isUnresolvedCapture(capture) {
  return Boolean(
    capture && UNRESOLVED_CAPTURE_STATUSES.has(capture.status)
  );
}

module.exports = {
  classifyCaptureFailure,
  isUnresolvedCapture,
};
