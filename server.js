
require("dotenv").config();

const express = require("express");
const {
  verifyDeterministicTask,
  verifyWithGroq,
} = require("./lib/verifier");
const { createVerificationPreview } = require("./lib/verification-preview");
const {
  classifyCaptureFailure,
  isUnresolvedCapture,
} = require("./lib/payment-safety");
const { createProofReceipt, verifyProofReceipt, sha256 } = require("./lib/proof-receipt");
const { verifyArtifact } = require("./lib/artifact-verifier");
const { listScenarios, simulateScenario } = require("./lib/scenario-simulator");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "public")));
const {
  PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PORT = 3000,
} = process.env;

const LOCAL_BASE_URL = `http://127.0.0.1:${PORT}`;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  throw new Error("Missing PayPal REST credentials in .env");
}

const STATE_FILE = process.env.PAYONPROOF_STATE_FILE ||
  path.join(__dirname, ".pay-on-proof-state.json");
const TEMP_FILE = process.env.PAYONPROOF_TEMP_FILE ||
  path.join(path.dirname(STATE_FILE), ".pay-on-proof-state.tmp");

function emptyState() {
  return { orders: {}, authorizations: {} };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      orders: parsed.orders || {},
      authorizations: parsed.authorizations || {},
    };
  } catch {
    throw new Error(
      "Cannot read payment state file. Do not delete it; inspect or restore it first."
    );
  }
}

let state = loadState();

