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

  const paypalMock = http.createServer(async (req, res) => {
    const body = await readBody(req);
    mockCalls.push({ method: req.method, url: req.url, body });

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

    if (req.method === "POST" && req.url === "/v2/payments/authorizations/AUTH_TEST_1/capture") {
      captureCount += 1;
      authorizationStatus = "PARTIALLY_CAPTURED";
      return sendJson(res, 201, {
        id: "CAPTURE_TEST_" + captureCount,
        status: "COMPLETED",
        amount: body.amount,
      });
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

  const duplicateCapture = await requestJson(
    appBaseUrl,
    "/api/authorizations/AUTH_TEST_1/artifact-tasks/" + encodeURIComponent(savedPass.data.task.taskId) + "/capture",
    { method: "POST", body: "{}" },
  );
  assert.equal(duplicateCapture.status, 409);
  assert.equal(captureCount, 1, "duplicate task capture must be blocked");

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
});
