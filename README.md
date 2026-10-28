# Pay-on-Proof

A PayPal sandbox prototype for evidence-gated agentic commerce: tasks are checked against acceptance criteria, and the backend captures value only for tasks that pass verification.

> **Prototype status:** hackathon/demo software only. It is not a production payment service. Use sandbox credentials only.

## What works

- Creates a single $50 USD PayPal sandbox order with intent `AUTHORIZE`.
- Records orders and authorizations in a local JSON state file.
- Verifies three controlled demo tasks and records evidence, decisions, and capture IDs.
- Captures passing tasks as partial captures with `final_capture: false`.
- Blocks repeated demo runs for an authorization.
- Queries PayPal for the authoritative authorization status and verifies voiding of the unused authorization.
- Serves a browser dashboard from `public/index.html`.
- Provides a verification preview endpoint and dashboard button that run the verifier without contacting PayPal's payment endpoints. If AI is configured, the preview still makes an OpenAI API request and may incur usage cost.

The controlled demo's intended results are Task A $15 PASS, Task B $20 PASS, Task C $10 FAIL: $35 captured, with the remaining $15 authorization voided. The $15 is an unused authorization amount, **not a refund**.

## Requirements

- Node.js with built-in `fetch` support.
- PayPal Developer sandbox REST app credentials.
- Optional OpenAI API key for semantic verification of the report summary.

## Run locally

1. Copy `.env.example` to `.env`.
2. Add your PayPal sandbox REST client ID and secret to `.env`. Never commit `.env`.
3. To enable semantic verification, set `OPENAI_API_KEY` in `.env`. `OPENAI_MODEL` defaults to `gpt-4.1-mini`. Without the key, the controlled demo uses deterministic checks only.
4. Install and start:

   ```bash
   npm install
   npm test
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000).
6. First click **Preview verification (no payment)**. This exercises the verifier but never creates or changes a PayPal transaction. With `OPENAI_API_KEY` configured, this does call OpenAI and may incur API usage cost.
7. For a full payment demo, create an order, approve it using a sandbox Personal buyer, authorize it, then run the demo on the new authorization. Never reuse a completed or voided authorization.

## Verification and payment policy

The deterministic verifier is a hard gate for required fields and explicit checks. When `OPENAI_API_KEY` is configured, Task A's natural-language summary also receives an OpenAI Responses API semantic review using a strict JSON schema.

The AI model has no payment tools and cannot call PayPal. The backend validates the AI response. If the AI says FAIL or REVIEW, returns malformed output, times out, or is unavailable, the task is not captured. A completed AI PASS may satisfy the semantic check only after the deterministic task checks already passed. Tasks B and C retain their deterministic checks.

This is a small demo policy, not a calibrated fraud, truth, or quality guarantee. The model cannot prove statements are factually correct without source data. Human review and more comprehensive acceptance tests are needed for ambiguous real-world tasks.

## API overview

- `GET /api/health` — backend and verifier mode.
- `POST /api/verification-preview` — verify the sample tasks without calling PayPal payment endpoints; may call OpenAI when configured.
- `POST /api/orders` — create a $50 sandbox order.
- `POST /api/orders/:orderId/authorize` — authorize an approved order created by this server.
- `GET /api/authorizations/:authorizationId` — query PayPal status and local capture totals.
- `POST /api/authorizations/:authorizationId/run-demo` — run the controlled single-use demo.
- `POST /api/authorizations/:authorizationId/capture` — bounded manual partial capture endpoint.
- `POST /api/authorizations/:authorizationId/void` — reconcile and void the unused authorization.
- `GET /api/state` — read local demo state.

## Limitations and security

- Use only PayPal **sandbox** credentials. Do not expose credentials in browser code or commit them to Git.
- The JSON file and in-process mutation queue are single-process demo storage, not suitable for multi-instance or production payment concurrency.
- API endpoints do not currently implement user authentication or authorization. Do not expose this server to the public internet.
- Store only synthetic or non-sensitive evidence in the prototype.
- Never retry a capture whose outcome is uncertain until its status is reconciled with PayPal.
- A successful authorization void releases the remaining authorization; it does not reverse completed captures.

## References

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [PayPal Orders API](https://developer.paypal.com/docs/api/orders/v2/)
- [PayPal Payments API](https://developer.paypal.com/docs/api/payments/v2/)
