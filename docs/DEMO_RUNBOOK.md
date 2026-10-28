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

Open [http://localhost:3000](http://localhost:3000). The default server binding is `127.0.0.1`.

## Safer preview-first workflow

1. Confirm the dashboard shows the backend as connected and displays the expected verifier mode.
2. Click **Preview verification (no payment)** before creating an order.
3. Show the three acceptance criteria, synthetic evidence, decisions, verifier provenance, and the preview totals of $0 captured / $0 uncertain.
4. Explain that this preview can call Groq, but does not call PayPal payment endpoints. Do not confuse a Groq API call with a payment.
5. Confirm Task C is blocked because its conclusion is missing. If Task A returns REVIEW, explain that this is the intentional fail-closed path.

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

**0–15s — Problem:** “An agent can produce multiple pieces of work, but payment should depend on verified outcomes, not merely on a model saying it finished.”

**15–30s — Idea:** “Pay-on-Proof separates evidence checking from payment execution. Deterministic rules are hard gates. Groq is optional and advisory; it never receives payment tools.”

**30–50s — Preview:** “Here are the task criteria and synthetic evidence. Task C is intentionally incomplete. The preview can ask Groq to review Task A, but the preview has zero payment side effects.”

**50–75s — Payment:** “For a fresh sandbox authorization, the backend creates a partial capture only for a PASS. A FAIL or REVIEW does not trigger a capture. Each capture is tied to a task record and a stable idempotency key.”

**75–90s — Safety and impact:** “The demo records provenance and provider status, treats ambiguous capture outcomes as unresolved, and requires reconciliation before voiding. This is a sandbox proof of concept; production use would need authenticated users and durable transactional storage.”

## Final checklist

- [ ] Correct branch merged to `main`; CI passing on the final commit.
- [ ] `npm test` passes locally.
- [ ] Groq smoke test passes when a live key is available, or deterministic fallback is clearly shown.
- [ ] Preview reports zero payment side effects.
- [ ] No live credentials, buyer personal details, or real payment data appear in screenshots.
- [ ] Full payment demo uses a new authorization, never an old completed/voided one.
- [ ] Captures reconciled before void.
- [ ] README, submission brief, architecture, and this demo sequence match the code that will be judged.
