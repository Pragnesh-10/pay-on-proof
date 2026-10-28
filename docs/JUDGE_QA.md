# Judge Q&A

## What problem does this solve?

It demonstrates a task-level payment gate: the backend evaluates each task against acceptance criteria and only attempts payment capture for a passing result. It explores how staged agentic work could be matched to staged payment, rather than treating an AI-generated completion claim as payment authority.

## What is the key idea?

The key design choice is the **separation of verification from payment execution**. An AI model can provide advisory semantic review, but only backend logic can initiate a capture, and only after deterministic hard gates and a final PASS decision.

## Why use an LLM at all?

Task A includes a natural-language summary. Deterministic rules can check that the title and summary exist, but they do not determine whether the summary clearly states a meaningful result. Groq supplies an advisory semantic assessment for that narrow step. Tasks B and C are machine-checkable and remain deterministic.

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

I would first add authenticated task ownership and transactional persistence, then implement a fuller provider reconciliation model and sandbox failure-injection tests. Before broadening the AI role, I would build a labelled evaluation set and measure false-pass and false-fail behavior. That improves safety before adding complexity.
