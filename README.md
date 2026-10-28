# Pay-on-Proof

A PayPal sandbox prototype for **AI Agent Automation**: verify task evidence against acceptance criteria, then let a controlled backend workflow capture the PayPal amount assigned to passing work. This is a hackathon prototype for task-level payments, auditable decisions, and conservative recovery—not a production payment service.

> **Prototype status:** hackathon/demo software only. It is not a production payment service. Use sandbox credentials only.

## Hackathon track fit

**Primary track: AI Agents or Automation.** Pay-on-Proof is a transacting workflow, not just an assistant that recommends whether to pay. A user starts a bounded sandbox workflow; the backend evaluates task evidence, and a passing task can trigger a real PayPal sandbox partial capture. The LLM is advisory and cannot call PayPal directly. The backend applies hard gates, budgets, idempotency, and reconciliation safeguards.

**Secondary fit: Business Solutions.** The use case is a platform or business paying for staged deliverables from contractors or AI-enabled services, with task-level criteria and a reviewable payment record.

**Supporting fit: Money Movement Experiences.** The system demonstrates partial captures and releasing unused authorization, but the product's central value is the verification-to-payment automation—not a new payment rail or a general consumer transfer experience.

## What works

- Creates a single $50 USD PayPal sandbox order with intent `AUTHORIZE`.
- Records orders and authorizations in a local JSON state file.
- Verifies three controlled demo tasks and records evidence, decisions, and capture IDs.
- Captures passing tasks as partial captures with `final_capture: false`.
- Blocks repeated demo runs for an authorization.
- Queries PayPal for the authoritative authorization status and verifies voiding of the unused authorization.
- Serves a browser dashboard from `public/index.html`.
- Provides a verification preview endpoint and dashboard button that run the verifier without contacting PayPal's payment endpoints. If AI is configured, the preview still makes a Groq API request and may incur usage cost.
- Offers a PASS / REVIEW / FAIL simulator using synthetic evidence; scenarios are payment-free and explicitly labelled as simulations.
- Generates downloadable Proof Receipts with evidence, criteria, verifier provenance, review decision, payment outcome, event history, and SHA-256 hashes.
- Provides a human-review queue for recorded REVIEW tasks. Approval re-checks deterministic gates, PayPal authorization status, budget, and unresolved captures before attempting a sandbox capture; rejection makes no capture request.
- Verifies user-supplied JSON and CSV artifacts (20 KB, 500 records, and 100 columns maximum) against explicit required-field, uniqueness, numeric-field, and minimum-row criteria. Unparseable artifacts route to REVIEW.
- Saves verified artifacts as task records on a selected sandbox authorization and allows a separate explicit capture action only for a recorded PASS artifact task.
- Recomputes Proof Receipt integrity hashes, with an optional comparison against the original artifact bytes.
- Includes an optional labelled synthetic Groq evaluation script that reports false-pass, false-fail, review, exact-match, provider-error, and latency metrics. The small authored fixture set is not a validated benchmark.

The controlled demo's intended results are Task A $15 PASS, Task B $20 PASS, Task C $10 FAIL: $35 captured, with the remaining $15 authorization voided. The $15 is an unused authorization amount, **not a refund**.

## Requirements

- Node.js with built-in `fetch` support.
- PayPal Developer sandbox REST app credentials.
- Optional Groq API key for semantic verification of the report summary.

## Run locally

1. Copy `.env.example` to `.env`.
2. Add your PayPal sandbox REST client ID and secret to `.env`. Never commit `.env`.
3. To enable semantic verification, set `GROQ_API_KEY` in `.env`. `GROQ_MODEL` defaults to `openai/gpt-oss-20b`. Without the key, the controlled demo uses deterministic checks only.
4. Install and start:

   ```bash
   npm install
   npm test
   npm start
   ```

5. Run `npm run test:groq` to check the live Groq API integration without touching PayPal. This sends a small test prompt to Groq and may incur API usage; it prints the decision and latency but never makes a payment request.
6. To evaluate semantic decisions on the small labelled synthetic fixture set, run `npm run evaluate:groq`. This makes several live Groq requests and no payment requests. It reports observed metrics; do not treat the fixture set as an accuracy benchmark or ground-truth dataset.
7. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).
8. First click **Preview verification (no payment)**. This exercises the verifier but never creates or changes a PayPal transaction. With `GROQ_API_KEY` configured, this does call Groq and may incur API usage cost.
9. For a full payment demo, create an order, approve it using a sandbox Personal buyer, authorize it, then run the demo on the new authorization. Never reuse a completed or voided authorization.

## Verification and payment policy

The deterministic verifier is a hard gate for required fields and explicit checks. When `GROQ_API_KEY` is configured, Task A's natural-language summary also receives a Groq Chat Completions API semantic review using a strict JSON schema.

The AI model has no payment tools and cannot call PayPal. The backend validates the AI response. If the AI says FAIL or REVIEW, returns malformed output, times out, or is unavailable, the task is not captured. A completed AI PASS may satisfy the semantic check only after the deterministic task checks already passed. Tasks B and C retain their deterministic checks.

