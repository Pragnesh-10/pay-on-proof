# Judge Q&A

## What problem does this solve?

It explores how to make payment decisions depend on a deliverable that the backend checks against a buyer-approved contract, rather than relying only on the worker's claim that the work passed. The current independent-verification example is structured data reconciliation.

## What is the strongest differentiator?

The buyer submits source data and freezes the verification contract before the worker submits output. The backend stores those values, then independently checks unique record keys, full source-key coverage, protected source fields, and formula-derived values. The worker submission cannot replace the source data or rules and cannot make the verifier pass by supplying `passed: true`.

This is deliberately narrower than a general-purpose work verifier.

## How is this different from milestone payments?

Milestone products already support staged deliverables and human approval. Pay-on-Proof does not claim to replace those products. It focuses on one automation layer: independently checking a contracted result against buyer-controlled source data, then connecting a PASS to a guarded PayPal sandbox partial capture.

## Which hackathon award is the best fit?

The hackathon does not prescribe tracks. The most defensible current target is **Best Use of PayPal + AI** because the project combines a narrow AI-assisted review in the controlled report demo with PayPal payment operations and backend decision controls. Do not claim Best Use of Agentic Commerce as an implemented capability yet; there is no worker agent creating the deliverable or separate seller payout flow.

## Is this really an AI agent?

Not yet in the full autonomous-worker sense. The current dashboard orchestrates bounded actions after operator input. Groq provides an advisory semantic review for one predefined report task; the new reference-backed data verifier is deterministic. The accurate description is **evidence-gated payment automation with optional AI-assisted review**. A future worker agent should create the output, while a separate verifier checks it and a separate policy service controls payment.

## How does the independent verifier work?

The buyer creates a contract on an active sandbox authorization before output submission. The contract includes a source file, unique key, preserved fields, deterministic formulas, and amount. The backend validates and stores parsed source rows, source digest, criteria, and contract status. The worker submits only an output file. The server compares the output to the stored source and frozen criteria.

## What happens if the worker submits fake success flags?

The reference-backed route does not read or trust worker-supplied pass booleans. It checks the worker's actual parsed output rows and recalculates the contracted formulas from buyer-source values. For example, the invoice demo rejects a `lineTotal` that does not equal `quantity × unitPrice`.

## Can it detect every kind of fraud or bad work?

No. The reference verifier proves only its explicit checks: keys, record coverage, protected fields, and configured formulas. It cannot establish whether the buyer's source is authentic, whether a formula is the right business rule, or whether unrelated claims are true. We need trusted source connectors and domain-specific checks to expand coverage.

## Can a contract be changed after the worker submits?

A reference contract is stored before submission and accepts one submission. The worker route uses the stored source rows and criteria rather than accepting replacements. A failed submission is retained; a revised attempt needs a newly approved contract. The current prototype has no authenticated buyer identity, so this is a local workflow control rather than a production authorization guarantee.

## Does the system use AI to verify the invoice output?

No. The invoice reconciliation verifier is deterministic. It performs precise comparisons and arithmetic. Groq is used only for the narrow semantic review of Task A in the separate predefined report demo. We avoid sending simple calculations to an LLM because deterministic code is more reliable for those checks.

## Does the AI have payment tools?

No. Groq receives a bounded verification request and returns an advisory structured decision. It does not receive PayPal credentials or payment tools. The backend validates the response and independently enforces the capture policy.

## Can the worker receive the captured funds?

Not in the current implementation. The demo captures against the PayPal authorization associated with the order. It does not onboard a worker as a separate payee or implement seller disbursement. A complete marketplace would need a supported PayPal multiparty/seller or payout integration, plus eligibility and partner approval where required.

## Does the artifact upload automatically move money?

Preview, contract creation, and output submission do not call PayPal payment endpoints. A separate capture action is available only for a stored PASS task. Before capture, the backend rechecks current authorization status, available budget, unresolved captures, void state, and duplicate attempts. FAIL and REVIEW are blocked.

## What prevents duplicate captures?

The server stores each capture attempt before sending it, uses a stable `PayPal-Request-Id`, and reserves unresolved amounts against the budget. For uncertain outcomes, reconciliation queries a known capture or replays the same request ID and payload. A task with an existing capture attempt is blocked from another capture.

## What does a Proof Receipt prove?

It records evidence, contract criteria, verifier provenance and checks, decision, payment status, and event history. SHA-256 hashes detect changes to the recorded snapshot. They do not prove the source file is authentic, the facts are true, or the receipt issuer is authenticated.

## What about PayPal authorization expiry?

Authorization has a limited validity window and the highest capture success is during the initial honor period. The current prototype does not implement authorization expiry monitoring or reauthorization. The sandbox demo should not be presented as proof of production expiry handling.

## Is this production ready?

No. This is a local sandbox prototype. It has no user authentication/authorization, uses local JSON state and a single-process in-memory mutation queue, has no distributed lock or durable outbox, and does not implement worker payouts or webhooks. The server is restricted to loopback and must not be exposed to the public internet.

## What would you build next?

First add a genuine worker agent that produces the deliverable from the buyer-approved contract. Keep the reference verifier separate and test it with adversarial outputs. Then add trusted source connectors and a real seller payout flow. Before production, add authenticated task ownership, transactional persistence, durable jobs, webhook processing, authorization lifecycle handling, and human-labelled verifier evaluations.
