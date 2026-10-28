"use strict";

require("dotenv").config();

const { performance } = require("node:perf_hooks");
const { verifyWithGroq } = require("../lib/verifier");
const cases = require("../test/fixtures/semantic-evaluation-cases.json");

function calculateMetrics(results) {
  const expectedPass = results.filter((row) => row.expected === "PASS");
  const expectedNotPass = results.filter((row) => row.expected !== "PASS");
  const falsePasses = expectedNotPass.filter((row) => row.actual === "PASS").length;
  const falseFails = expectedPass.filter((row) => row.actual === "FAIL").length;
  const completed = results.filter((row) => !row.error);
  const averageLatencyMs = completed.length
    ? Math.round(completed.reduce((sum, row) => sum + row.latencyMs, 0) / completed.length)
    : 0;
  return {
    cases: results.length,
    exactMatchRate: results.filter((row) => row.actual === row.expected).length / Math.max(results.length, 1),
    falsePassRateAmongExpectedNonPass: expectedNotPass.length ? falsePasses / expectedNotPass.length : 0,
    falseFailRateAmongExpectedPass: expectedPass.length ? falseFails / expectedPass.length : 0,
    reviewRate: results.filter((row) => row.actual === "REVIEW").length / Math.max(results.length, 1),
    providerErrorCount: results.filter((row) => row.error).length,
    averageLatencyMs,
  };
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is required. This script makes live Groq requests and no payment requests.");
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (const item of cases) {
    const started = performance.now();
    try {
      const outcome = await verifyWithGroq({
        id: "task-a",
        acceptance: "The summary must clearly communicate a concrete result or comparison. If the evidence is ambiguous or lacks enough context, choose REVIEW.",
        evidence: { title: item.title, summary: item.summary },
      });
      results.push({
        id: item.id,
        expected: item.expected,
        actual: outcome.decision,
        latencyMs: Math.round(performance.now() - started),
        reason: outcome.reason,
      });
    } catch (error) {
      results.push({
        id: item.id,
        expected: item.expected,
        actual: "REVIEW",
        latencyMs: Math.round(performance.now() - started),
        error: error.message,
      });
    }
  }
  console.log(JSON.stringify({
    warning: "Small authored synthetic fixture set; not a validated benchmark or accuracy guarantee.",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    metrics: calculateMetrics(results),
    results,
  }, null, 2));
  if (results.some((row) => row.error)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
