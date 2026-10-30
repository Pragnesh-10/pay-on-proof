"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function getFreePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(baseUrl + route, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const passContent = JSON.stringify([
  { id: "R-101", score: 0.92 },
  { id: "R-102", score: 0.87 },
]);
const passingCriteria = {
  requiredFields: ["id"],
  uniqueField: "id",
  numericFields: ["score"],
  minRows: 2,
};

test("artifact API previews without payment, blocks failed captures, and verifies receipts", {
  timeout: 20000,
}, async (t) => {
  const mockCalls = [];
  let captureCount = 0;
  let authorizationStatus = "CREATED";
  let nextCaptureMode = "normal";
  let voidCount = 0;
  const providerCaptures = new Map();

  const paypalMock = http.createServer(async (req, res) => {
    const body = await readBody(req);
    mockCalls.push({ method: req.method, url: req.url, body, requestId: req.headers["paypal-request-id"] || null });

    if (req.method === "POST" && req.url === "/v1/oauth2/token") {
      return sendJson(res, 200, { access_token: "test-token", expires_in: 3600 });
    }

    if (req.method === "POST" && req.url === "/v2/checkout/orders") {
      return sendJson(res, 201, {
        id: "ORDER_TEST_1",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://example.invalid/approve", method: "GET" }],
      });
    }

    if (req.method === "POST" && req.url === "/v2/checkout/orders/ORDER_TEST_1/authorize") {
      return sendJson(res, 201, {
        id: "ORDER_TEST_1",
        status: "COMPLETED",
        purchase_units: [{
          payments: {
            authorizations: [{
              id: "AUTH_TEST_1",
              status: authorizationStatus,
              amount: { currency_code: "USD", value: "50.00" },
            }],
          },
        }],
      });
    }

    if (req.method === "GET" && req.url === "/v2/payments/authorizations/AUTH_TEST_1") {
      return sendJson(res, 200, {
        id: "AUTH_TEST_1",
        status: authorizationStatus,
        amount: { currency_code: "USD", value: "50.00" },
      });
    }

    if (req.method === "GET" && req.url.startsWith("/v2/payments/captures/")) {
      const captureId = decodeURIComponent(req.url.split("/").pop());
      const capture = [...providerCaptures.values()].find((item) => item.id === captureId);
      if (!capture) return sendJson(res, 404, { name: "RESOURCE_NOT_FOUND" });
      return sendJson(res, 200, capture);
    }

    if (req.method === "POST" && req.url === "/v2/payments/authorizations/AUTH_TEST_1/capture") {
      const requestId = req.headers["paypal-request-id"];
      if (providerCaptures.has(requestId)) {
        // Simulate provider idempotency: replay returns the original outcome.
        return sendJson(res, 201, providerCaptures.get(requestId));
      }

      captureCount += 1;
      authorizationStatus = "PARTIALLY_CAPTURED";
      const capture = {
        id: "CAPTURE_TEST_" + captureCount,
        status: nextCaptureMode === "pending" ? "PENDING" : "COMPLETED",
        amount: body.amount,
      };
      providerCaptures.set(requestId, capture);

      if (nextCaptureMode === "drop-response") {
        // The provider side effect occurs, but the client never gets the response.
        nextCaptureMode = "normal";
        res.destroy();
        return;
      }
      return sendJson(res, 201, capture);
    }

    if (req.method === "POST" && req.url === "/v2/payments/authorizations/AUTH_TEST_1/void") {
      voidCount += 1;
      authorizationStatus = "VOIDED";
      return sendJson(res, 200, { id: "AUTH_TEST_1", status: "VOIDED" });
    }

    return sendJson(res, 404, { name: "RESOURCE_NOT_FOUND", message: "Unexpected mock request: " + req.method + " " + req.url });
  });

  const paypalPort = await listen(paypalMock);
  const appPort = await getFreePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pay-on-proof-test-"));
  const stateFile = path.join(tempDir, "state.json");
  const appBaseUrl = "http://127.0.0.1:" + appPort;

  const appProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(appPort),
      PAYPAL_BASE_URL: "http://127.0.0.1:" + paypalPort,
      PAYPAL_CLIENT_ID: "test-client",
      PAYPAL_CLIENT_SECRET: "test-secret",
      PAYONPROOF_STATE_FILE: stateFile,
      PAYONPROOF_TEMP_FILE: path.join(tempDir, "state.tmp"),
      GROQ_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childOutput = "";
  appProcess.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
  appProcess.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });

  t.after(async () => {
    if (appProcess.exitCode === null && appProcess.signalCode === null) {
      appProcess.kill("SIGTERM");
      await Promise.race([
        once(appProcess, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    await new Promise((resolve) => paypalMock.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (appProcess.exitCode !== null) break;
    try {
      const response = await fetch(appBaseUrl + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {
      // The child may still be binding its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "application did not start: " + childOutput);

  // Preview must not call any PayPal endpoint.
  const beforePreviewCalls = mockCalls.length;
  const preview = await requestJson(appBaseUrl, "/api/artifacts/verify", {
    method: "POST",
    body: JSON.stringify({
      fileName: "results.json",
      format: "json",
      content: passContent,
      amount: "15.00",
      criteria: passingCriteria,
    }),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.task.verification, "PASS");
  assert.equal(preview.data.paymentSideEffects, false);
  assert.equal(preview.data.proofReceipt.mode, "SIMULATION_ONLY");
  assert.equal(preview.data.actualCapturedAmount, "0.00");
  assert.equal(mockCalls.length, beforePreviewCalls);

  const malformedPreview = await requestJson(appBaseUrl, "/api/artifacts/verify", {
    method: "POST",
    body: JSON.stringify({
      fileName: "broken.json",
      format: "json",
      content: "{",
      criteria: { requiredFields: ["id"] },
    }),
  });
  assert.equal(malformedPreview.status, 200);
  assert.equal(malformedPreview.data.task.verification, "REVIEW");

  const order = await requestJson(appBaseUrl, "/api/orders", { method: "POST" });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  assert.equal(order.data.orderId, "ORDER_TEST_1");

  const authorized = await requestJson(appBaseUrl, "/api/orders/ORDER_TEST_1/authorize", {
    method: "POST",
    body: "{}",
  });
  assert.equal(authorized.status, 200, JSON.stringify(authorized.data));
  assert.equal(authorized.data.authorizationId, "AUTH_TEST_1");

  const savedPass = await requestJson(appBaseUrl, "/api/authorizations/AUTH_TEST_1/artifact-tasks", {
    method: "POST",
    body: JSON.stringify({
      fileName: "results.json",
      format: "json",
      content: passContent,
      amount: "15.00",
      criteria: passingCriteria,
    }),
  });
  assert.equal(savedPass.status, 200, JSON.stringify(savedPass.data));
  assert.equal(savedPass.data.task.verification, "PASS");
  assert.equal(savedPass.data.task.captureStatus, "NOT_ATTEMPTED");
  assert.equal(captureCount, 0, "saving an artifact task must not capture funds");

  const savedFail = await requestJson(appBaseUrl, "/api/authorizations/AUTH_TEST_1/artifact-tasks", {
    method: "POST",
    body: JSON.stringify({
      fileName: "failed.json",
      format: "json",
      content: JSON.stringify([{ score: "not-numeric" }]),
      amount: "10.00",
      criteria: { requiredFields: ["id"], numericFields: ["score"] },
    }),
  });
  assert.equal(savedFail.status, 200);
  assert.equal(savedFail.data.task.verification, "FAIL");

  const blockedCapture = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" + encodeURIComponent(savedFail.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(blockedCapture.status, 409);
  assert.equal(captureCount, 0, "a failed artifact task must never trigger capture");

  const captured = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" + encodeURIComponent(savedPass.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(captured.status, 200, JSON.stringify(captured.data));
  assert.equal(captured.data.task.captureStatus, "COMPLETED");
  assert.equal(captured.data.paymentOutcome, "CAPTURE_COMPLETED");
  assert.equal(captureCount, 1);

  const buyerSource = JSON.stringify([
    { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget" },
    { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable" },
  ]);
  const buyerContract = {
    keyField: "id",
    preserveFields: ["quantity", "unitPrice", "description"],
    derivedFields: [{ field: "lineTotal", operation: "multiply", inputs: ["quantity", "unitPrice"] }],
  };
  const createReferenceContract = async (amount = "10.00") => requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/reference-contracts",
    {
      method: "POST",
      body: JSON.stringify({
        title: "Reconcile invoice line totals",
        amount,
        sourceFileName: "buyer-invoices.json",
        sourceFormat: "json",
        sourceContent: buyerSource,
        contract: buyerContract,
      }),
    },
  );

  const invalidContract = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/reference-contracts",
    {
      method: "POST",
      body: JSON.stringify({
        amount: "10.00",
        sourceFileName: "duplicate-source.json",
        sourceFormat: "json",
        sourceContent: JSON.stringify([
          { id: "INV-1", quantity: 3, unitPrice: 12.5 },
          { id: "INV-1", quantity: 2, unitPrice: 7 },
        ]),
        contract: buyerContract,
      }),
    },
  );
  assert.equal(invalidContract.status, 400, "buyer source with duplicate keys must not become an accepted contract");

  const failContract = await createReferenceContract();
  assert.equal(failContract.status, 200, JSON.stringify(failContract.data));
  assert.equal(failContract.data.contract.status, "OPEN");
  assert.equal("sourceRecords" in failContract.data.contract, false, "raw buyer rows must not be returned to the browser");
  const badWorkerOutput = JSON.stringify([
    { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget", lineTotal: 999 },
    { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable", lineTotal: 14 },
  ]);
  const rejectedSubmission = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/reference-contracts/" +
      encodeURIComponent(failContract.data.contract.contractId) + "/submit",
    {
      method: "POST",
      body: JSON.stringify({
        outputFileName: "worker-output.json",
        outputFormat: "json",
        outputContent: badWorkerOutput,
        contract: { keyField: "fake", derivedFields: [] },
        sourceContent: JSON.stringify([{ id: "fake", quantity: 0, unitPrice: 0 }]),
      }),
    },
  );
  assert.equal(rejectedSubmission.status, 200, JSON.stringify(rejectedSubmission.data));
  assert.equal(rejectedSubmission.data.task.verification, "FAIL");
  assert.equal(rejectedSubmission.data.task.verificationSource, "reference-backed");
  assert.equal(
    rejectedSubmission.data.checks.find((check) => check.id === "derived:lineTotal").passed,
    false,
    "worker output must be checked against the stored buyer formula, not submitted booleans",
  );
  assert.equal(captureCount, 1, "verification must not call PayPal");
  const blockedReferenceCapture = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" +
      encodeURIComponent(rejectedSubmission.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(blockedReferenceCapture.status, 409);
  assert.equal(captureCount, 1, "failed reference-backed output must not be captured");

  const replaySubmission = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/reference-contracts/" +
      encodeURIComponent(failContract.data.contract.contractId) + "/submit",
    {
      method: "POST",
      body: JSON.stringify({
        outputFileName: "second-attempt.json",
        outputFormat: "json",
        outputContent: JSON.stringify([]),
      }),
    },
  );
  assert.equal(replaySubmission.status, 409, "a frozen contract accepts only one worker submission");

  const passContract = await createReferenceContract("11.00");
  assert.equal(passContract.status, 200);
  const goodWorkerOutput = JSON.stringify([
    { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget", lineTotal: 37.5 },
    { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable", lineTotal: 14 },
  ]);
  const acceptedSubmission = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/reference-contracts/" +
      encodeURIComponent(passContract.data.contract.contractId) + "/submit",
    {
      method: "POST",
      body: JSON.stringify({
        outputFileName: "worker-output.json",
        outputFormat: "json",
        outputContent: goodWorkerOutput,
      }),
    },
  );
  assert.equal(acceptedSubmission.status, 200, JSON.stringify(acceptedSubmission.data));
  assert.equal(acceptedSubmission.data.task.verification, "PASS");
  assert.equal(acceptedSubmission.data.paymentOutcome, "NOT_ATTEMPTED");
  assert.equal(captureCount, 1, "accepted verification does not itself capture funds");
  assert.ok(acceptedSubmission.data.task.acceptance.sourceArtifact.sha256);
  assert.ok(acceptedSubmission.data.task.evidence.outputArtifactSha256);

  const referenceCapture = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" +
      encodeURIComponent(acceptedSubmission.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(referenceCapture.status, 200, JSON.stringify(referenceCapture.data));
  assert.equal(referenceCapture.data.task.captureStatus, "COMPLETED");
  assert.equal(referenceCapture.data.paymentOutcome, "CAPTURE_COMPLETED");
  assert.equal(captureCount, 2, "only the independently verified PASS task reaches PayPal");

  const referenceReceiptCheck = await requestJson(appBaseUrl, "/api/receipts/verify", {
    method: "POST",
    body: JSON.stringify({ receipt: referenceCapture.data.proofReceipt, artifactContent: goodWorkerOutput }),
  });
  assert.equal(referenceReceiptCheck.status, 200);
  assert.equal(referenceReceiptCheck.data.valid, true, JSON.stringify(referenceReceiptCheck.data));
  assert.equal(referenceReceiptCheck.data.artifactContentChecked, true);

  const duplicateCapture = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" + encodeURIComponent(savedPass.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(duplicateCapture.status, 409);
  assert.equal(captureCount, 2, "duplicate task capture must be blocked");

  const receiptCheck = await requestJson(appBaseUrl, "/api/receipts/verify", {
    method: "POST",
    body: JSON.stringify({ receipt: captured.data.proofReceipt, artifactContent: passContent }),
  });
  assert.equal(receiptCheck.status, 200);
  assert.equal(receiptCheck.data.valid, true, JSON.stringify(receiptCheck.data));
  assert.equal(receiptCheck.data.artifactContentChecked, true);

  const wrongArtifactCheck = await requestJson(appBaseUrl, "/api/receipts/verify", {
    method: "POST",
    body: JSON.stringify({ receipt: captured.data.proofReceipt, artifactContent: passContent + " " }),
  });
  assert.equal(wrongArtifactCheck.status, 200);
  assert.equal(wrongArtifactCheck.data.valid, false);
  assert.equal(
    wrongArtifactCheck.data.checks.find((check) => check.id === "artifact-content").status,
    "FAIL",
  );

  // Failure injection: provider captures the payment but drops the response.
  const timeoutContent = JSON.stringify([
    { id: "R-301", score: 0.73 },
    { id: "R-302", score: 0.81 },
  ]);
  const timeoutTask = await requestJson(appBaseUrl, "/api/authorizations/AUTH_TEST_1/artifact-tasks", {
    method: "POST",
    body: JSON.stringify({
      fileName: "timeout-case.json",
      format: "json",
      content: timeoutContent,
      amount: "5.00",
      criteria: passingCriteria,
    }),
  });
  assert.equal(timeoutTask.status, 200);
  nextCaptureMode = "drop-response";
  const timeoutCapture = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" + encodeURIComponent(timeoutTask.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(timeoutCapture.status, 200);
  assert.equal(timeoutCapture.data.task.captureStatus, "UNKNOWN");
  assert.equal(timeoutCapture.data.paymentOutcome, "OUTCOME_UNCERTAIN");
  assert.equal(captureCount, 3, "the mock provider accepted the capture despite dropping its response");

  const blockedVoidDuringUnknown = await requestJson(
    appBaseUrl, "/api/authorizations/AUTH_TEST_1/void", { method: "POST", body: "{}" },
  );
  assert.equal(blockedVoidDuringUnknown.status, 409);
  assert.equal(voidCount, 0, "void must be blocked while a capture is unresolved");

  const timeoutRequestId = timeoutCapture.data.task.events.find(
    (event) => event.type === "CAPTURE_ATTEMPT_STARTED",
  ).requestId;
  const beforeReplayCount = captureCount;
  const reconciledTimeout = await requestJson(
    appBaseUrl, "/api/authorizations/AUTH_TEST_1/reconcile", { method: "POST", body: "{}" },
  );
  assert.equal(reconciledTimeout.status, 200);
  assert.equal(reconciledTimeout.data.unresolvedCount, 0);
  assert.equal(reconciledTimeout.data.tasks.find((item) => item.taskId === timeoutTask.data.task.taskId).captureStatus, "COMPLETED");
  assert.equal(captureCount, beforeReplayCount, "reconciliation replay must not create another provider capture");
  const replayCalls = mockCalls.filter((call) =>
    call.method === "POST" &&
    call.url === "/v2/payments/authorizations/AUTH_TEST_1/capture" &&
    call.requestId === timeoutRequestId
  );
  assert.equal(replayCalls.length, 2, "reconciliation must replay the exact original idempotency key");

  // Failure injection: PayPal returns PENDING, so the capture remains unresolved.
  const pendingContent = JSON.stringify([
    { id: "R-401", score: 0.65 },
    { id: "R-402", score: 0.88 },
  ]);
  const pendingTask = await requestJson(appBaseUrl, "/api/authorizations/AUTH_TEST_1/artifact-tasks", {
    method: "POST",
    body: JSON.stringify({
      fileName: "pending-case.json",
      format: "json",
      content: pendingContent,
      amount: "4.00",
      criteria: passingCriteria,
    }),
  });
  assert.equal(pendingTask.status, 200);
  nextCaptureMode = "pending";
  const pendingCapture = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" + encodeURIComponent(pendingTask.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(pendingCapture.status, 200);
  assert.equal(pendingCapture.data.task.captureStatus, "PENDING");
  assert.equal(captureCount, 4);

  const blockedVoidDuringPending = await requestJson(
    appBaseUrl, "/api/authorizations/AUTH_TEST_1/void", { method: "POST", body: "{}" },
  );
  assert.equal(blockedVoidDuringPending.status, 409);
  assert.equal(voidCount, 0, "void must remain blocked while a provider capture is pending");

  const pendingCaptureRecord = [...providerCaptures.values()].find(
    (item) => item.id === pendingCapture.data.task.captureId,
  );
  assert.ok(pendingCaptureRecord);
  pendingCaptureRecord.status = "COMPLETED";
  const reconciledPending = await requestJson(
    appBaseUrl, "/api/authorizations/AUTH_TEST_1/reconcile", { method: "POST", body: "{}" },
  );
  assert.equal(reconciledPending.status, 200);
  assert.equal(reconciledPending.data.unresolvedCount, 0);
  assert.equal(reconciledPending.data.tasks.find((item) => item.taskId === pendingTask.data.task.taskId).captureStatus, "COMPLETED");
  assert.equal(captureCount, 4, "checking a known capture ID must not create another capture");

  const voidAfterResolution = await requestJson(
    appBaseUrl, "/api/authorizations/AUTH_TEST_1/void", { method: "POST", body: "{}" },
  );
  assert.equal(voidAfterResolution.status, 200, JSON.stringify(voidAfterResolution.data));
  assert.equal(voidAfterResolution.data.status, "VOIDED");
  assert.equal(voidCount, 1, "void should be requested only after all captures resolve");
});
