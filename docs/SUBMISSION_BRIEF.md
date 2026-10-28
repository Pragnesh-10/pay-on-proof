# Pay-on-Proof — Submission Brief

## One-line pitch

**Pay-on-Proof makes agentic work payable by evidence:** verify each task against acceptance criteria, then capture only the amount assigned to tasks that pass.

## Hackathon track positioning

**Recommended primary category: AI Agents or Automation.**

The product demonstrates a workflow that can take a payment action on a user's behalf after a verified task decision: the backend evaluates task evidence, enforces deterministic gates and payment limits, then can submit a PayPal sandbox partial capture for eligible work. This is more than returning a recommendation—the workflow can transact. The AI model is deliberately not given payment tools or credentials.

**Secondary category: Business Solutions.** A marketplace, service platform, or business could use this pattern to pay for staged work such as generated reports, data validation, or other deliverables with explicit acceptance criteria.

**Supporting category: Money Movement Experiences.** Pay-on-Proof demonstrates per-task partial captures and release of unused authorization, but its main differentiation is the verification-to-payment control layer rather than a novel consumer transfer method.

The current implementation remains a sandbox prototype. The custom artifact path has a separate explicit capture action; the controlled demo can automatically process its predefined task bundle after the user starts the run. Avoid claiming fully autonomous general-purpose agents or production readiness.

## The problem

Agentic systems can produce multiple pieces of work, but payment can be difficult to align with the quality or completeness of each result. Paying the full amount before validation shifts the risk to the buyer; paying the full amount only after everything is complete can be too coarse for work delivered in stages. The core product question is: **how can a payment system make a task-level decision auditable without giving an AI model authority over money?**

This is the problem framing for this prototype, not a claim that all existing payment workflows behave this way.

## The solution

Pay-on-Proof uses a PayPal sandbox authorization as a bounded payment envelope, then evaluates a small, controlled task bundle:

| Task | Evidence rule | Amount | Intended result |
|---|---|---:|---|
| A — Generate a report | Required fields plus optional Groq semantic review | $15 | PASS in the expected demo path |
| B — Validate results | Three explicit checks must all pass | $20 | PASS |
| C — Produce a summary | A non-empty conclusion is required | $10 | FAIL because the conclusion is missing |

The intended full run captures $35 using two non-final partial captures and then releases the unused $15 authorization. The AI response is not guaranteed, so Task A can instead return REVIEW; in that case the backend must not capture Task A.

**Important:** voiding the unused authorization is not a refund. A capture that has already completed is not reversed by voiding the remainder.

## Why this design

- **Deterministic hard gates first.** Required fields and explicit checks are evaluated before any model request.
- **AI is advisory, not an operator.** Groq can assess whether a report summary meaningfully communicates a result. It has no PayPal tools and cannot execute captures.
- **Fail closed.** FAIL, REVIEW, malformed output, provider failure, or ambiguity never qualifies that task for capture.
- **Task-level partial capture.** A passing task can be captured without finalizing the full authorization.
- **Payment-provider reconciliation.** PayPal remains the authority for authorization/capture status. Ambiguous capture attempts stay reserved and can be reconciled with their original idempotency key.
- **Proof Receipts.** Each task can be exported with canonicalized evidence and acceptance-criteria SHA-256 hashes, a receipt hash, verifier provenance, human-review outcome, payment status, and event history. Hashes detect snapshot changes; they do not establish truth.
- **Human review for ambiguity.** A REVIEW task can be explicitly approved or rejected with notes. Approval re-runs deterministic requirements, checks current PayPal authorization state and budget, refuses unresolved earlier captures, records the reviewer decision, and uses a stable request ID for a single capture attempt. Rejection makes no capture call.
- **Three-scenario simulator.** PASS, REVIEW, and FAIL use synthetic fixtures and are explicitly simulation-only. They never call PayPal, and their receipts are marked non-authoritative.
- **Inspectable audit trail.** The dashboard shows task evidence, acceptance criteria, verification decision, source/model provenance, capture status, review history, receipt downloads, and response payloads.

## Architecture at a glance