function saveState() {
  fs.writeFileSync(TEMP_FILE, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(TEMP_FILE, STATE_FILE);
}

// Serialize state-changing routes within this single Node.js process.
let mutationQueue = Promise.resolve();

function serializeMutation(work) {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.catch(() => {});
  return result;
}

async function paypalRequest(
  apiPath,
  { method = "GET", body, requestId } = {}
) {
  const tokenResponse = await fetch(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }
  );

  const tokenData = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok) {
    const error = new Error(
      `PayPal OAuth failed (${tokenResponse.status})`
    );
    error.status = tokenResponse.status;
    error.details = tokenData;
    throw error;
  }

  const headers = {
    Authorization: `Bearer ${tokenData.access_token}`,
    "Content-Type": "application/json",
  };

  if (requestId) {
    headers["PayPal-Request-Id"] = requestId;
  }

  const response = await fetch(`${PAYPAL_BASE_URL}${apiPath}`, {
    method,
    headers,
    ...(body !== undefined
      ? { body: JSON.stringify(body) }
      : {}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      `PayPal API failed (${response.status})`
    );
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function sendError(res, error) {
  console.error(error.message);

  res.status(error.status || 500).json({
    error: error.message,
    details: error.details || undefined,
  });
}

function validId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function moneyToCents(value) {
  return Math.round(Number(value) * 100);
}

function centsToMoney(cents) {
  return (cents / 100).toFixed(2);
}

function captureTotals(authRecord) {
  let committedCents = 0;
  let uncertainCents = 0;

  for (const capture of authRecord.captures) {
    const cents = moneyToCents(capture.amount);

    if (capture.status === "COMPLETED" || capture.status === "PENDING") {
      committedCents += cents;
    } else if (
      capture.status === "IN_PROGRESS" ||
      capture.status === "UNKNOWN"
    ) {
      // Reserve the amount until its outcome is resolved.
      uncertainCents += cents;
    }
  }

  return { committedCents, uncertainCents };
}

// API health and verifier mode. Never return secret configuration.
app.get("/api/health", (_req, res) => {
  const aiConfigured = Boolean(process.env.GROQ_API_KEY);
  res.json({
    name: "Pay-on-Proof",
    environment: "sandbox",
    status: "running",
    verifierMode: aiConfigured ? "hybrid" : "deterministic",
    aiModel: aiConfigured
      ? process.env.GROQ_MODEL || "openai/gpt-oss-20b"
      : null,
  });
});

// Kept for command-line health checks; the static dashboard is served at /.
app.get("/api", (_req, res) => {
  res.json({
    name: "Pay-on-Proof",
    environment: "sandbox",
    status: "running",
  });
});

// Create a $50 USD authorization order.
app.post("/api/orders", async (_req, res) => {
  try {
    const order = await paypalRequest("/v2/checkout/orders", {
      method: "POST",
      requestId: crypto.randomUUID(),
      body: {
        intent: "AUTHORIZE",
        application_context: {
          return_url: `${LOCAL_BASE_URL}/checkout/return`,
          cancel_url: `${LOCAL_BASE_URL}/checkout/cancel`,
        },
        purchase_units: [
          {
            reference_id: "pay-on-proof-demo",
            description: "Pay-on-Proof sandbox test",
            amount: {
              currency_code: "USD",
              value: "50.00",
            },
          },
        ],
      },
    });

    const approvalLink = order.links?.find(
      (link) =>
        link.rel === "approve" || link.rel === "payer-action"
    );

    await serializeMutation(async () => {
      state.orders[order.id] = {
        orderId: order.id,
        status: order.status,
        amount: "50.00",
        currency: "USD",
        authorizationId: null,
        createdAt: new Date().toISOString(),
      };
      saveState();
    });

    res.json({
      orderId: order.id,
      status: order.status,
      approvalUrl: approvalLink?.href || null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Return from buyer checkout.
// This page does NOT authorize a payment automatically.
app.get("/checkout/return", (req, res) => {
  const orderId = req.query.token;

  if (typeof orderId !== "string" || !validId(orderId)) {
    return res.status(400).send("Missing or invalid order token.");
  }

  res.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Pay-on-Proof</title>
      </head>
      <body style="font-family:system-ui;max-width:650px;margin:50px auto;padding:20px">
        <h1>Returned from PayPal</h1>
        <p>Checkout has returned to the application.</p>
        <p>This page does not prove approval or authorization.</p>
        <p>Order ID: <code>${orderId}</code></p>
        <p>Return to the terminal and run the authorize endpoint for this order.</p>
      </body>
    </html>
  `);
});

app.get("/checkout/cancel", (_req, res) => {
  res.type("html").send(
    "<h1>Checkout cancelled</h1><p>No authorization was requested by this page.</p>"
  );
});

// Authorize an approved order and persist its authorization ID.
app.post("/api/orders/:orderId/authorize", async (req, res) => {
  const { orderId } = req.params;

  if (!validId(orderId)) {
    return res.status(400).json({ error: "Invalid order ID." });
  }

  try {
    const existing = state.orders[orderId];

    if (!existing) {
      return res.status(404).json({
        error:
          "Order is not recorded in local state. Use an order created by this server.",
      });
    }

    if (existing.authorizationId) {
      return res.status(409).json({
        error: "This order already has a recorded authorization.",
        authorizationId: existing.authorizationId,
      });
    }

    const result = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
      {
        method: "POST",
        requestId: `authorize-${orderId}`,
        body: {},
      }
    );

    const authorization =
      result.purchase_units?.[0]?.payments?.authorizations?.[0];

    if (!authorization?.id) {
      return res.status(502).json({
        error: "PayPal returned no authorization ID.",
        orderStatus: result.status,
      });
    }

    await serializeMutation(async () => {
      state.orders[orderId].status = result.status;
      state.orders[orderId].authorizationId = authorization.id;

      state.authorizations[authorization.id] = {
        authorizationId: authorization.id,
        orderId,
        currency: authorization.amount?.currency_code || "USD",
        authorizedAmount: authorization.amount?.value || "50.00",
        status: authorization.status,
        captures: [],
        voidRequested: false,
        updatedAt: new Date().toISOString(),
      };

      saveState();
    });

    res.json({
      orderId,
      orderStatus: result.status,
      authorizationId: authorization.id,
      authorizationStatus: authorization.status,
      amount: authorization.amount,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Fetch the authoritative current authorization status from PayPal.
app.get(
  "/api/authorizations/:authorizationId",
  async (req, res) => {
    const { authorizationId } = req.params;

    if (!validId(authorizationId)) {
      return res.status(400).json({
        error: "Invalid authorization ID.",
      });
    }

    try {
      const remote = await paypalRequest(
        `/v2/payments/authorizations/${encodeURIComponent(
          authorizationId
        )}`
      );

      await serializeMutation(async () => {
        const local = state.authorizations[authorizationId];

        if (local) {
          local.status = remote.status;
          local.updatedAt = new Date().toISOString();
          saveState();
        }
      });

      res.json({
        authorizationId: remote.id,
        status: remote.status,
        amount: remote.amount,
        expirationTime: remote.expiration_time,
        captureTotals: state.authorizations[authorizationId]
          ? {
              ...captureTotals(
                state.authorizations[authorizationId]
              ),
            }
          : null,
        paypalCaptures: remote
          .links?.filter((link) => link.rel === "capture")
          .map((link) => ({
            href: link.href,
            method: link.method,
          })) || [],
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

const DEMO_TASKS = [
  {
    id: "task-a",
    title: "Generate a report",
    amount: "15.00",
    acceptance: "Report contains a title and a meaningful summary of the result.",
    evidence: {
      title: "Quarterly Analysis",
      summary: "Revenue increased by 8% compared with the previous quarter.",
    },
    shouldPass: true,
  },
  {
    id: "task-b",
    title: "Validate results",
    amount: "20.00",
    acceptance: "All required checks must pass.",
    evidence: {
      checks: [
        { name: "schema", passed: true },
        { name: "data-quality", passed: true },
        { name: "consistency", passed: true },
      ],
    },
    shouldPass: true,
  },
  {
    id: "task-c",
    title: "Produce a summary",
    amount: "10.00",
    acceptance: "The summary must contain a conclusion.",
    evidence: {
      title: "Short Summary",
      conclusion: "",
    },
    shouldPass: false,
  },
];

async function evaluateDemoTask(task) {
  // Deterministic checks are mandatory and run before any AI request.
  const deterministic = verifyDeterministicTask(task);
  if (deterministic.decision !== "PASS") {
    return deterministic;
  }

  // Task B/C have explicit machine-checkable acceptance tests.
  // Task A also needs semantic assessment when an API key is configured.
  if (task.id !== "task-a") {
    return deterministic;
  }

  if (!process.env.GROQ_API_KEY) {
    return {
      ...deterministic,
      reason:
        deterministic.reason +
        " AI is not configured; deterministic mode was used.",
    };
  }

  try {
    const semantic = await verifyWithGroq(task);
    if (semantic.decision !== "PASS") {
      return semantic;
    }

    return {
      ...semantic,
      reason:
        semantic.reason +
        " Required report fields also passed deterministic checks.",
    };
  } catch (error) {
    // Fail closed: AI outages must never silently become a PASS.
    console.error("Groq verifier unavailable:", error.message);
    return {
      decision: "REVIEW",
      passed: false,
      reason:
        "AI verification is unavailable; human review is required and no capture will be made.",
      source: "groq",
      model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    };
  }
}

// Preview task verification without querying or mutating PayPal resources.
app.post("/api/verification-preview", async (_req, res) => {
  try {
    const preview = await createVerificationPreview(
      DEMO_TASKS,
      evaluateDemoTask,
      {
        mode: process.env.GROQ_API_KEY ? "hybrid" : "deterministic",
      }
    );
    res.json(preview);
  } catch (error) {
    sendError(res, error);
  }
});

// Payment-free scenario simulator. These are explicitly hypothetical outcomes.

function buildArtifactTask(result, amount = "0.00") {
  const taskId = "artifact-" + sha256(JSON.stringify({
    fileSha256: result.artifact.sha256,
    criteria: result.criteria,
  })).slice(0, 16);
  const evaluatedAt = new Date().toISOString();
  return {
    taskId,
    title: result.artifact.fileName,
    amount,
    acceptance: result.criteria,
    evidence: {
      fileName: result.artifact.fileName,
      format: result.artifact.format,
      artifactSha256: result.artifact.sha256,
      recordCount: result.artifact.recordCount,
      rowsPreview: result.recordsPreview || [],
      parsed: result.parsed,
    },
    verification: result.decision,
    verificationSource: "deterministic-artifact",
    verificationModel: null,
    verifierVersion: "1.0.0",
    verificationChecks: result.checks,
    reason: result.reason,
    captureId: null,
    captureStatus: "NOT_ATTEMPTED",
    evaluatedAt,
    review: null,
    artifact: { ...result.artifact },
    events: [{
      type: "ARTIFACT_VERIFICATION_COMPLETED",
      at: evaluatedAt,
      decision: result.decision,
      artifactSha256: result.artifact.sha256,
    }],
  };
}

function parseArtifactAmount(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError("A task amount is required before saving an artifact to an authorization.");
    return "0.00";
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(value) ||
      moneyToCents(value) < (required ? 1 : 0)) {
    throw new TypeError('amount must be a decimal string such as "15.00".');
  }
  return value;
}

function runArtifactVerification(body) {
  return verifyArtifact({
    fileName: body.fileName,
    format: body.format,
    content: body.content,
    criteria: body.criteria || {},
  });
}

// Preview only: this route never calls PayPal payment endpoints.
app.post("/api/artifacts/verify", (req, res) => {
  try {
    const body = req.body || {};
    const result = runArtifactVerification(body);
    const amount = parseArtifactAmount(body.amount);
    const task = buildArtifactTask(result, amount);
    const proofReceipt = createProofReceipt({ task, simulated: true });
    res.json({
      mode: "ARTIFACT_VERIFICATION_ONLY",
      paymentSideEffects: false,
      actualCapturedAmount: "0.00",
      task,
      checks: result.checks,
      proofReceipt,
      message: result.reason + " This preview does not contact PayPal payment endpoints.",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Record a verified artifact task on a selected sandbox authorization. This
// operation still does not capture funds.
app.post("/api/authorizations/:authorizationId/artifact-tasks", async (req, res) => {
  const { authorizationId } = req.params;
  if (!validId(authorizationId)) {
    return res.status(400).json({ error: "Invalid authorization ID." });
  }

  try {
    const body = req.body || {};
    const amount = parseArtifactAmount(body.amount, { required: true });
    const verification = runArtifactVerification(body);
    const candidate = buildArtifactTask(verification, amount);

    const result = await serializeMutation(async () => {
      const auth = state.authorizations[authorizationId];
      if (!auth) {
        const error = new Error("Authorization is not recorded locally. Create and authorize a fresh sandbox order first.");
        error.status = 404;
        throw error;
      }
      if (auth.voidRequested) {
        const error = new Error("A void has been requested for this authorization.");
        error.status = 409;
        throw error;
      }

      auth.tasks = Array.isArray(auth.tasks) ? auth.tasks : [];
      const existing = auth.tasks.find((task) => task.taskId === candidate.taskId);
      if (existing) {
        if (existing.amount !== amount) {
          const error = new Error("This artifact and criteria are already recorded with a different amount. Use the original task record to avoid duplicate payment.");
          error.status = 409;
          throw error;
        }
        return { auth, task: existing, reused: true };
      }

      auth.tasks.push(candidate);
      auth.updatedAt = new Date().toISOString();
      saveState();
      return { auth, task: candidate, reused: false };
    });

    const proofReceipt = createProofReceipt({
      authorizationId,
      currency: result.auth.currency || "USD",
      authorizationStatus: result.auth.status || null,
      task: result.task,
    });
    res.json({
      authorizationId,
      task: result.task,
      reused: result.reused,
      proofReceipt,
      message: result.reused
        ? "This artifact is already recorded. No payment was attempted."
        : "Artifact verification saved to the selected authorization. No payment was attempted.",
    });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ error: error.message });
    sendError(res, error);
  }
});

// Capture is a separate, explicit operation. It accepts only a recorded PASS
// artifact task and rechecks provider status, available budget, and uncertainty.
app.post("/api/authorizations/:authorizationId/artifact-tasks/:taskId/capture", async (req, res) => {
  const { authorizationId, taskId } = req.params;
  if (!validId(authorizationId) || !validId(taskId)) {
    return res.status(400).json({ error: "Invalid authorization or task ID." });
  }

  try {
    const result = await serializeMutation(async () => {
      const auth = state.authorizations[authorizationId];
      if (!auth) {
        const error = new Error("Authorization is not recorded locally.");
        error.status = 404;
        throw error;
      }
      const task = (auth.tasks || []).find((item) => item.taskId === taskId);
      if (!task || !task.artifact) {
        const error = new Error("This artifact task is not recorded for the authorization.");
        error.status = 404;
        throw error;
      }
      if (task.verification !== "PASS" || task.verificationSource !== "deterministic-artifact") {
        const error = new Error("Only a recorded artifact task with a PASS decision can be captured.");
        error.status = 409;
        throw error;
      }
      if (task.captureStatus !== "NOT_ATTEMPTED" ||
          (auth.captures || []).some((capture) => capture.taskId === taskId)) {
        const error = new Error("This artifact task already has a capture attempt. Inspect or reconcile the existing attempt; do not submit a new one.");
        error.status = 409;
        throw error;
      }
      if (auth.voidRequested) {
        const error = new Error("A void has been requested for this authorization.");
        error.status = 409;
        throw error;
      }
      if (auth.currency !== "USD" || moneyToCents(task.amount) <= 0) {
        const error = new Error("Artifact capture requires a positive USD task amount.");
        error.status = 409;
        throw error;
      }

      auth.captures = Array.isArray(auth.captures) ? auth.captures : [];
      if (auth.captures.some(isUnresolvedCapture)) {
        const error = new Error("An earlier capture is unresolved. Reconcile it before capturing another task.");
        error.status = 409;
        throw error;
      }

      const remote = await paypalRequest(
        "/v2/payments/authorizations/" + encodeURIComponent(authorizationId)
      );
      auth.status = remote.status;
      if (!["CREATED", "PARTIALLY_CAPTURED"].includes(remote.status)) {
        saveState();
        const error = new Error("Authorization cannot be captured in status " + remote.status + ".");
        error.status = 409;
        throw error;
      }

      const totals = captureTotals(auth);
      if (totals.committedCents + totals.uncertainCents + moneyToCents(task.amount) >
          moneyToCents(auth.authorizedAmount)) {
        const error = new Error("Artifact capture exceeds the remaining locally available authorization budget.");
        error.status = 409;
        throw error;
      }

      const requestId = "pop-" + authorizationId + "-" + taskId;
      const attempt = {
        requestId,
        taskId,
        amount: task.amount,
        status: "IN_PROGRESS",
        startedAt: new Date().toISOString(),
        captureId: null,
        source: "artifact-verification",
      };
      auth.captures.push(attempt);
      task.captureStatus = "IN_PROGRESS";
      task.events = Array.isArray(task.events) ? task.events : [];
      task.events.push({
        type: "CAPTURE_ATTEMPT_STARTED",
        at: attempt.startedAt,
        requestId,
        amount: task.amount,
        source: "artifact-verification",
      });
      auth.updatedAt = attempt.startedAt;
      saveState();

      try {
        const capture = await paypalRequest(
          "/v2/payments/authorizations/" + encodeURIComponent(authorizationId) + "/capture",
          {
            method: "POST",
            requestId,
            body: {
              amount: { currency_code: auth.currency, value: task.amount },
              final_capture: false,
            },
          }
        );

        attempt.captureId = capture.id || null;
        attempt.status = capture.status || "UNKNOWN";
        attempt.responseAmount = capture.amount || null;
        attempt.finishedAt = new Date().toISOString();
        task.captureId = attempt.captureId;
        task.captureStatus = attempt.status;
        task.events.push({
          type: "CAPTURE_RESPONSE",
          at: attempt.finishedAt,
          status: attempt.status,
          captureId: attempt.captureId,
        });
        auth.updatedAt = attempt.finishedAt;
        saveState();
        return { auth, task, captureAttempted: true };
      } catch (error) {
        attempt.status = classifyCaptureFailure(error);
        attempt.errorStatus = error.status || null;
        attempt.finishedAt = new Date().toISOString();
        task.captureStatus = attempt.status;
        task.events.push({
          type: "CAPTURE_ERROR",
          at: attempt.finishedAt,
          status: attempt.status,
          httpStatus: attempt.errorStatus,
        });
        auth.updatedAt = attempt.finishedAt;
        saveState();
        return { auth, task, captureAttempted: true };
      }
    });

    const proofReceipt = createProofReceipt({
      authorizationId,
      currency: result.auth.currency || "USD",
      authorizationStatus: result.auth.status || null,
      task: result.task,
    });
    const paymentOutcome = result.task.captureStatus === "COMPLETED" ? "CAPTURE_COMPLETED"
      : result.task.captureStatus === "PENDING" ? "CAPTURE_PENDING"
      : ["UNKNOWN", "IN_PROGRESS"].includes(result.task.captureStatus) ? "OUTCOME_UNCERTAIN"
      : result.task.captureStatus === "FAILED" ? "CAPTURE_FAILED"
      : "CAPTURE_NOT_COMPLETED";
    res.json({
      authorizationId,
      task: result.task,
      checks: result.task.verificationChecks || [],
      captureAttempted: result.captureAttempted,
      capture: {
        captureId: result.task.captureId || null,
        status: result.task.captureStatus,
        amount: result.task.amount,
      },
      paymentOutcome,
      proofReceipt,
      message: result.task.captureStatus === "COMPLETED"
        ? "The artifact passed verification and PayPal reports the task capture as COMPLETED."
        : "A capture attempt was recorded but did not return a confirmed COMPLETED status. Reconcile the recorded attempt before any further payment action.",
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Recompute Proof Receipt hashes. Optional original bytes verify artifact provenance.
app.post("/api/receipts/verify", (req, res) => {
  const body = req.body || {};
  if (!body.receipt || typeof body.receipt !== "object" || Array.isArray(body.receipt)) {
    return res.status(400).json({ error: "Provide a receipt JSON object." });
  }
  if (body.artifactContent !== undefined && typeof body.artifactContent !== "string") {
    return res.status(400).json({ error: "artifactContent must be text when supplied." });
  }
  if (typeof body.artifactContent === "string" &&
      Buffer.byteLength(body.artifactContent, "utf8") > 20 * 1024) {
    return res.status(413).json({ error: "artifactContent exceeds the 20 KB verification limit." });
  }
  const result = verifyProofReceipt(body.receipt, { artifactContent: body.artifactContent });
  res.json(result);
});

app.get("/api/scenarios", (_req, res) => {
  res.json({ simulationOnly: true, paymentSideEffects: false, scenarios: listScenarios() });
});

app.post("/api/scenarios/:scenarioId/simulate", (req, res) => {
  try {
    res.json(simulateScenario(req.params.scenarioId));
  } catch (error) {
    sendError(res, error);
  }
});

// Run the controlled demo against a fresh authorization.
// Passing tasks are captured; failed tasks capture nothing.
app.post(
  "/api/authorizations/:authorizationId/run-demo",
  async (req, res) => {
    const { authorizationId } = req.params;

    if (!validId(authorizationId)) {
      return res.status(400).json({
        error: "Invalid authorization ID.",
      });
    }

    try {
      const result = await serializeMutation(async () => {
        const auth = state.authorizations[authorizationId];

        if (!auth) {
          const error = new Error(
            "Authorization is not recorded locally. Create and authorize a fresh order through this server first."
          );
          error.status = 404;
          throw error;
        }

        if (auth.demoRunStarted) {
          const error = new Error(
            "This authorization has already been used for a demo run. Create a fresh authorization for another run."
          );
          error.status = 409;
          throw error;
        }

        if (auth.voidRequested) {
          const error = new Error(
            "This authorization has a void request recorded."
          );
          error.status = 409;
          throw error;
        }

        if (auth.currency !== "USD") {
          const error = new Error(
            "This demo currently supports USD authorizations only."
          );
          error.status = 409;
          throw error;
        }

        if (moneyToCents(auth.authorizedAmount) < 4500) {
          const error = new Error(
            "The authorization must be at least $45.00 for this demo."
          );
          error.status = 409;
          throw error;
        }

        const remote = await paypalRequest(
          `/v2/payments/authorizations/${encodeURIComponent(
            authorizationId
          )}`
        );

        auth.status = remote.status;

        if (
          !["CREATED", "PARTIALLY_CAPTURED"].includes(remote.status)
        ) {
          saveState();

          const error = new Error(
            `Authorization cannot run the demo in status ${remote.status}.`
          );
          error.status = 409;
          throw error;
        }

        auth.demoRunStarted = true;
        auth.tasks = [];
        auth.updatedAt = new Date().toISOString();
        saveState();

        const results = [];

        for (const task of DEMO_TASKS) {
          const verification = await evaluateDemoTask(task);

          const evaluatedAt = new Date().toISOString();
          const taskRecord = {
            taskId: task.id,
            title: task.title,
            amount: task.amount,
            acceptance: task.acceptance,
            evidence: task.evidence,
            verification: verification.decision,
            verificationSource: verification.source,
            verificationModel: verification.model || null,
            reason: verification.reason,
            captureId: null,
            captureStatus: "NOT_ATTEMPTED",
            evaluatedAt,
            review: null,
            events: [{
              type: "VERIFICATION_COMPLETED",
              at: evaluatedAt,
              decision: verification.decision,
              source: verification.source || "unknown",
              reason: verification.reason,
            }],
          };

          auth.tasks.push(taskRecord);
          saveState();

          if (verification.decision !== "PASS") {
            results.push(taskRecord);
            continue;
          }

          const { committedCents, uncertainCents } =
            captureTotals(auth);
          const requestedCents = moneyToCents(task.amount);
          const budgetCents = moneyToCents(auth.authorizedAmount);

          if (
            committedCents + uncertainCents + requestedCents >
            budgetCents
          ) {
            taskRecord.captureStatus = "BLOCKED_BUDGET";
            results.push(taskRecord);
            saveState();
            continue;
          }

          const requestId = `pop-${authorizationId}-${task.id}`;

          const captureAttempt = {
            requestId,
            taskId: task.id,
            amount: task.amount,
            status: "IN_PROGRESS",
            startedAt: new Date().toISOString(),
            captureId: null,
          };

          auth.captures.push(captureAttempt);
          taskRecord.captureStatus = "IN_PROGRESS";
          taskRecord.events.push({
            type: "CAPTURE_ATTEMPT_STARTED",
            at: captureAttempt.startedAt,
            requestId,
            amount: task.amount,
          });
          saveState();

          try {
            const capture = await paypalRequest(
              `/v2/payments/authorizations/${encodeURIComponent(
                authorizationId
              )}/capture`,
              {
                method: "POST",
                requestId,
                body: {
                  amount: {
                    currency_code: auth.currency,
                    value: task.amount,
                  },
                  final_capture: false,
                },
              }
            );

            captureAttempt.captureId = capture.id || null;
            captureAttempt.status = capture.status || "UNKNOWN";
            captureAttempt.responseAmount = capture.amount || null;
            captureAttempt.finishedAt = new Date().toISOString();

            taskRecord.captureId = capture.id || null;
            taskRecord.captureStatus = capture.status || "UNKNOWN";
            taskRecord.events.push({
              type: "CAPTURE_RESPONSE",
              at: captureAttempt.finishedAt,
              status: taskRecord.captureStatus,
              captureId: taskRecord.captureId,
            });

            saveState();
            results.push(taskRecord);

            if (
              !["COMPLETED", "PENDING"].includes(capture.status)
            ) {
              auth.demoRunStatus = "NEEDS_RECONCILIATION";
              auth.updatedAt = new Date().toISOString();
              saveState();

              return {
                authorizationId,
                demoRunStatus: auth.demoRunStatus,
                tasks: results,
                message:
                  "A capture did not complete normally. Stop and reconcile the PayPal transaction before continuing.",
              };
            }

            if (capture.status === "PENDING") {
              auth.demoRunStatus = "NEEDS_RECONCILIATION";
              auth.updatedAt = new Date().toISOString();
              saveState();

              return {
                authorizationId,
                demoRunStatus: auth.demoRunStatus,
                tasks: results,
                message:
                  "A capture is pending. Do not void or retry until its state is resolved.",
              };
            }
          } catch (error) {
            captureAttempt.status = classifyCaptureFailure(error);
            captureAttempt.errorStatus = error.status || null;
            captureAttempt.finishedAt = new Date().toISOString();

            taskRecord.captureStatus = captureAttempt.status;
            taskRecord.events.push({
              type: "CAPTURE_ERROR",
              at: captureAttempt.finishedAt,
              status: captureAttempt.status,
              httpStatus: captureAttempt.errorStatus,
            });
            auth.demoRunStatus = "NEEDS_RECONCILIATION";
            auth.updatedAt = new Date().toISOString();
            saveState();

            // Stop immediately; an ambiguous capture must be reconciled.
            return {
              authorizationId,
              demoRunStatus: auth.demoRunStatus,
              tasks: results.concat(taskRecord),
              message:
                "Capture failed or its outcome is uncertain. Reconcile PayPal state before retrying.",
            };
          }
        }

        const needsReview = results.some(
          (taskResult) => taskResult.verification === "REVIEW"
        );
        auth.demoRunStatus = needsReview
          ? "COMPLETED_WITH_REVIEW"
          : "COMPLETED";
        auth.updatedAt = new Date().toISOString();
        saveState();

        return {
          authorizationId,
          demoRunStatus: auth.demoRunStatus,
          tasks: results,
          totals: {
            committed: centsToMoney(
              captureTotals(auth).committedCents
            ),
            uncertain: centsToMoney(
              captureTotals(auth).uncertainCents
            ),
          },
          message:
            "Demo verification finished. Review the results and inspect the authorization before voiding the remainder.",
        };
      });

      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Human review is local-demo-only: this endpoint is unauthenticated.
 // Only recorded REVIEW tasks can be reviewed; approval re-runs the deterministic
 // hard gate, checks PayPal's live authorization, reserves budgets, and captures
 // using a stable request ID. FAIL tasks can never be approved through this path.
app.post(
  "/api/authorizations/:authorizationId/tasks/:taskId/review",
  async (req, res) => {
    const { authorizationId, taskId } = req.params;
    const { decision, reviewer, notes } = req.body || {};

    if (!validId(authorizationId) || !validId(taskId)) {
      return res.status(400).json({ error: "Invalid authorization or task ID." });
    }
    if (!["APPROVE", "REJECT"].includes(decision)) {
      return res.status(400).json({ error: "decision must be APPROVE or REJECT." });
    }
    if (typeof reviewer !== "string" || reviewer.trim().length < 2 || reviewer.trim().length > 80) {
      return res.status(400).json({ error: "Provide a reviewer name between 2 and 80 characters." });
    }
    if (typeof notes !== "string" || notes.trim().length < 5 || notes.trim().length > 500) {
      return res.status(400).json({ error: "Provide review notes between 5 and 500 characters." });
    }

    try {
      const result = await serializeMutation(async () => {
        const auth = state.authorizations[authorizationId];
        if (!auth) {
          const error = new Error("Authorization is not recorded locally.");
          error.status = 404;
          throw error;
        }

        const task = (auth.tasks || []).find((item) => item.taskId === taskId);
        if (!task) {
          const error = new Error("Task is not recorded for this authorization.");
          error.status = 404;
          throw error;
        }
        if (task.verification !== "REVIEW" || task.review) {
          const error = new Error("Only an unreviewed REVIEW task can enter this review action.");
          error.status = 409;
          throw error;
        }
        if (task.captureStatus !== "NOT_ATTEMPTED" ||
            (auth.captures || []).some((capture) => capture.taskId === taskId)) {
          const error = new Error("This task already has a capture attempt; reconcile it instead of reviewing again.");
          error.status = 409;
          throw error;
        }
        if (auth.voidRequested) {
          const error = new Error("A void has been requested for this authorization.");
          error.status = 409;
          throw error;
        }

        const reviewedAt = new Date().toISOString();
        const review = {
          status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
          decision,
          reviewer: reviewer.trim(),
          notes: notes.trim(),
          reviewedAt,
        };

        if (decision === "REJECT") {
          task.review = review;
          task.events = Array.isArray(task.events) ? task.events : [];
          task.events.push({ type: "HUMAN_REVIEW_REJECTED", at: reviewedAt, reviewer: review.reviewer, notes: review.notes });
          auth.updatedAt = reviewedAt;
          saveState();
          return {
            authorizationId,
            task,
            captureAttempted: false,
            paymentOutcome: "REJECTED_BY_REVIEWER",
            message: "Review recorded. No PayPal capture was attempted.",
          };
        }

        const deterministic = verifyDeterministicTask({
          id: task.taskId,
          evidence: task.evidence,
        });
        if (deterministic.decision !== "PASS") {
          const error = new Error(
            "Human approval cannot bypass deterministic required-field checks. Request corrected evidence and run verification again."
          );
          error.status = 409;
          throw error;
        }

        if (auth.currency !== "USD" || moneyToCents(task.amount) <= 0) {
          const error = new Error("This review capture requires a valid USD task amount.");
          error.status = 409;
          throw error;
        }
        if ((auth.captures || []).some(isUnresolvedCapture)) {
          const error = new Error("An earlier capture is unresolved. Reconcile it before approving another capture.");
          error.status = 409;
          throw error;
        }

        const remote = await paypalRequest(
          `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`
        );
        auth.status = remote.status;
        if (!["CREATED", "PARTIALLY_CAPTURED"].includes(remote.status)) {
          saveState();
          const error = new Error(`Authorization cannot be captured in status ${remote.status}.`);
          error.status = 409;
          throw error;
        }

        const { committedCents, uncertainCents } = captureTotals(auth);
        if (committedCents + uncertainCents + moneyToCents(task.amount) >
            moneyToCents(auth.authorizedAmount)) {
          const error = new Error("Review-approved capture exceeds the remaining locally available budget.");
          error.status = 409;
          throw error;
        }

        // Persist the reviewer decision before attempting an external side effect.
        task.review = review;
        task.events = Array.isArray(task.events) ? task.events : [];
        task.events.push({ type: "HUMAN_REVIEW_APPROVED", at: reviewedAt, reviewer: review.reviewer, notes: review.notes });
        const requestId = `pop-review-${authorizationId}-${taskId}`;
        const attempt = {
          requestId,
          taskId,
          amount: task.amount,
          status: "IN_PROGRESS",
          startedAt: new Date().toISOString(),
          captureId: null,
          initiatedBy: review.reviewer,
        };
        auth.captures.push(attempt);
        task.captureStatus = "IN_PROGRESS";
        task.events.push({ type: "CAPTURE_ATTEMPT_STARTED", at: attempt.startedAt, requestId, amount: task.amount });
        auth.updatedAt = attempt.startedAt;
        saveState();

        try {
          const capture = await paypalRequest(
            `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
            {
              method: "POST",
              requestId,
              body: {
                amount: { currency_code: auth.currency, value: task.amount },
                final_capture: false,
              },
            }
          );

          attempt.captureId = capture.id || null;
          attempt.status = capture.status || "UNKNOWN";
          attempt.responseAmount = capture.amount || null;
          attempt.finishedAt = new Date().toISOString();
          task.captureId = attempt.captureId;
          task.captureStatus = attempt.status;
          task.events.push({ type: "CAPTURE_RESPONSE", at: attempt.finishedAt, status: attempt.status, captureId: attempt.captureId });
          auth.updatedAt = attempt.finishedAt;
          saveState();

          return {
            authorizationId,
            task,
            captureAttempted: true,
            capture: { captureId: attempt.captureId, status: attempt.status, amount: attempt.responseAmount },
            paymentOutcome: attempt.status === "COMPLETED" ? "CAPTURE_COMPLETED" :
              attempt.status === "PENDING" ? "CAPTURE_PENDING" :
              attempt.status === "UNKNOWN" || attempt.status === "IN_PROGRESS" ? "OUTCOME_UNCERTAIN" : "CAPTURE_NOT_COMPLETED",
            message: ["COMPLETED", "PENDING"].includes(attempt.status)
              ? "Human review is recorded. Inspect the PayPal status; pending captures remain unresolved."
              : "The capture did not complete normally. Reconcile the recorded request before any further payment action.",
          };
        } catch (error) {
          attempt.status = classifyCaptureFailure(error);
          attempt.errorStatus = error.status || null;
          attempt.finishedAt = new Date().toISOString();
          task.captureStatus = attempt.status;
          task.events.push({ type: "CAPTURE_ERROR", at: attempt.finishedAt, status: attempt.status, httpStatus: attempt.errorStatus });
          auth.updatedAt = attempt.finishedAt;
          saveState();
          return {
            authorizationId,
            task,
            captureAttempted: true,
            capture: { captureId: attempt.captureId, status: attempt.status },
            paymentOutcome: attempt.status === "FAILED" ? "CAPTURE_FAILED" : "OUTCOME_UNCERTAIN",
            message: "Capture request returned an error. Treat the outcome conservatively and use reconciliation before retrying or voiding.",
          };
        }
      });

      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Capture a partial amount.
// Body: { "amount": "15.00", "requestId": "task-a-capture-v1" }
app.post(
  "/api/authorizations/:authorizationId/capture",
  async (req, res) => {
    const { authorizationId } = req.params;
    const { amount, requestId } = req.body || {};

    if (!validId(authorizationId)) {
      return res.status(400).json({
        error: "Invalid authorization ID.",
      });
    }

    if (
      typeof amount !== "string" ||
      !/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(amount) ||
      moneyToCents(amount) <= 0
    ) {
      return res.status(400).json({
        error: 'amount must be a positive decimal string such as "15.00".',
      });
    }

    if (
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(requestId)
    ) {
      return res.status(400).json({
        error: "Provide a stable unique requestId for this capture.",
      });
    }

    try {
      const result = await serializeMutation(async () => {
        const local = state.authorizations[authorizationId];

        if (!local) {
          const error = new Error(
            "Authorization is not recorded locally. Do not capture it through this demo server."
          );
          error.status = 404;
          throw error;
        }

        if (local.voidRequested) {
          const error = new Error(
            "A void has been requested for this authorization."
          );
          error.status = 409;
          throw error;
        }

        const duplicate = local.captures.find(
          (capture) => capture.requestId === requestId
        );

        if (duplicate) {
          const error = new Error(
            "This requestId has already been used. Inspect the existing capture attempt; do not submit it again."
          );
          error.status = 409;
          error.details = {
            capture: duplicate,
          };
          throw error;
        }

        // Ask PayPal for current status before authorizing another capture.
        const remote = await paypalRequest(
          `/v2/payments/authorizations/${encodeURIComponent(
            authorizationId
          )}`
        );

        local.status = remote.status;

        if (
          !["CREATED", "PARTIALLY_CAPTURED"].includes(remote.status)
        ) {
          saveState();

          const error = new Error(
            `Authorization cannot be captured in status ${remote.status}.`
          );
          error.status = 409;
          throw error;
        }

        const authorizedCents = moneyToCents(
          local.authorizedAmount
        );
        const { committedCents, uncertainCents } =
          captureTotals(local);
        const requestedCents = moneyToCents(amount);

        if (
          committedCents + uncertainCents + requestedCents >
          authorizedCents
        ) {
          const error = new Error(
            "Capture exceeds the remaining locally available budget."
          );
          error.status = 409;
          error.details = {
            authorizedAmount: local.authorizedAmount,
            alreadyCommitted: centsToMoney(committedCents),
            uncertainAmount: centsToMoney(uncertainCents),
            requestedAmount: amount,
          };
          throw error;
        }

        const attempt = {
          requestId,
          amount,
          status: "IN_PROGRESS",
          startedAt: new Date().toISOString(),
          captureId: null,
        };

        local.captures.push(attempt);
        local.updatedAt = new Date().toISOString();
        saveState();

        try {
          const captured = await paypalRequest(
            `/v2/payments/authorizations/${encodeURIComponent(
              authorizationId
            )}/capture`,
            {
              method: "POST",
              requestId,
              body: {
                amount: {
                  currency_code: local.currency,
                  value: amount,
                },
                final_capture: false,
              },
            }
          );

          attempt.captureId = captured.id || null;
          attempt.status = captured.status || "UNKNOWN";
          attempt.responseAmount = captured.amount || null;
          attempt.finishedAt = new Date().toISOString();
          local.updatedAt = new Date().toISOString();
          saveState();

          return {
            captureId: captured.id,
            status: captured.status,
            amount: captured.amount,
            finalCapture: false,
          };
        } catch (error) {
          // HTTP errors can still be ambiguous (for example a timeout or 5xx).
          // Keep the amount reserved unless rejection is definitive. Reconcile
          // with the same PayPal-Request-Id before any new capture or void.
          attempt.status = classifyCaptureFailure(error);
          attempt.errorStatus = error.status || null;
          attempt.finishedAt = new Date().toISOString();
          local.updatedAt = new Date().toISOString();
          saveState();

          throw error;
        }
      });

      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Reconcile unresolved capture attempts using their original idempotency keys.
app.post(
  "/api/authorizations/:authorizationId/reconcile",
  async (req, res) => {
    const { authorizationId } = req.params;

    if (!validId(authorizationId)) {
      return res.status(400).json({ error: "Invalid authorization ID." });
    }

    try {
      const result = await serializeMutation(async () => {
        const local = state.authorizations[authorizationId];
        if (!local) {
          const error = new Error("Authorization is not recorded locally.");
          error.status = 404;
          throw error;
        }
        if (local.voidRequested) {
          const error = new Error(
            "A void has been requested. Resolve that transaction directly with PayPal before continuing."
          );
          error.status = 409;
          throw error;
        }

        const attempts = (Array.isArray(local.captures) ? local.captures : [])
          .filter(isUnresolvedCapture);
        let resolvedCount = 0;

        for (const attempt of attempts) {
          try {
            let capture;
            if (attempt.captureId) {
              capture = await paypalRequest(
                `/v2/payments/captures/${encodeURIComponent(attempt.captureId)}`
              );
            } else {
              if (
                typeof attempt.requestId !== "string" ||
                !/^[A-Za-z0-9._:-]{1,100}$/.test(attempt.requestId) ||
                typeof attempt.amount !== "string" ||
                !/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(attempt.amount) ||
                local.currency !== "USD"
              ) {
                attempt.status = "UNKNOWN";
                attempt.reconciliationError =
                  "Original request data is incomplete; inspect the transaction with PayPal manually.";
                attempt.reconciledAt = new Date().toISOString();
                saveState();
                continue;
              }

              // Replaying the exact requestId and payload lets PayPal return
              // the original result instead of creating a duplicate capture.
              capture = await paypalRequest(
                `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
                {
                  method: "POST",
                  requestId: attempt.requestId,
                  body: {
                    amount: {
                      currency_code: local.currency,
                      value: attempt.amount,
                    },
                    final_capture: false,
                  },
                }
              );
            }

            const returnedStatus = capture.status;
            if (returnedStatus === "COMPLETED") {
              attempt.status = "COMPLETED";
            } else if (returnedStatus === "PENDING") {
              attempt.status = "PENDING";
            } else if (["DECLINED", "FAILED"].includes(returnedStatus)) {
              attempt.status = "FAILED";
            } else {
              attempt.status = "UNKNOWN";
            }

            attempt.captureId = capture.id || attempt.captureId || null;
            attempt.responseAmount = capture.amount || attempt.responseAmount || null;
            attempt.reconciledAt = new Date().toISOString();
            attempt.errorStatus = null;

            if (attempt.taskId && Array.isArray(local.tasks)) {
              const task = local.tasks.find(
                (candidate) => candidate.taskId === attempt.taskId
              );
              if (task) {
                task.captureId = attempt.captureId;
                task.captureStatus = attempt.status;
              }
            }
            if (!isUnresolvedCapture(attempt)) resolvedCount += 1;
            saveState();
          } catch (error) {
            // A known capture ID returning an error is not proof that the
            // capture never happened. Keep it unresolved for manual review.
            attempt.status = attempt.captureId
              ? "UNKNOWN"
              : classifyCaptureFailure(error);
            attempt.errorStatus = error.status || null;
            attempt.reconciledAt = new Date().toISOString();
            if (attempt.taskId && Array.isArray(local.tasks)) {
              const task = local.tasks.find(
                (candidate) => candidate.taskId === attempt.taskId
              );
              if (task) task.captureStatus = attempt.status;
            }
            if (!isUnresolvedCapture(attempt)) resolvedCount += 1;
            saveState();
          }
        }

        let paypalStatus = local.status || "UNKNOWN";
        try {
          const remote = await paypalRequest(
            `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`
          );
          local.status = remote.status || local.status;
          paypalStatus = remote.status || paypalStatus;
        } catch {
          // Preserve the reconciliation results; the UI still reports the
          // authorization as unconfirmed until a later status refresh succeeds.
          paypalStatus = "STATUS_REFRESH_FAILED";
        }

        const unresolvedCount = (local.captures || []).filter(isUnresolvedCapture).length;
        if (unresolvedCount === 0 && local.demoRunStatus === "NEEDS_RECONCILIATION") {
          // Do not resume midway through a payment sequence. The operator can
          // inspect/void the remaining authorization or start with a fresh one.
          local.demoRunStatus = "RECONCILED_STOPPED";
        }
        local.updatedAt = new Date().toISOString();
        saveState();

        return {
          authorizationId,
          paypalStatus,
          resolvedCount,
          unresolvedCount,
          demoRunStatus: local.demoRunStatus || null,
          tasks: local.tasks || [],
          message: unresolvedCount
            ? "Some capture attempts remain unresolved. Do not void or start another capture; retry reconciliation after checking PayPal."
            : "Capture attempts are reconciled. The demo will not resume automatically; review PayPal status and task results before deciding whether to void the remainder.",
        };
      });

      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Request void of the remaining authorization, then query PayPal again.
app.post(
  "/api/authorizations/:authorizationId/void",
  async (req, res) => {
    const { authorizationId } = req.params;

    if (!validId(authorizationId)) {
      return res.status(400).json({
        error: "Invalid authorization ID.",
      });
    }

    try {
      const result = await serializeMutation(async () => {
        const local = state.authorizations[authorizationId];

        if (!local) {
          const error = new Error(
            "Authorization is not recorded locally."
          );
          error.status = 404;
          throw error;
        }

        const unresolved = local.captures.some(isUnresolvedCapture);

        if (unresolved) {
          const error = new Error(
            "Cannot safely void while a capture attempt is unresolved. Inspect PayPal and reconcile it first."
          );
          error.status = 409;
          throw error;
        }

        const remote = await paypalRequest(
          `/v2/payments/authorizations/${encodeURIComponent(
            authorizationId
          )}`
        );

        local.status = remote.status;

        if (remote.status === "VOIDED") {
          saveState();
          return {
            authorizationId,
            status: "VOIDED",
            alreadyVoided: true,
          };
        }

        if (
          !["CREATED", "PARTIALLY_CAPTURED"].includes(remote.status)
        ) {
          saveState();

          const error = new Error(
            `Authorization cannot be voided in status ${remote.status}.`
          );
          error.status = 409;
          throw error;
        }

        local.voidRequested = true;
        local.updatedAt = new Date().toISOString();
        saveState();

        try {
          await paypalRequest(
            `/v2/payments/authorizations/${encodeURIComponent(
              authorizationId
            )}/void`,
            {
              method: "POST",
              requestId: `void-${authorizationId}`,
              body: {},
            }
          );
        } catch (error) {
          // Do not assume a failed network response means the void failed.
          local.status = "UNKNOWN";
          local.updatedAt = new Date().toISOString();
          saveState();
          throw error;
        }

        const verified = await paypalRequest(
          `/v2/payments/authorizations/${encodeURIComponent(
            authorizationId
          )}`
        );

        local.status = verified.status;
        local.updatedAt = new Date().toISOString();
        saveState();

        return {
          authorizationId,
          status: verified.status,
          voidVerified: verified.status === "VOIDED",
          amount: verified.amount,
        };
      });

      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Proof Receipts are snapshots of recorded evidence and decisions, not a truth guarantee.
app.get("/api/authorizations/:authorizationId/receipts", (req, res) => {
  const { authorizationId } = req.params;
  if (!validId(authorizationId)) {
    return res.status(400).json({ error: "Invalid authorization ID." });
  }
  const auth = state.authorizations[authorizationId];
  if (!auth) return res.status(404).json({ error: "Authorization is not recorded locally." });

  const receipts = (auth.tasks || []).map((task) =>
    createProofReceipt({
      authorizationId,
      currency: auth.currency || "USD",
      authorizationStatus: auth.status || null,
      task,
    })
  );
  res.json({
    authorizationId,
    receiptCount: receipts.length,
    receipts,
    limitations: "Receipt hashes protect the recorded snapshot from unnoticed changes; they do not prove evidence is truthful. Confirm uncertain financial outcomes with PayPal.",
  });
});

app.get("/api/authorizations/:authorizationId/receipt/:taskId", (req, res) => {
  const { authorizationId, taskId } = req.params;
  if (!validId(authorizationId) || !validId(taskId)) {
    return res.status(400).json({ error: "Invalid authorization or task ID." });
  }
  const auth = state.authorizations[authorizationId];
  if (!auth) return res.status(404).json({ error: "Authorization is not recorded locally." });
  const task = (auth.tasks || []).find((item) => item.taskId === taskId);
  if (!task) return res.status(404).json({ error: "Task is not recorded for this authorization." });
  res.json(createProofReceipt({
    authorizationId,
    currency: auth.currency || "USD",
    authorizationStatus: auth.status || null,
    task,
  }));
});

// View locally persisted payment records.
app.get("/api/state", (_req, res) => {
  res.json(state);
});

const HOST = process.env.HOST || "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
if (!LOOPBACK_HOSTS.has(HOST)) {
  throw new Error(
    "Pay-on-Proof is an unauthenticated sandbox prototype and may bind only to loopback (127.0.0.1 or ::1). Do not expose it on a network."
  );
}
app.listen(Number(PORT), HOST, () => {
  console.log(
    `Pay-on-Proof backend running at http://${HOST}:${PORT}`
  );
});
