"use strict";

require("dotenv").config();

const { verifyWithGroq } = require("../lib/verifier");

async function main() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      "GROQ_API_KEY is missing. Add it to your local .env file before running this check."
    );
  }

  const task = {
    id: "task-a",
    title: "Groq connectivity smoke test",
    acceptance:
      "The report summary should clearly communicate a concrete result.",
    evidence: {
      title: "Quarterly Revenue Report",
      summary:
        "Revenue increased by 8% compared with the previous quarter.",
    },
  };

  const startedAt = Date.now();
  const result = await verifyWithGroq(task);
  const latencyMs = Date.now() - startedAt;

  console.log("Groq API request completed successfully.");
  console.log(`Model: ${result.model || process.env.GROQ_MODEL || "default"}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`Source: ${result.source}`);
  console.log(`Latency: ${latencyMs} ms`);
  console.log(`Reason: ${result.reason}`);
  console.log("Payment side effects: none");

  if (result.decision === "REVIEW") {
    console.log(
      "Groq responded, but the verifier could not validate a usable decision. Inspect the reason above; no payment was attempted."
    );
  }
}

main().catch((error) => {
  console.error(`Groq smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
