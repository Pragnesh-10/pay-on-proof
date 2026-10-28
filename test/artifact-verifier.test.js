"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyArtifact, parseCsv } = require("../lib/artifact-verifier");

test("JSON artifact passes required, unique, numeric, and row checks", () => {
  const result = verifyArtifact({
    fileName: "results.json",
    format: "json",
    content: JSON.stringify([
      { id: "A1", score: 0.92, label: "pass" },
      { id: "A2", score: 0.87, label: "pass" },
    ]),
    criteria: {
      requiredFields: ["id", "label"],
      uniqueField: "id",
      numericFields: ["score"],
      minRows: 2,
    },
  });
  assert.equal(result.decision, "PASS");
  assert.equal(result.artifact.recordCount, 2);
  assert.equal(result.checks.every((check) => check.passed), true);
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
});

test("required fields and numeric rules fail when evidence is missing or malformed", () => {
  const result = verifyArtifact({
    fileName: "results.json",
    format: "json",
    content: JSON.stringify([{ id: "A1", score: "unknown" }, { id: "A1", score: 0.4 }]),
    criteria: { requiredFields: ["label"], uniqueField: "id", numericFields: ["score"] },
  });
  assert.equal(result.decision, "FAIL");
  assert.equal(result.checks.find((check) => check.id === "required:label").passed, false);
  assert.equal(result.checks.find((check) => check.id === "unique:id").passed, false);
  assert.equal(result.checks.find((check) => check.id === "numeric:score").passed, false);
});

test("CSV parser supports quoted commas and escaped quotes", () => {
  const records = parseCsv('id,description\r\nA1,"first, second"\r\nA2,"said ""hello"""\r\n');
  assert.deepEqual(records, [
    { id: "A1", description: "first, second" },
    { id: "A2", description: 'said "hello"' },
  ]);
});

test("CSV with a malformed quoted field routes to REVIEW rather than PASS", () => {
  const result = verifyArtifact({
    fileName: "results.csv",
    format: "csv",
    content: 'id,summary\nA1,"unterminated',
    criteria: { requiredFields: ["id"] },
  });
  assert.equal(result.decision, "REVIEW");
  assert.equal(result.parsed, false);
  assert.equal(result.checks[0].decision, "REVIEW");
});

test("artifact input rejects unsupported formats, unsafe filenames, invalid criteria, and oversized content", () => {
  assert.throws(() => verifyArtifact({
    fileName: "../secret.json", format: "json", content: '{"id":"A"}',
  }), /simple file name/);
  assert.throws(() => verifyArtifact({
    fileName: "a.xml", format: "xml", content: "<a/>",
  }), /format must be json or csv/);
  assert.throws(() => verifyArtifact({
    fileName: "a.json", format: "json", content: '{"id":"A"}',
    criteria: { requiredFields: "id" },
  }), /must be an array/);
  assert.throws(() => verifyArtifact({
    fileName: "a.json", format: "json", content: '{"id":"A"}', criteria: { minRows: 1 },
  }), /at least one field criterion/);
  assert.throws(() => verifyArtifact({
    fileName: "large.json", format: "json", content: "x".repeat(20 * 1024 + 1),
  }), /20 KB upload limit/);
});

test("CSV duplicate headers and mismatched rows route to REVIEW", () => {
  const duplicateHeaders = verifyArtifact({
    fileName: "duplicate.csv", format: "csv", content: "id,ID\nA1,A2", criteria: { requiredFields: ["id"] },
  });
  const badRow = verifyArtifact({
    fileName: "bad-row.csv", format: "csv", content: "id,value\nA1,1,extra", criteria: { requiredFields: ["id"] },
  });
  assert.equal(duplicateHeaders.decision, "REVIEW");
  assert.equal(badRow.decision, "REVIEW");
});
