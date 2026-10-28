
require("dotenv").config();

const express = require("express");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));
const {
  PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PORT = 3000,
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  throw new Error("Missing PayPal REST credentials in .env");
}

const STATE_FILE = path.join(__dirname, ".pay-on-proof-state.json");
const TEMP_FILE = path.join(__dirname, ".pay-on-proof-state.tmp");

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

// Health check.
app.get("/", (_req, res) => {
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
          return_url: "http://localhost:3000/checkout/return",
          cancel_url: "http://localhost:3000/checkout/cancel",
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
    acceptance: "Report contains a title and summary.",
    evidence: {
      title: "Quarterly Analysis",
      summary: "Revenue increased in the sample dataset.",
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

function verifyDemoTask(task) {
  if (task.id === "task-a") {
    const passed =
      typeof task.evidence.title === "string" &&
      task.evidence.title.trim().length > 0 &&
      typeof task.evidence.summary === "string" &&
      task.evidence.summary.trim().length > 0;

    return {
      passed,
      reason: passed
        ? "Required report fields are present."
        : "Report title or summary is missing.",
    };
  }

  if (task.id === "task-b") {
    const checks = task.evidence.checks;

    const passed =
      Array.isArray(checks) &&
      checks.length === 3 &&
      checks.every(
        (check) =>
          typeof check.name === "string" &&
          check.passed === true
      );

    return {
      passed,
      reason: passed
        ? "All three required checks passed."
        : "One or more required checks failed or are missing.",
    };
  }

  if (task.id === "task-c") {
    const passed =
      typeof task.evidence.conclusion === "string" &&
      task.evidence.conclusion.trim().length > 0;

    return {
      passed,
      reason: passed
        ? "A conclusion was found."
        : "Required conclusion is missing.",
    };
  }

  return {
    passed: false,
    reason: "Unknown task.",
  };
}

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
          const verification = verifyDemoTask(task);

          const taskRecord = {
            taskId: task.id,
            title: task.title,
            amount: task.amount,
            acceptance: task.acceptance,
            evidence: task.evidence,
            verification: verification.passed ? "PASS" : "FAIL",
            reason: verification.reason,
            captureId: null,
            captureStatus: "NOT_ATTEMPTED",
            evaluatedAt: new Date().toISOString(),
          };

          auth.tasks.push(taskRecord);
          saveState();

          if (!verification.passed) {
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
            amount: task.amount,
            status: "IN_PROGRESS",
            startedAt: new Date().toISOString(),
            captureId: null,
          };

          auth.captures.push(captureAttempt);
          taskRecord.captureStatus = "IN_PROGRESS";
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
            captureAttempt.status = error.status
              ? "FAILED"
              : "UNKNOWN";
            captureAttempt.errorStatus = error.status || null;
            captureAttempt.finishedAt = new Date().toISOString();

            taskRecord.captureStatus = captureAttempt.status;
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

        auth.demoRunStatus = "COMPLETED";
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
          // HTTP errors are explicit responses; network errors can be ambiguous.
          attempt.status = error.status ? "FAILED" : "UNKNOWN";
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

        const unresolved = local.captures.some((capture) =>
          ["IN_PROGRESS", "UNKNOWN", "PENDING"].includes(
            capture.status
          )
        );

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

// View locally persisted payment records.
app.get("/api/state", (_req, res) => {
  res.json(state);
});

app.listen(Number(PORT), () => {
  console.log(
    `Pay-on-Proof backend running at http://localhost:${PORT}`
  );
});
