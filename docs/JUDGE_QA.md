# Judge Q&A

## What problem does this solve?

It demonstrates a task-level payment gate: the backend evaluates each task against acceptance criteria and only attempts payment capture for a passing result. It explores how staged agentic work could be matched to staged payment, rather than treating an AI-generated completion claim as payment authority.

## Which hackathon category does this fit best?

The strongest fit is **AI Agents or Automation** because the backend does more than recommend: once a user starts the bounded workflow, it evaluates the result and can make a PayPal sandbox partial capture for a task that passes. It also fits **Business Solutions** as a task-payment control layer for platforms paying for staged deliverables. It is less directly a consumer money-transfer experience because it does not introduce a new P2P transfer method.

## Is this really an agent if the model cannot call PayPal?

The product is a bounded agentic workflow with a deliberately separated transaction executor. In the predefined demo, the optional LLM assesses a narrow semantic criterion; the custom artifact workflow applies explicit structural rules. After the operator confirms a workflow, the backend evaluates and records the artifact, then can request one PayPal sandbox capture only for a newly recorded PASS. Deterministic backend policy—not model tool access—controls the capture. REVIEW and FAIL fail closed, and previously recorded tasks are not auto-captured again.

## What is the key idea?

The key design choice is the **separation of verification from payment execution**. An AI model can provide advisory semantic review, but only backend logic can initiate a capture, and only after deterministic hard gates and a final PASS decision.

## Why use an LLM at all?

Task A includes a natural-language summary. Deterministic rules can check that the title and summary exist, but they do not determine whether the summary clearly states a meaningful result. Groq supplies an advisory semantic assessment for that narrow step. Tasks B and C are machine-checkable and remain deterministic.

## Why add human review if the verifier already returns a decision?

The model flags ambiguity rather than making the final business judgment. A reviewer records a name and rationale. Approval is only available for a stored REVIEW task, cannot bypass deterministic required-field checks, rechecks PayPal authorization and budget, and blocks if another capture is unresolved. Reviewer identity is not authenticated in this prototype, so this is for local sandbox demonstration only.

## Can a user submit actual work, or is everything hardcoded?

The prototype accepts JSON and CSV artifacts up to 20 KB and applies explicit required-field, uniqueness, numeric-field, and minimum-row checks. It can save the result against an existing sandbox authorization. The structural verifier does not establish domain correctness or factual truth, and artifact capture is a separate explicit operation.

## How do you know the verifier is accurate?

We do not claim a validated accuracy percentage. The repository includes a small authored synthetic case set and an optional Groq evaluation script that reports exact-match, false-pass, false-fail, review-rate, provider-error, and latency metrics. Those results are exploratory until the cases are reviewed and expanded into representative human-labelled evaluation data.

## Can the artifact upload automatically move money?

Preview and save-only operations never call PayPal payment endpoints. The explicit, confirmed agent workflow can request one partial capture for a newly recorded PASS artifact task; it cannot capture FAIL or REVIEW, and it does not auto-capture a previously recorded task again. Before a capture, the backend rechecks current PayPal authorization status, available budget, unresolved captures, and duplicate attempts. A separate manual capture action remains available for a saved PASS task after the operator inspects it.

## How can a Proof Receipt be checked?

The verifier recomputes the evidence, criteria, and receipt hashes from the receipt itself. If the original artifact is also supplied, it checks whether the raw artifact bytes match the recorded SHA-256 digest. These checks detect changes; they do not prove that artifact claims are true or that the receipt issuer is authenticated.

## What is a Proof Receipt?

It is a downloadable snapshot of the evidence, criteria, verifier source/model, original decision, any reviewer action, payment status, event history, and SHA-256 hashes. Hashes make changes to recorded bytes detectable; they do not prove evidence is truthful or independently sourced. Simulation receipts are explicitly non-authoritative.

## Does the PASS / REVIEW / FAIL simulator move money?

No. It uses synthetic fixtures, never calls PayPal, reports $0 actual captured, and marks receipts SIMULATION_ONLY. A real sandbox capture is only possible in the separate authorized payment workflow.

## What if the model hallucinates or the API is down?

The model does not prove factual truth; no source data or calibrated benchmark is included in this prototype. A malformed decision, FAIL, REVIEW, timeout, or provider error is not a PASS. The backend routes errors to REVIEW and does not capture that task.

## Can the AI spend money?

No. The verifier makes a Groq API request and returns a decision, but has no PayPal tools. PayPal credentials stay on the server. Captures happen only in the backend payment route after the decision gate.

## What prevents duplicate captures?

The server stores each attempt before sending it, uses a stable `PayPal-Request-Id`, enforces a single-use demo guard per authorization, and reserves unresolved amounts against the budget. For an uncertain outcome, reconciliation queries a known capture or replays the same request ID and payload instead of inventing a new capture request. The system follows PayPal's idempotency behavior; it is still necessary to inspect the provider state.

## What happens if a capture times out?

It is recorded as uncertain, not assumed to have failed. The amount remains reserved and void is blocked until reconciliation. The app intentionally does not resume a partially completed task sequence automatically after reconciliation.

## Why PayPal sandbox?

It demonstrates authorization, partial capture, status refresh, and voiding without using real funds. The intended example uses a $50 authorization and two partial captures for $15 and $20; the incomplete $10 task is not captured. The remaining $15 authorization is voided rather than refunded.

## Does a void refund completed captures?

No. Voiding the remaining authorization releases the amount that was not captured. It does not reverse completed captures.

## How accurate is the AI verifier?

There is no defensible accuracy percentage yet. One live smoke test returned PASS for a synthetic report containing a concrete 8% revenue increase, but a single smoke test is a connectivity check, not an accuracy evaluation. An evaluation dataset with human-labelled decisions and false-pass/false-fail metrics is a future requirement.

## Is this production ready?

No. It is a hackathon prototype for local sandbox demonstration. It has no user authentication/authorization, uses local JSON state and a single-process in-memory mutation queue, and has no distributed lock or durable transaction/outbox architecture. It must not be exposed to the public internet.

## What would you build next?

I would first add authenticated task ownership and transactional persistence, then expand the artifact verifier with domain-specific trusted-source rules and a fuller provider reconciliation/failure-injection test suite. Before broadening the AI role, I would build a labelled evaluation set and measure false-pass and false-fail behavior. That improves safety before adding complexity.
