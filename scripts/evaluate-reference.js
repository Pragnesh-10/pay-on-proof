"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  prepareReferenceContract,
  verifyReferenceSubmission,
} = require("../lib/reference-verifier");

const root = path.join(__dirname, "..");
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), "utf8")
);

const sourceContent = fs.readFileSync(
  path.join(root, "examples/buyer-invoice-source.json"),
  "utf8"
);
const sourceRecords = JSON.parse(sourceContent);
const contract = prepareReferenceContract({
  sourceFileName: "buyer-invoice-source.json",
  sourceFormat: "json",
  sourceContent,
  contract: {
    keyField: "id",
    preserveFields: ["quantity", "unitPrice", "description"],
    derivedFields: [{
      field: "lineTotal",
      operation: "multiply",
      inputs: ["quantity", "unitPrice"],
    }],
  },
});

const passing = readJson("examples/worker-invoice-output-pass.json");
const failing = readJson("examples/worker-invoice-output-fail.json");
const alteredInput = passing.map((row, index) =>
  index === 0
    ? { ...row, quantity: row.quantity + 1, lineTotal: (row.quantity + 1) * row.unitPrice }
    : row
);
const missingRow = passing.slice(0, -1);
const duplicateRow = [...passing.slice(0, -1), { ...passing[0] }];
const extraColumn = passing.map((row, index) =>
  index === 0 ? { ...row, uncontractedApproval: true } : row
);
const extraRecord = [...passing, {
  id: "INV-9999",
  quantity: 1,
  unitPrice: 1,
  description: "Unexpected record",
  lineTotal: 1,
}];

const cases = [
  { id: "correct-output", expected: "PASS", content: JSON.stringify(passing) },
  { id: "incorrect-total", expected: "FAIL", content: JSON.stringify(failing) },
  { id: "altered-formula-input", expected: "FAIL", content: JSON.stringify(alteredInput) },
  { id: "missing-record", expected: "FAIL", content: JSON.stringify(missingRow) },
  { id: "duplicate-record", expected: "FAIL", content: JSON.stringify(duplicateRow) },
  { id: "uncontracted-column", expected: "FAIL", content: JSON.stringify(extraColumn) },
  { id: "unexpected-record", expected: "FAIL", content: JSON.stringify(extraRecord) },
  { id: "malformed-output", expected: "REVIEW", content: '[{"id":"INV-1001"' },
];

const counts = { PASS: 0, FAIL: 0, REVIEW: 0 };
const mismatches = [];
let falsePassCount = 0;
let falseRejectCount = 0;

for (const testCase of cases) {
  const result = verifyReferenceSubmission({
    sourceRecords: contract.sourceRecords,
    sourceArtifact: contract.sourceArtifact,
    contract: contract.criteria,
    outputFileName: testCase.id + ".json",
    outputFormat: "json",
    outputContent: testCase.content,
  });
  counts[result.decision] = (counts[result.decision] || 0) + 1;
  if (testCase.expected !== "PASS" && result.decision === "PASS") {
    falsePassCount += 1;
  }
  if (testCase.expected === "PASS" && result.decision !== "PASS") {
    falseRejectCount += 1;
  }
  if (result.decision !== testCase.expected) {
    mismatches.push({
      id: testCase.id,
      expected: testCase.expected,
      actual: result.decision,
      reason: result.reason,
    });
  }
}

const report = {
  evaluationType: "AUTHORED_SYNTHETIC_FIXTURES_NOT_A_VALIDATED_BENCHMARK",
  dataset: "examples/buyer-invoice-source.json",
  caseCount: cases.length,
  expectedDecisionMatches: cases.length - mismatches.length,
  expectedDecisionMismatches: mismatches.length,
  falsePassCount,
  falseRejectCount,
  decisionCounts: counts,
  cases: cases.map((testCase) => ({
    id: testCase.id,
    expected: testCase.expected,
  })),
  mismatches,
  limitation: "These small authored fixtures test deterministic rules. They do not measure production accuracy, fraud detection, or factual truth.",
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (mismatches.length > 0 || falsePassCount > 0) process.exitCode = 1;