- **Browser:** lightweight dashboard for preview, checkout, authorization, task run, reconciliation, status refresh, and void.
- **Node.js + Express:** owns payment credentials, decision gating, API calls, state transitions, and persisted audit records.
- **Deterministic verifier:** validates the controlled task schema and explicit task checks.
- **Groq API:** optional semantic reviewer for Task A only. Structured output is validated again by the application.
- **PayPal sandbox:** handles buyer approval, authorization, partial captures, authoritative status lookups, and voiding.
- **Local JSON state:** records orders, authorization state, capture attempts, task decisions, and identifiers for this single-process demonstration.

See [Architecture](ARCHITECTURE.md) for the sequence and trust boundaries.

## What is implemented

- $50 USD authorization order with a single purchase unit.
- Explicit order approval and authorization steps; checkout return does not itself imply authorization.
- Deterministic and optional AI-assisted verification.
- Payment-free verifier preview and PASS / REVIEW / FAIL simulator with zero payment side effects.
- Downloadable single-task and bulk Proof Receipts with SHA-256 hashes and explicit simulation labeling.
- Human-review queue with reviewer notes, deterministic re-checks, live authorization/budget checks, and audit events.
- Partial capture for PASS tasks with `final_capture: false`.
- A single-use demo guard per authorization.
- Budget checks, capture idempotency IDs, uncertain-outcome tracking, reconciliation, and void verification.
- Automated tests and a GitHub Actions test workflow.
- A live Groq smoke-test command that does not call PayPal payment endpoints.

## User-supplied artifact workflow

A user can upload a bounded JSON or CSV artifact and define structural acceptance rules: required fields, one optional unique field, optional numeric fields, and a minimum record count. The server records the raw artifact digest and a three-row preview, and returns explicit per-rule results. Malformed artifacts route to REVIEW. A preview receipt is labelled simulation-only and has no payment side effects.

A verified artifact can be attached to a selected local PayPal sandbox authorization at a stated task amount. Saving is separate from capturing. The capture endpoint requires the stored artifact task to have PASS, checks live authorization status, available budget, unresolved attempts, and duplicate task captures, persists a stable request ID before the provider call, and returns the task receipt. FAIL and REVIEW cannot be captured through this route.

The receipt verifier recomputes the evidence, acceptance-criteria, and receipt hashes. When the original artifact bytes are supplied, it checks their raw SHA-256 digest too. This detects tampering; it does not prove claims in the artifact are factually true or establish an authenticated issuer.

## Evidence and honest limits

**Observed during development:** the live Groq smoke test returned `PASS` for the synthetic sentence “Revenue increased by 8% compared with the previous quarter,” with model `openai/gpt-oss-20b` and reported latency of 771 ms. That result demonstrates connectivity and decision parsing for that request only; it is not a model-accuracy benchmark.

**Not established by that result:** broad semantic accuracy, factual truth of report claims, production payment safety under concurrent processes, or reliability under all PayPal/Groq errors. The evidence is synthetic. Expected demo outcomes are controlled examples, not user-study results or performance claims.

## Scope and security boundary

This is a **hackathon sandbox prototype**, not a production payment service.

- Use PayPal sandbox credentials only.
- Keep the server local. API routes do not implement user authentication or authorization; reviewer names are unverified audit labels only.
- The JSON state and in-process mutation queue are not safe for multi-instance deployments.
- Do not submit real personal, financial, or confidential work evidence.
- If a capture result is uncertain, do not guess. Reconcile the exact capture attempt and review PayPal status before voiding or starting another capture. Human review does not bypass unresolved-capture safeguards.
- Proof Receipt hashes detect changes to recorded snapshots, not dishonest or false evidence. Human review does not bypass unresolved-capture safeguards.
- Proof Receipt hashes detect changes to recorded snapshots, not dishonest or false evidence.
- A resolved run that stopped mid-sequence is not resumed automatically.

## Next steps beyond the hackathon

1. Replace local JSON storage with a transactional database and durable job/outbox model.
2. Add authenticated users, per-order authorization, audit access control, CSRF/rate-limit defenses where relevant, and secret management.
3. Model capture transitions explicitly and test against PayPal sandbox simulations for timeouts, duplicates, pending results, and provider errors.
4. Build a reviewed acceptance-criteria schema and an evidence provenance layer tied to source artifacts.
5. Evaluate AI decisions on a versioned dataset with human-labelled ground truth and track false-pass/false-fail rates before using the approach beyond a demo.
