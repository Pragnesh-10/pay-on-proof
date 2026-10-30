# Demo Runbook

This runbook is designed for a clean local start and a judge-facing demonstration. All payment steps must use **PayPal sandbox** accounts.

## Before the demo

1. Have a PayPal Developer sandbox REST app and a sandbox Personal buyer account available.
2. Copy `.env.example` to `.env` and enter the sandbox REST client ID/secret. Add a Groq API key if you want the hybrid verifier.
3. Never paste keys into chat, screenshots, the repository, or the browser console.

Example local setup:

```bash
cp .env.example .env
npm install
npm test
npm run test:groq
npm start
```

`npm run test:groq` makes a live Groq request and may incur usage. It makes no PayPal payment request. Skip this command if the live API key is not configured; the automated tests do not require a live Groq key.

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The server accepts only loopback host bindings (`127.0.0.1` or `::1`) while the API has no authentication. It rejects `HOST=0.0.0.0`. Do not place it behind a public reverse proxy or tunnel. The default server binding is `127.0.0.1`.

## Safer preview-first workflow

1. Confirm the dashboard shows the backend as connected and displays the expected verifier mode.
2. Click **Preview verification (no payment)** before creating an order.
3. Show the three acceptance criteria, synthetic evidence, decisions, verifier provenance, and the preview totals of $0 captured / $0 uncertain.
4. Explain that this preview can call Groq, but does not call PayPal payment endpoints. Do not confuse a Groq API call with a payment.
5. Confirm Task C is blocked because its conclusion is missing. If Task A returns REVIEW, explain that this is the intentional fail-closed path.

## Structural artifact verification

1. Select a non-sensitive `.json` or `.csv` file up to 20 KB. JSON must be one object or an array of objects. CSV must have a header row with unique, non-empty column names.
2. Configure required fields, an optional unique field, optional numeric fields, and the minimum record count.
3. Click **Verify artifact (no payment)** first. Inspect each structural check and the source file SHA-256 digest. Malformed input routes to REVIEW; PASS means only that the configured structural checks passed.
4. To attach the artifact to a sandbox authorization, enter/select the authorization ID in **Payment session**, choose a task amount, and click **Save to selected authorization**. This records the result and criteria but does not call PayPal.
5. Only a recorded PASS artifact task displays **Capture verified task**. Confirm the amount before continuing. The backend rechecks live authorization status, budget, unresolved captures, and duplicate attempts. FAIL/REVIEW tasks cannot be captured through this route.
6. Download its Proof Receipt. Upload the receipt JSON to **Verify receipt integrity**. Supply the original artifact file too if you want to compare its raw bytes to the recorded artifact digest.

### One-click bounded automation demo

1. Use a fresh authorized sandbox session and the same non-sensitive artifact. Configure the acceptance rules and amount, then click **Process artifact · capture only on PASS**.
2. Read the confirmation carefully: it names the authorization, artifact, amount, and states that a newly recorded PASS can trigger one sandbox capture. This is the explicit operator consent boundary.
3. On a newly recorded PASS, the dashboard chains verification, task persistence, and one capture request. It then shows the task result and Proof Receipt. The backend's existing live-status, budget, unresolved-capture, and duplicate-attempt checks still govern the capture.
4. REVIEW and FAIL are recorded without capture. If the artifact/task was already recorded, the workflow does not auto-capture it again. Use the separate capture control only after inspecting the existing record.
5. If the capture response cannot be confirmed, stop. Refresh status and reconcile the existing attempt; do not blindly re-run the workflow.

These structural checks validate only the configured rules. They do not establish factual truth or trusted provenance.

## Independent data verification demo

This is the strongest proof-of-work workflow. Use synthetic files from the repository:

- Buyer source: [examples/buyer-invoice-source.json](../examples/buyer-invoice-source.json)
- Deliberately incorrect worker output: [examples/worker-invoice-output-fail.json](../examples/worker-invoice-output-fail.json)
- Correct worker output: [examples/worker-invoice-output-pass.json](../examples/worker-invoice-output-pass.json)

1. Create and authorize a fresh PayPal sandbox order. Use a new authorization with enough remaining budget for the task.
2. In **Independent data verification**, load the buyer source file. Keep the example contract settings: key `id`, preserved fields `quantity,unitPrice,description`, and `lineTotal = quantity × unitPrice`. Enter a task amount such as $10.00.
3. Click **Create and freeze contract**. This stores the parsed buyer source rows, source digest, amount, and rules before worker output is submitted. The contract accepts one submission.
4. Select the failing worker output fixture and click **Verify worker output**. The expected result is FAIL because INV-1001 has an incorrect lineTotal. Show that the backend computed the expected value from the stored buyer source and made no PayPal request.
5. Change the task description/title to a new contract version, for example `Invoice reconciliation - corrected submission`, and create a second contract using the same buyer source, amount, and rules. The title creates a distinct contract ID. Do not attempt to reuse the failed contract.
6. Submit the passing output fixture. The expected result is PASS with the key coverage, preserved-field, and formula checks shown.
7. Inspect the Proof Receipt and explicitly click **Capture verified task** only after reviewing the $10.00 amount. Verify the sandbox capture ID and status, then refresh authorization state.
8. Explain the boundary honestly: this checks the contracted data transformation, not the authenticity of the buyer source or unrelated claims. The source rows are stored in local JSON state; use only synthetic, non-sensitive files.

