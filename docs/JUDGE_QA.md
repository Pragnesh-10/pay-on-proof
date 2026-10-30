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

It is a bounded, operator-triggered AI worker, not a fully autonomous marketplace agent. With explicit consent, Groq generates candidate JSON from the frozen buyer source and contract rules. The backend then runs the deterministic reference verifier, which alone decides PASS/FAIL/REVIEW. The worker is limited to 50 records and a 12 KB prompt, and it has no PayPal tools. The separate payment policy requires a stored PASS and an explicit capture action. The accurate description is **evidence-gated task payment with an optional AI-generated worker submission and independent verification**.

## How does the independent verifier work?

The buyer creates a contract on an active sandbox authorization before output submission. The contract includes a source file, unique key, preserved fields, deterministic formulas, and amount. The backend validates and stores parsed source rows, source digest, criteria, and contract status. The worker submits only an output file. The server compares the output to the stored source and frozen criteria.

## What happens if the worker submits fake success flags?

The reference-backed route does not read or trust worker-supplied pass booleans. It checks the worker's actual parsed output rows and limits output fields to the contracted columns, and recalculates formulas from buyer-source values. For example, the invoice demo rejects a `lineTotal` that does not equal `quantity × unitPrice`.

## Can it detect every kind of fraud or bad work?

No. The reference verifier proves only its explicit checks: keys, record coverage, protected fields, and configured formulas. It cannot establish whether the buyer's source is authentic, whether a formula is the right business rule, or whether unrelated claims are true. We need trusted source connectors and domain-specific checks to expand coverage.

## Can a contract be changed after the worker submits?

A reference contract is stored before submission and accepts one submission. The worker route uses the stored source rows and criteria rather than accepting replacements. A failed submission is retained; a revised attempt needs a newly approved contract. The current prototype has no authenticated buyer identity, so this is a local workflow control rather than a production authorization guarantee.

## How do you test adversarial submissions?

The reference verifier has unit and mock-provider integration tests for incorrect totals, altered formula inputs, duplicate/missing/unexpected records, uncontracted output columns, malformed JSON, duplicate submissions, and budget conflicts. `npm run evaluate:reference` runs eight authored synthetic cases and reports false-PASS and false-reject counts. This is a regression fixture set, not a validated production accuracy benchmark.

## Does the system use AI to verify the invoice output?

The invoice verifier is deterministic. The optional Groq worker can generate a candidate invoice transformation, but it does not verify itself. The same backend verifier checks record coverage, preserved source fields, and formula calculations. We use deterministic code for correctness-sensitive arithmetic because it is easier to test and reproduce.

## Does the AI have payment tools?

No. The Groq worker receives only the stored buyer source rows and frozen transformation rules after explicit consent. It returns candidate data, not a payment decision. The Groq API key stays on the server, and the model has no PayPal credentials or tools. The backend verifier and separate capture policy remain authoritative.

## Can the worker receive the captured funds?

Not in the current implementation. The demo captures against the PayPal authorization associated with the order. It does not onboard a worker as a separate payee or implement seller disbursement. A complete marketplace would need a supported PayPal multiparty/seller or payout integration, plus eligibility and partner approval where required.

## Does the artifact upload automatically move money?

Preview, contract creation, and output submission do not call PayPal payment endpoints. A separate capture action is available only for a stored PASS task. Before capture, the backend rechecks current authorization status, available budget, unresolved captures, void state, and duplicate attempts. FAIL and REVIEW are blocked.

## What prevents duplicate captures?

The server stores each capture attempt before sending it, uses a stable `PayPal-Request-Id`, and reserves unresolved amounts against the budget. For uncertain outcomes, reconciliation queries a known capture or replays the same request ID and payload. A task with an existing capture attempt is blocked from another capture.

## How does Pay-on-Proof help with PayPal disputes?

For a task with a confirmed PayPal capture, the app can retrieve a dispute and link it only when the dispute's seller transaction ID exactly matches the task's capture ID. It creates a merchant-review package containing the contract metadata, output digest, verification checks, payment reference, PayPal-requested evidence types, and seller-response deadline. In the sandbox, it can submit a short `OTHER` note only if PayPal explicitly requests that evidence type and exposes a provide-evidence action. The merchant must review and confirm the submission.

This is not a chargeback prevention or dispute-win guarantee. The app does not prove source authenticity or actual delivery, does not handle all evidence types, and currently does not upload document attachments.

## What does a Proof Receipt prove?

It records evidence, contract criteria, verifier provenance and checks, decision, payment status, and event history. SHA-256 hashes detect changes to the recorded snapshot. They do not prove the source file is authentic, the facts are true, or the receipt issuer is authenticated.

## What about PayPal authorization expiry?

Authorization has a limited validity window and the highest capture success is during the initial honor period. The current prototype does not implement authorization expiry monitoring or reauthorization. The sandbox demo should not be presented as proof of production expiry handling.

## Is this production ready?

No. This is a local sandbox prototype. It has no user authentication/authorization, uses local JSON state and a single-process in-memory mutation queue, has no distributed lock or durable outbox, and does not implement worker payouts or webhooks. The server is restricted to loopback and must not be exposed to the public internet.

## What are the PayPal Disputes API prerequisites?

The merchant's PayPal REST app must have the Disputes feature enabled and the required access. The prototype is configured for the merchant's own sandbox app, not delegated third-party merchant access. To test a dispute end to end, create a sandbox transaction/dispute using PayPal's documented buyer-side sandbox flow, then fetch the dispute and inspect its requested evidence types and HATEOAS actions. Submission is disabled by default and requires `PAYPAL_DISPUTES_EVIDENCE_SUBMISSION_ENABLED=true`; the server refuses this action unless the API base URL is a sandbox URL.

## What would you build next?

First add a genuine worker agent that produces the deliverable from the buyer-approved contract. Keep the reference verifier separate and test it with adversarial outputs. Then add trusted source connectors and a real seller payout flow. Before production, add authenticated task ownership, transactional persistence, durable jobs, webhook processing, authorization lifecycle handling, and human-labelled verifier evaluations.
