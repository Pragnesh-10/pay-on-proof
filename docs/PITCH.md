# Pitch and demo script

## Three-minute pitch

| Time | Slide | Script |
|---|---|---|
| 0:00–0:20 | Pay-on-Proof | "We connect digital-work verification to PayPal payment workflows. Our first use case is structured invoice reconciliation." |
| 0:20–0:45 | Problem | "A buyer outsources data processing, but a submitted file can be structurally valid and still contain incorrect calculations. The buyer must compare it with the source before paying." |
| 0:45–1:15 | Buyer-approved contract | "The buyer freezes the source, unique key, preserved fields, formula rules, and task amount before work begins. The authorization budget is reserved for the task." |
| 1:15–1:45 | Independent verification | "The backend checks record coverage, duplicate keys, preserved source fields, calculated values, and contracted output columns. It does not trust worker-supplied success flags." |
| 1:45–2:15 | Bounded AI worker | "After explicit consent, Groq can generate candidate JSON from the frozen source. The deterministic verifier decides PASS, FAIL, or REVIEW. AI has no PayPal tools." |
| 2:15–2:40 | PayPal and dispute readiness | "Only a stored PASS becomes eligible for separate, explicit PayPal sandbox capture. A completed capture can be linked to a merchant-review evidence package for an eligible dispute." |
| 2:40–3:00 | Impact and limits | "We start with structured data work. We do not yet authenticate the buyer's source or pay a separate contractor. Our next step is a merchant pilot and an eligible worker payout integration." |

## Two-minute live demo

| Time | Action | What to show |
|---|---|---|
| 0:00–0:20 | Create buyer contract | Source hash, key, preserved fields, formula, and amount. |
| 0:20–0:45 | Submit incorrect invoice output | FAIL on the incorrect total; no capture. |
| 0:45–1:10 | Run AI worker on a new contract | Explicit consent, Groq model provenance, independent checks. |
| 1:10–1:30 | Show corrected manual output as fallback | PASS and formula checks. |
| 1:30–1:45 | Explicitly confirm sandbox capture | Completed capture ID and status. |
| 1:45–2:00 | Prepare eligible dispute evidence | Exact capture match, requested evidence type, merchant note draft. |

## Fallback plan

- If Groq is unavailable, use the repository's passing and failing invoice fixtures.
- If PayPal checkout or capture is unavailable, use the simulator and clearly label the result hypothetical.
- If no matching sandbox dispute exists, skip live dispute submission. Do not invent dispute IDs or claim an evidence package was submitted.
- An AI-generated FAIL or REVIEW consumes that contract's single submission. Create a new contract for a corrected output.

## Safe claims

- The verifier checks a submitted output against buyer source rows and rules frozen before submission.
- The AI worker generates candidate JSON after explicit consent; deterministic code decides acceptance.
- A stored PASS is eligible for a separate, explicit PayPal sandbox capture.
- The dispute package is a merchant-review aid for eligible disputes, not a promise of a favorable outcome.

## Claims to avoid

- Do not call this production escrow or a zero-trust payment service.
- Do not claim it eliminates BEC, invoice fraud, chargebacks, or disputes.
- Do not claim receipt hashes prove source authenticity or delivery.
- Do not claim the app pays a separate contractor payee.
- Do not claim AI proves factual truth or controls payment.
- Do not present authored synthetic fixtures as production accuracy measurements.

## Judge questions

**What is the differentiator?** The buyer freezes source data and machine-checkable acceptance rules before submission. The backend independently checks the output and connects PASS to guarded task-level capture.

**Why use AI?** AI proposes a candidate transformation. Deterministic code checks exact calculations and source preservation. This keeps the model out of payment decisions.

**Does this replace PayPal fraud tools?** No. PayPal transaction-risk systems assess payment fraud. Pay-on-Proof checks whether a specific digital deliverable meets the buyer's contract.

**Does a Proof Receipt win a dispute?** No. It organizes evidence for merchant review. PayPal determines the outcome.

**Can the worker receive funds?** Not yet. The current capture is associated with the merchant/payee on the PayPal order. A separate worker payout requires an eligible PayPal marketplace or payout integration.

**What have you measured?** Unit tests, mock-provider integration tests, and authored adversarial fixtures. We have not measured dispute reduction, merchant time saved, or real-world false-acceptance rates.
