# Pay-on-Proof — Submission Brief

## One-line pitch

**Pay-on-Proof connects independently checked digital work to PayPal payment and dispute workflows:** a buyer freezes source data and acceptance rules before submission; the backend verifies the output, gates capture on PASS, and prepares transaction-linked evidence for eligible disputes.

## Hackathon positioning

The PayPal AI Hackathon does not prescribe product tracks. The most defensible current award positioning is **Best Use of PayPal + AI**. The project now includes an experimental bounded Groq worker that generates a candidate invoice transformation from a buyer-approved reference contract. A separate deterministic verifier checks the actual output, and backend rules control payment execution.

Do not claim a fully autonomous marketplace agent or complete agentic commerce flow. The worker is an operator-triggered, bounded structured-data helper; it does not negotiate tasks, interact with a worker account, or disburse funds to a separate contractor payee.

## The problem

A business outsourcing structured digital work needs a reliable way to verify whether a deliverable met the agreed requirements before releasing payment. Manual checks cost time, and later disputes can be difficult to investigate when the agreement, source data, delivered artifact, verification steps, and payment record are scattered. Existing milestone and payment products coordinate delivery, approval, and payment; Pay-on-Proof adds a machine-checkable verification layer and a structured evidence record for that specific workflow.

This is a product hypothesis for structured digital work. The project has not yet measured dispute reduction, faster settlement, dispute-win rates, or business productivity gains. The evidence package is a merchant-support aid, not a chargeback-prevention guarantee.

## The solution

Pay-on-Proof combines three parts:

1. **Buyer-approved task contract.** The buyer uploads a source dataset and freezes the amount, key field, fields that must remain unchanged, and deterministic formula rules on a local PayPal sandbox authorization.
2. **Independent output verification.** The worker submits a JSON or CSV result separately. The backend uses the previously stored source rows and contract. It checks unique record keys, complete key coverage, unchanged source fields, calculated numeric outputs, and rejects output columns not named in the contract. It does not accept worker-supplied `passed: true` flags.
3. **Optional AI worker and independent verification.** After explicit consent, the experimental Groq worker can generate candidate JSON from the stored buyer source and frozen rules. It is limited to 50 source records and a 12 KB prompt. The same deterministic reference verifier used for manual output checks its record coverage, preserved fields, and calculations. The model cannot issue PASS or control payment.
4. **Payment policy and evidence record.** Verification returns PASS or FAIL; unparseable output returns REVIEW. Submission itself never calls PayPal. Only a stored PASS task is eligible for a separate, explicitly confirmed partial capture after live authorization, budget, duplicate-attempt, and unresolved-capture checks. A completed capture can be linked to a live PayPal dispute by matching the seller transaction ID to the recorded capture ID. The app then prepares a merchant-review evidence package and, when PayPal explicitly requests `OTHER` evidence, can submit a short `OTHER` note to the sandbox.

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
- Dispute evidence packages tie a local task receipt to a PayPal dispute only when `disputed_transactions[].seller_transaction_id` exactly matches the recorded PayPal capture ID. The package includes the requested evidence types, response deadline, contract metadata, output digest, checks, and a bounded merchant note draft.

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
- Independent checks for unique keys, record count, complete source-key coverage, preserved source fields, formula-derived numeric fields, and an output column allowlist.
- An authored adversarial evaluation command covering valid output, incorrect totals, altered formula inputs, missing/duplicate/unexpected records, uncontracted columns, and malformed output.
- PASS/FAIL decisions for parseable output; malformed output routes to REVIEW.
- Stored reference-backed tasks are eligible for the existing explicit PASS-only capture endpoint.
- Existing controlled demo with optional Groq review for Task A, deterministic fixture checks for B/C, and partial capture.
- Experimental consent-gated Groq worker that generates bounded structured output for a reference contract; output is independently checked by the deterministic verifier and never triggers capture by itself.
- Capture idempotency IDs, pre-call persistence, uncertain-outcome tracking, reconciliation, and void safeguards.
- Human-review queue, scenario simulator, Proof Receipts, and receipt hash validation.
- Dispute evidence package generation, live PayPal dispute lookup, and opt-in sandbox submission of `OTHER` notes only when requested by PayPal.
- Automated unit and mock-provider integration tests.

## Evidence and honest limits

The reference verifier is deterministic, not AI. Its assurance is bounded to the buyer source rows and contract rules it receives. A buyer who supplies false source data or weak acceptance criteria can still create a bad contract. The prototype has not authenticated the buyer identity or source-system provenance.

The optional Groq reviewer handles one narrow semantic check in the controlled report task. The experimental Groq worker can propose a structured invoice transformation from the frozen buyer source after explicit consent. Its result is only a candidate: the deterministic verifier checks the actual output, and AI errors do not produce a PASS. Neither AI component has PayPal tools or payment authority. The worker uses a 50-record limit, a 12 KB prompt limit, and a 20 KB output limit. The current synthetic fixture sets are not representative benchmarks; no production accuracy percentage is claimed. `npm run evaluate:reference` reports expected decisions for eight authored cases and false-PASS/false-reject counts; it measures rule regression behavior only, not real-world accuracy.

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
