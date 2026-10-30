# Pay-on-Proof — Submission Brief

## One-line pitch

**Pay-on-Proof connects independently checked work to task-level PayPal payments:** a buyer freezes the source data and acceptance contract before submission; the backend verifies the returned output and permits a partial capture only for a passing task.

## Hackathon positioning

The PayPal AI Hackathon does not prescribe product tracks. The most defensible current award positioning is **Best Use of PayPal + AI**. The existing controlled demo uses Groq for one narrow advisory semantic review, while backend rules control payment execution. The new reference-backed data workflow adds a stronger, deterministic proof path.

Do not claim a fully autonomous worker agent or a complete agentic marketplace yet. The current project does not generate the worker's deliverable with an AI agent, and the payment demo does not disburse funds to a separate contractor payee. Those remain future integrations.

## The problem

A buyer needs a way to pay for submitted work without relying only on the worker's statement that the task passed. Milestone payment tools already support staged work and human approval. Pay-on-Proof explores a narrower automation layer: evaluate a concrete deliverable against a buyer-approved contract, keep uncertain cases out of automatic payment, and record the decision and payment outcome.

This is a product hypothesis for structured digital work. The project has not yet measured dispute reduction, faster settlement, or business productivity gains.

## The solution

Pay-on-Proof combines three parts:

1. **Buyer-approved task contract.** The buyer uploads a source dataset and freezes the amount, key field, fields that must remain unchanged, and deterministic formula rules on a local PayPal sandbox authorization.
2. **Independent output verification.** The worker submits a JSON or CSV result separately. The backend uses the previously stored source rows and contract. It checks unique record keys, complete key coverage, unchanged source fields, and calculated numeric outputs. It does not accept worker-supplied `passed: true` flags.
3. **Payment policy and Proof Receipt.** Verification returns PASS or FAIL; unparseable output returns REVIEW. Submission itself never calls PayPal. Only a stored PASS task is eligible for a separate, explicitly confirmed partial capture after live authorization, budget, duplicate-attempt, and unresolved-capture checks.

### Worked example: invoice line reconciliation

The demo contract uses buyer-provided invoice rows with `id`, `quantity`, `unitPrice`, and `description`. It freezes `id`, `quantity`, `unitPrice`, and `description` as preserved fields, then checks that the worker's `lineTotal` equals `quantity × unitPrice` for every source record.

The repository includes:
- `examples/buyer-invoice-source.json`
- `examples/worker-invoice-output-pass.json`
- `examples/worker-invoice-output-fail.json`

The FAIL fixture contains an incorrect total. It should be rejected even though its JSON structure is valid.

This proves only the configured data-reconciliation rules. It does not authenticate the buyer's source file, prove arbitrary claims, or verify tasks outside the contracted fields and formulas.

## Payment demonstration

A separate controlled integration demo creates a USD 50 PayPal sandbox authorization and runs three synthetic tasks:

| Task | Evidence rule | Amount | Intended result |
|---|---|---:|---|
| A — Generate a report | Non-empty title and summary; optional Groq semantic review | $15 | PASS only if required checks and optional semantic review pass |
| B — Validate results | Three seeded boolean checks | $20 | PASS in the controlled fixture |
| C — Produce a summary | Non-empty conclusion | $10 | FAIL because the conclusion is absent |

The intended synthetic path captures $35 using two non-final partial captures, then voids the unused $15 authorization. This is not a refund. These seeded tasks demonstrate payment orchestration and recovery; they are not independent evidence that real work was correctly performed.

## What makes this different

- The buyer's source dataset and acceptance rules are stored before the worker output is submitted.
- The output route does not accept replacement source data or replacement acceptance rules.
- The verifier recalculates contracted fields instead of trusting a worker's success flags.
- A failed or ambiguous submission does not trigger payment.
- The backend keeps financial execution separate from AI output.
- Proof Receipts preserve the source/output digests, criteria, checks, decision, payment status, and event history.

We do not claim that partial capture, milestone payments, or escrow-like workflows are new. PayPal already supports authorization and capture, and freelance platforms already support milestone approval. The differentiation being tested is the buyer-reference verification step and its connection to a guarded task-level capture.