This is a small demo policy, not a calibrated fraud, truth, or quality guarantee. The model cannot prove statements are factually correct without source data. Human review and more comprehensive acceptance tests are needed for ambiguous real-world tasks.

## API overview

- `GET /api/health` — backend and verifier mode.
- `POST /api/verification-preview` — verify sample tasks without calling PayPal payment endpoints; may call Groq when configured.
- `POST /api/artifacts/verify` — verify a JSON/CSV artifact against explicit structural criteria and return a simulation-only Proof Receipt. It does not call payment endpoints.
- `POST /api/authorizations/:authorizationId/artifact-tasks` — attach an artifact verification to a recorded sandbox authorization without capturing money.
- `POST /api/authorizations/:authorizationId/artifact-tasks/:taskId/capture` — capture only a recorded PASS artifact task after live status, budget, unresolved-capture, and duplicate-attempt checks.
- `POST /api/receipts/verify` — independently check receipt hashes and optionally compare supplied original artifact bytes.
- `GET /api/scenarios` and `POST /api/scenarios/:scenarioId/simulate` — run payment-free `pass`, `review`, and `fail` simulations.
- `POST /api/authorizations/:authorizationId/tasks/:taskId/review` — record a human decision on an unreviewed REVIEW task; APPROVE may attempt one sandbox capture after policy checks, REJECT never captures.
- `GET /api/authorizations/:authorizationId/receipt/:taskId` — download a single task Proof Receipt.
- `GET /api/authorizations/:authorizationId/receipts` — export all task Proof Receipts.
- `npm run test:groq` — run a local, payment-free Groq API smoke test.
- `POST /api/orders` — create a $50 sandbox order.
- `POST /api/orders/:orderId/authorize` — authorize an approved order created by this server.
- `GET /api/authorizations/:authorizationId` — query PayPal status and local capture totals.
- `POST /api/authorizations/:authorizationId/run-demo` — run the controlled single-use demo.
- `POST /api/authorizations/:authorizationId/capture` — bounded manual partial capture endpoint.
- `POST /api/authorizations/:authorizationId/reconcile` — reconcile unresolved captures using the original request ID, or query a known capture ID.
- `POST /api/authorizations/:authorizationId/void` — verify and void the unused authorization remainder.

Failure recovery is covered with a local mock-provider integration test: a lost capture response replays the same idempotency key, a pending capture remains unresolved until the capture resource confirms completion, and void is blocked until all attempts resolve. The tests never use a real PayPal account.
- `GET /api/state` — read local demo state.

## Submission pack

- [Submission brief](docs/SUBMISSION_BRIEF.md) — problem, value proposition, architecture, differentiators, evidence, and limitations.
- [Demo runbook](docs/DEMO_RUNBOOK.md) — clean setup, safe demo sequence, expected outcome, and recovery steps.
- [Architecture](docs/ARCHITECTURE.md) — components, decision flow, data persistence, and trust boundaries.
- [Judge Q&A](docs/JUDGE_QA.md) — concise, honest answers to likely technical and product questions.

The repository is released under the [MIT License](LICENSE).

## Limitations and security

- Use only PayPal **sandbox** credentials. Do not expose credentials in browser code or commit them to Git.
- The JSON file and in-process mutation queue are single-process demo storage, not suitable for multi-instance or production payment concurrency.
- API endpoints do not implement user authentication or authorization, including human review. Reviewer names are audit labels, not verified identities. The server now rejects non-loopback `HOST` values and binds only to `127.0.0.1` or `::1`; this is a defensive guard, not a replacement for authentication. Do not expose it publicly without a redesigned authentication/authorization layer and production-grade storage.
- Proof Receipt SHA-256 hashes and the receipt verifier detect recorded changes; they do not prove evidence truth or independently trusted provenance. Deterministic artifact checks assess structure and configured rules, not domain correctness.
- Store only synthetic or non-sensitive evidence in the prototype. Artifact task records store the file digest and a preview of up to three rows, not the full uploaded artifact; avoid confidential fields.
- A capture timeout or server error is treated as uncertain and reserves the amount. Use the dashboard's reconciliation action, which checks a known capture ID or replays the exact original request ID and payload. PayPal documents idempotency for repeated requests using the same `PayPal-Request-Id`; still inspect transaction status before voiding the remainder.
- If reconciliation resolves a run that stopped midway, the app intentionally does not resume the remaining tasks automatically. Review the task log and PayPal state, then void the unused remainder or start a fresh sandbox authorization for another complete run.
- A successful authorization void releases the remaining authorization; it does not reverse completed captures.

## References

- [Groq Chat Completions API](https://console.groq.com/docs/text-chat)
- [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs)
- [Groq supported models](https://console.groq.com/docs/models)
- [PayPal Orders API](https://developer.paypal.com/docs/api/orders/v2/)
- [PayPal Payments API](https://developer.paypal.com/docs/api/payments/v2/)
- [PayPal REST API idempotency and request IDs](https://developer.paypal.com/api/make-api-requests/)