The reference verification and submission routes make no payment calls. Only the separate capture action can move funds, and only for a stored PASS task after backend checks.

### Adversarial verifier regression check

Run `npm run evaluate:reference` before recording the demo. It exercises eight authored synthetic cases: one correct output, incorrect total, altered formula input, missing record, duplicate record, uncontracted column, unexpected record, and malformed JSON. Inspect the false-PASS and false-reject counts. The script fails CI if any authored case returns an unexpected decision. These cases test the implemented rules; they are not a real-world model accuracy benchmark.

### Optional AI worker experiment

This experimental flow sends buyer source rows to Groq. Use only the repository's synthetic invoice fixture or other non-sensitive sample data.

1. Set `GROQ_AI_WORKER_ENABLED=true` in `.env`. Set `GROQ_WORKER_API_KEY` or reuse `GROQ_API_KEY`. Optionally set `GROQ_WORKER_MODEL`; the default is the configured `GROQ_MODEL` or `openai/gpt-oss-20b`. Leave `GROQ_WORKER_API_URL` blank for normal use; non-Groq endpoint overrides are rejected outside automated tests.
2. Restart the local server. Check `GET /api/health` and confirm `aiWorkerEnabled` is true.
3. Create a new buyer reference contract using synthetic source rows. The AI worker consumes the contract's one permitted submission.
4. Click **Generate with AI worker + verify**. Read the data-sharing confirmation carefully. The frozen buyer rows and rules are sent to Groq only after you confirm. Cancel if the data is sensitive or you do not have permission to share it.
5. Inspect the worker model, output hash, duration, and individual deterministic checks. The AI does not decide PASS/FAIL. An incorrect generated total should be rejected; a correct generated total can pass.
6. If the result is PASS, inspect the Proof Receipt and use the existing separate **Capture verified task** control only after explicit confirmation. FAIL and REVIEW never trigger capture.
7. If Groq is unavailable, times out, refuses, or returns invalid JSON, no submission is recorded and the contract remains available for manual output. Once a generated output has been recorded as PASS/FAIL/REVIEW, that contract cannot be reused.

The AI worker is disabled by default, bounded to 50 rows, 12 KB of serialized buyer input, and 20 KB of generated output. It has no PayPal tools. A candidate output may be wrong; the deterministic verifier remains the authority.

## New product flows: simulator, review, and receipts

1. Choose **Simulate PASS**, **Simulate REVIEW**, and **Simulate FAIL**. Each scenario uses synthetic evidence and reports the hypothetical payment policy. It explicitly identifies itself as simulation-only; no PayPal endpoint is called and the actual captured amount remains $0.
2. Download the simulation Proof Receipt. Point out the evidence hash, acceptance-criteria hash, and receipt hash. Hashes detect changes to recorded data; they are not a truth guarantee.
3. For an actual authorization run, refresh status and inspect the **Human review queue**. An actual REVIEW task appears there only after it has been recorded for the authorization.
4. For ambiguous evidence, enter reviewer name and notes. **Reject — no capture** records the decision without a PayPal capture request. **Approve & capture** requires confirmation and may send a real PayPal sandbox capture. It is only allowed for a recorded REVIEW task whose deterministic hard gates pass and whose authorization is currently capturable.
5. Download the Proof Receipt for a reviewed task or use **Download all receipts**. The receipt preserves the original verifier decision separately from the human decision and records payment status and event history.

The reviewer identity is not authenticated in this prototype. Do not expose the review endpoint publicly or use it for real funds.

## PayPal dispute evidence demo (optional)

This flow requires a sandbox merchant REST app with the **Disputes** feature enabled and a sandbox dispute whose seller transaction ID matches the completed task capture. Sandbox dispute creation uses PayPal's buyer-side test flow and may require a separate buyer-side auth assertion. Follow [Dispute evidence setup](DISPUTE_EVIDENCE.md) before attempting this section.

1. Capture a reference-backed task in the sandbox and keep its completed capture ID.
2. Create a matching dispute using PayPal's documented sandbox transaction/dispute process. Do not use a dispute ID tied to another payment.
3. In the result panel for the completed task, click **Prepare PayPal dispute evidence** and enter the dispute ID.
4. Inspect the fetched dispute reason, seller response deadline, requested evidence types, transaction match, and merchant note draft. Download the JSON evidence package.
5. If the backend reports that PayPal is waiting for seller `OTHER` evidence, review the generated note carefully. To submit it, enable `PAYPAL_DISPUTES_EVIDENCE_SUBMISSION_ENABLED=true`, restart the local server, and explicitly confirm the dashboard prompt.
6. The app records the submission attempt before calling PayPal. If the outcome is uncertain, inspect the PayPal dispute directly. Do not retry blindly.