## Architecture at a glance

- **Browser:** dashboard for authorization, contract creation, worker-output submission, verification, explicit capture, reconciliation, and receipts.
- **Node.js + Express:** owns credentials, state transitions, verification routes, capture policy, and audit records.
- **Reference verifier:** parses bounded JSON/CSV source and output data; compares keys and preserved fields; recomputes declared arithmetic formulas.
- **Controlled task verifier:** deterministic checks plus optional Groq semantic review for Task A in the seeded payment demo only.
- **PayPal sandbox:** order approval, authorization, partial captures, status refresh, reconciliation, and voiding.
- **Local JSON state:** stores authorizations, attempts, contracts, parsed buyer source rows, task decisions, and identifiers for this single-process local demonstration.

See [Architecture](ARCHITECTURE.md) for sequence and trust boundaries.

## What is implemented

- USD 50 sandbox order with intent `AUTHORIZE`, buyer approval, and explicit authorization.
- Reference-contract creation on an active authorization. Source data and criteria are stored before output submission.
- One worker-output submission per contract.
- Independent checks for unique keys, record count, complete source-key coverage, preserved source fields, and formula-derived numeric fields.
- PASS/FAIL decisions for parseable output; malformed output routes to REVIEW.
- Stored reference-backed tasks are eligible for the existing explicit PASS-only capture endpoint.
- Existing controlled demo with optional Groq review for Task A, deterministic fixture checks for B/C, and partial capture.
- Capture idempotency IDs, pre-call persistence, uncertain-outcome tracking, reconciliation, and void safeguards.
- Human-review queue, scenario simulator, Proof Receipts, and receipt hash validation.
- Automated unit and mock-provider integration tests.

## Evidence and honest limits

The reference verifier is deterministic, not AI. Its assurance is bounded to the buyer source rows and contract rules it receives. A buyer who supplies false source data or weak acceptance criteria can still create a bad contract. The prototype has not authenticated the buyer identity or source-system provenance.

The optional Groq reviewer handles one narrow semantic check in the controlled report task. It does not prove factual truth and has no payment tools. The current synthetic evaluation fixture set is not a representative benchmark; no production accuracy percentage is claimed.

The current PayPal order captures to the merchant/payee associated with that order. This prototype does not implement a separate worker payee, seller onboarding, marketplace split, or payout/disbursement flow. Therefore it demonstrates conditional capture, not a complete buyer-to-contractor settlement product.

PayPal authorization timing also constrains long-running jobs. The product does not yet implement expiry monitoring, reauthorization, or a durable long-running payment lifecycle.

## Scope and security boundary

This is a **local PayPal sandbox prototype**, not a production payment service.

- Use sandbox credentials only. Keep `.env` out of Git and out of submission archives. Rotate any key that has been included in a shared archive or chat.
- Keep the server on loopback. API endpoints do not implement authentication or authorization; reviewer labels are not authenticated identities.
- The JSON state and in-process mutation queue are single-process demo storage, not safe for multi-instance payment concurrency.
- Buyer source rows are stored in the local JSON state file so the verifier can compare future submissions. Use synthetic or non-sensitive evidence only.
- Reference checks do not authenticate who supplied the buyer source, do not prove external facts, and do not cover unconfigured fields.
- Proof Receipt hashes detect changes to recorded snapshots; they are not digital signatures and do not prove truth.
- An uncertain capture reserves the amount. Reconcile the exact attempt before any further capture or void.
- A successful void releases only the unused authorization remainder; it does not reverse completed captures.

## Next steps

1. Add a genuine worker agent that produces the deliverable from the buyer contract; keep the verifier and payment executor separate.
2. Add trusted source connectors or signed buyer-source provenance and expand the deterministic verifier with domain-specific rules.
3. Evaluate verifier decisions on human-reviewed adversarial fixtures, including false-pass and false-fail rates.
4. Explore PayPal multiparty/seller onboarding and payout products for a real worker payee flow, subject to partner eligibility and approval.
5. Add authenticated users, role-based authorization, transactional storage, durable jobs/outbox, webhook handling, and authorization-expiry/re-authorization policies before any production use.
