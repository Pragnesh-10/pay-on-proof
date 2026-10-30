# PayPal Dispute Evidence Workflow

## Scope

Pay-on-Proof prepares a merchant evidence package for an already completed task capture and can submit one narrow evidence type, `OTHER`, to a PayPal sandbox dispute when PayPal explicitly requests it.

This is a dispute-readiness aid. It does not prevent chargebacks, establish that a buyer received the work, prove that the buyer's source data was authentic, or guarantee a favorable dispute outcome.

## What the integration does

1. The merchant selects a task with a locally recorded PayPal capture status of `COMPLETED`.
2. The merchant enters a PayPal dispute ID.
3. The backend fetches `GET /v1/customer/disputes/{id}`.
4. The backend requires the dispute's `disputed_transactions[].seller_transaction_id` to exactly match the task's saved capture ID. A mismatch is rejected.
5. The app builds a package containing the local Proof Receipt, contract metadata, source/output digests, verification checks, payment references, requested evidence types, seller-response deadline, and a short merchant note draft.
6. The dashboard downloads the package. The merchant must review the generated note and decide whether to submit it.
7. Submission is allowed only when the PayPal dispute is `WAITING_FOR_SELLER_RESPONSE`, the dispute contains an evidence request with `source=REQUESTED_FROM_SELLER` and `evidence_type=OTHER`, and a `provide-evidence` HATEOAS action is present.
8. The backend stores a submission attempt before sending the multipart request. If the response is lost or unclear, the attempt is marked `UNKNOWN`; the app blocks automatic retry. Inspect the dispute in PayPal before doing anything else.

The current integration sends only an `OTHER` note. It does not upload the original JSON/CSV files, PDF attachments, tracking details, refund IDs, or any other evidence type.

## PayPal app setup

1. Use a PayPal Developer sandbox business account and REST app.
2. In the REST app's feature options, enable **Disputes**. PayPal's current integration guide says the Disputes feature must be enabled in the app before using the API.
3. Put that app's sandbox client ID and secret in the local `.env` file.
4. Keep `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`.
5. Leave `PAYPAL_DISPUTES_EVIDENCE_SUBMISSION_ENABLED=false` while testing read-only dispute lookup and evidence package creation.
6. After the read-only flow works, set `PAYPAL_DISPUTES_EVIDENCE_SUBMISSION_ENABLED=true` to enable the explicit sandbox submission button.
7. Restart the local server after changing environment values.

The current project uses its own merchant sandbox app. It does not implement `PayPal-Auth-Assertion` or delegated third-party merchant access. Do not treat this as a marketplace/platform integration.

## Creating a sandbox dispute

PayPal's current sandbox guide describes a buyer-side process for creating a transaction and a dispute:

1. Create sandbox buyer and business accounts. Buyer-side credentials are required to simulate buyer actions.
2. Sign in to the sandbox Personal buyer account and create a transaction with the sandbox business account. PayPal's guide uses **Send and Request** for this.
3. If you specifically test a card chargeback scenario, PayPal says the transaction must use a credit card.
4. Use the transaction ID to create a sandbox dispute through PayPal's documented buyer-side sandbox endpoint. The documented request includes `disputed_transactions[].buyer_transaction_id`, `reason`, and `dispute_amount`; this sandbox-only create-dispute action also requires a valid `PayPal-Auth-Assertion` JWT.
5. Use the resulting dispute ID in the Pay-on-Proof dashboard.

This dispute-creation flow is separate from Pay-on-Proof's task authorization/capture demo. Use an appropriate sandbox transaction whose seller transaction ID can be matched to a Pay-on-Proof task capture. Do not fabricate a dispute ID or reuse one from another transaction.

## Evidence policy

PayPal requires merchants to inspect the dispute's `reason`, `evidences[].evidence_type`, and `evidences[].source`. A merchant should provide only the evidence type currently requested by PayPal.

For `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, PayPal documents `OTHER` notes or documents as possible supporting evidence, such as a copy of a contract or affidavit. The Pay-on-Proof submission feature therefore sends a concise `OTHER` note only when PayPal explicitly requests `OTHER`.

For `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, PayPal may require fulfillment proof, such as tracking information or appropriate delivery documents. Pay-on-Proof does not manufacture those facts. It refuses to convert an output digest into proof of delivery.

PayPal says evidence notes are limited to 2,000 characters. The generated note is bounded below that limit. The API requires a multipart request; the backend creates the multipart form and sends the JSON `input` part containing the requested evidence type and notes.

## API routes

- `GET /api/authorizations/:authorizationId/tasks/:taskId/disputes/:disputeId/evidence-package` — fetch PayPal dispute details, verify capture matching, and return an exportable package. No evidence is submitted.
- `POST /api/authorizations/:authorizationId/tasks/:taskId/disputes/:disputeId/provide-evidence` — submit the package's `OTHER` note. Requires `{"confirm":true}`, the sandbox-only environment, the feature flag, the requested `OTHER` evidence entry, and the PayPal provide-evidence action.

## Limits and safeguards

- This server is unauthenticated and must remain bound to loopback.
- Use synthetic, non-sensitive source and output data only.
- A matching capture ID links the local task to the PayPal dispute transaction; it does not prove the source file or work is truthful.
- The package is a draft. The merchant remains responsible for accuracy and submission.
- This integration does not guarantee dispute outcomes.
- A recorded `IN_PROGRESS` or `UNKNOWN` evidence attempt must not be blindly retried. Inspect the current PayPal dispute and its evidence history first.
- Only the merchant's sandbox Disputes API access is supported. Third-party delegated access and live submission are not implemented.

## Official PayPal documentation

- [Integrate Disputes APIs](https://developer.paypal.com/platforms/disputes/integrate-disputes/) — app setup, show dispute details, response actions, and evidence flow.
- [Use Disputes API](https://developer.paypal.com/api/disputes/) — dispute lifecycle and available actions.
- [Dispute reasons and evidence](https://developer.paypal.com/disputes/reasons-evidence/) — evidence requirements by dispute reason.
- [Test and go live](https://developer.paypal.com/disputes/test-go-live) — sandbox transactions, buyer-side dispute creation, and test cases.
- [Show dispute details API](https://developer.paypal.com/api/customer-disputes/v1/disputes-get) — dispute resource schema.