Only `OTHER` notes are supported. The app does not upload attachments or synthesize fulfillment, tracking, or refund evidence. A successful API response means PayPal accepted the evidence submission request, not that the merchant won the dispute.

## Full sandbox payment demo

Only continue after the preview is behaving correctly.

1. Click **Create order**. The browser opens the PayPal sandbox approval page.
2. Approve using a sandbox Personal buyer.
3. Return to the dashboard. Paste the order ID if it is not already populated, then click **Authorize order**.
4. Inspect the returned authorization ID/status, then click **Run task demo** once.
5. Wait for the task log. A passing task should show a PayPal capture status and capture ID. FAIL/REVIEW tasks must show `NOT_ATTEMPTED`.
6. Click **Refresh status** and inspect the authoritative authorization status and captured/uncertain totals.
7. If no capture is uncertain, click **Void remaining authorization** and confirm. Check that the response verifies status `VOIDED`.
8. Explain that the unused authorization amount was released; it was not a refund for any completed capture.

### Expected controlled outcome

The intended path is:

- Task A: PASS, $15 captured.
- Task B: PASS, $20 captured.
- Task C: FAIL, $10 not captured.
- Total: $35 captured.
- Remaining authorization: $15 voided.

The AI model can return REVIEW for Task A, in which case the system must not capture that task. That is a valid safety outcome, not grounds to claim that AI is deterministic.

## If a capture outcome is uncertain

1. Do not run another task demo or void the authorization immediately.
2. Inspect the **Audit response** and verify the authorization/capture state in the PayPal sandbox dashboard.
3. Click **Reconcile uncertain captures** only after understanding the warning. The endpoint checks a known capture ID or replays the original idempotency key with the original payload. It may complete the intended capture if PayPal did not accept the first request, but it does not create a second capture for an idempotency key PayPal still retains.
4. If any attempt remains uncertain, stop and continue investigating with PayPal. Do not claim the run completed successfully.
5. If reconciliation resolves a run that stopped halfway, the app does not resume remaining tasks. Review the partial result and void the unused remainder only after every capture attempt is resolved, or create a fresh sandbox authorization for a clean run.

## 90-second judge narration

**0–15s — Problem:** “A worker's own success flag is not proof. Paying for digital work needs checks tied to what the buyer originally requested.”

**15–30s — Contract:** “The buyer freezes a source dataset, required fields, and calculation rules before the output is submitted. The backend stores that contract.”

**30–50s — Attack:** “This output has valid JSON but a fabricated line total. Our verifier recomputes the amount from the buyer source and rejects the incorrect result. The failed task cannot be captured.”

**50–70s — Passing work:** “A corrected output passes the same buyer-approved contract checks: every source record is present once, protected fields are unchanged, and calculated values match the formula.”

**70–90s — Payment and limits:** “Only then can an operator confirm a PayPal sandbox partial capture. The Proof Receipt records the source and output hashes, checks, decision, and provider result. The verifier is narrow and deterministic; this prototype does not authenticate source provenance or pay a separate contractor account.”

## Final checklist

- [ ] Correct branch merged to `main`; CI passing on the final commit.
- [ ] `npm test` passes locally.
- [ ] Groq smoke test passes when a live key is available, or deterministic fallback is clearly shown.
- [ ] Preview reports zero payment side effects.
- [ ] No live credentials, buyer personal details, or real payment data appear in screenshots.
- [ ] Full payment demo uses a new authorization, never an old completed/voided one.
- [ ] Captures reconciled before void.
- [ ] PASS / REVIEW / FAIL simulator explicitly shows zero payment side effects.
- [ ] Failure-injection tests confirm an ambiguous capture reuses the same request ID, pending captures remain unresolved, and void stays blocked until resolution.
- [ ] Startup refuses non-loopback `HOST` values.
- [ ] Any human approval was intentional, reviewed, and sandbox-only; uncertain outcomes were reconciled.
- [ ] Proof Receipts have accurate capture IDs/status; simulation receipts are not presented as real transactions.
- [ ] Artifact preview reports zero payment side effects and malformed files never produce PASS.
- [ ] Reference-backed demo shows the deliberately wrong invoice total rejected and the corrected output accepted.
- [ ] Buyer source and contract are created before worker output; a failed contract is not reused for a second submission.
- [ ] No claim is made that the reference verifier authenticates the source or validates arbitrary business truth.
- [ ] No claim is made that this build pays a separate worker/contractor payee.
- [ ] Artifact capture is attempted only from a saved PASS task after explicit confirmation; FAIL/REVIEW remains uncaptured.
- [ ] Receipt verifier accepts intact receipts and rejects tampered evidence, criteria, and receipt hashes.
- [ ] README, submission brief, architecture, and this demo sequence match the code that will be judged.
