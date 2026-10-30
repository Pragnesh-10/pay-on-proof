"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  prepareReferenceContract,
  verifyReferenceSubmission,
} = require("../lib/reference-verifier");

const sourceContent = JSON.stringify([
  { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget" },
  { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable" },
]);
const contractInput = {
  keyField: "id",
  preserveFields: ["quantity", "unitPrice", "description"],
  derivedFields: [{ field: "lineTotal", operation: "multiply", inputs: ["quantity", "unitPrice"] }],
};
const outputContent = JSON.stringify([
  { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget", lineTotal: 37.5 },
  { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable", lineTotal: 14 },
]);

function createContract(content = sourceContent, criteria = contractInput) {
  return prepareReferenceContract({
    sourceFileName: "buyer-source.json",
    sourceFormat: "json",
    sourceContent: content,
    contract: criteria,
  });
}

function verify(contract, content = outputContent, options = {}) {
  return verifyReferenceSubmission({
    sourceRecords: contract.sourceRecords,
    sourceArtifact: contract.sourceArtifact,
    contract: contract.criteria,
    outputFileName: options.fileName || "worker-output.json",
    outputFormat: options.format || "json",
    outputContent: content,
  });
}

test("reference-backed data transformation passes against buyer-controlled source and formula", () => {
  const contract = createContract();
  const result = verify(contract);
  assert.equal(result.decision, "PASS");
  assert.equal(result.sourceArtifact.sha256.length, 64);
  assert.equal(result.outputArtifact.sha256.length, 64);
  assert.ok(result.checks.every((check) => check.passed));
  assert.match(result.checks.find((check) => check.id === "derived:lineTotal").details, /buyer-approved formula/);
});

test("incorrect computed values fail even when the output has valid structure", () => {
  const contract = createContract();
  const tampered = JSON.stringify([
    { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget", lineTotal: 999 },
    { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable", lineTotal: 14 },
  ]);
  const result = verify(contract, tampered);
  assert.equal(result.decision, "FAIL");
  assert.equal(result.checks.find((check) => check.id === "derived:lineTotal").passed, false);
});

test("worker cannot change buyer-controlled source fields or remove records", () => {
  const contract = createContract();
  const tampered = JSON.stringify([
    { id: "INV-1", quantity: 300, unitPrice: 12.5, description: "Widget", lineTotal: 3750 },
  ]);
  const result = verify(contract, tampered);
  assert.equal(result.decision, "FAIL");
  assert.equal(result.checks.find((check) => check.id === "preserve:quantity").passed, false);
  assert.equal(result.checks.find((check) => check.id === "record-count").passed, false);
  assert.equal(result.checks.find((check) => check.id === "source-key-coverage").passed, false);
});

test("formula inputs are automatically preserved even when buyer omits them from preserveFields", () => {
  const contract = createContract(sourceContent, {
    keyField: "id",
    preserveFields: ["description"],
    derivedFields: [{ field: "lineTotal", operation: "multiply", inputs: ["quantity", "unitPrice"] }],
  });
  assert.deepEqual(
    contract.criteria.preserveFields,
    ["id", "description", "quantity", "unitPrice"],
  );
  const tampered = JSON.stringify([
    { id: "INV-1", quantity: 300, unitPrice: 12.5, description: "Widget", lineTotal: 37.5 },
    { id: "INV-2", quantity: 2, unitPrice: 7, description: "Cable", lineTotal: 14 },
  ]);
  const result = verify(contract, tampered);
  assert.equal(result.decision, "FAIL");
  assert.equal(result.checks.find((check) => check.id === "preserve:quantity").passed, false);
});

test("duplicate and unexpected output keys fail independently", () => {
  const contract = createContract();
  const duplicate = JSON.stringify([
    { id: "INV-1", quantity: 3, unitPrice: 12.5, description: "Widget", lineTotal: 37.5 },
    { id: "INV-1", quantity: 2, unitPrice: 7, description: "Cable", lineTotal: 14 },
  ]);
  const result = verify(contract, duplicate);
  assert.equal(result.decision, "FAIL");
  assert.equal(result.checks.find((check) => check.id === "output-key-uniqueness").passed, false);
  assert.equal(result.checks.find((check) => check.id === "source-key-coverage").passed, false);
});

test("unparseable worker output routes to REVIEW, not PASS", () => {
  const contract = createContract();
  const result = verify(contract, '[{"id":"INV-1"');
  assert.equal(result.decision, "REVIEW");
  assert.equal(result.parsed, false);
  assert.equal(result.checks[0].decision, "REVIEW");
});

test("buyer source contract rejects duplicate keys and missing or non-numeric formula inputs", () => {
  assert.throws(
    () => createContract(JSON.stringify([{ id: "A", quantity: 1, unitPrice: 2, description: "first" }, { id: "A", quantity: 3, unitPrice: 4, description: "second" }])),
    /duplicate id/
  );
  assert.throws(
    () => createContract(JSON.stringify([{ id: "A", quantity: 1, description: "item" }])),
    /missing preserved field unitPrice/
  );
  assert.throws(
    () => createContract(JSON.stringify([{ id: "A", quantity: 1, unitPrice: 0 }]), {
      keyField: "id",
      preserveFields: [],
      derivedFields: [{ field: "ratio", operation: "divide", inputs: ["quantity", "unitPrice"] }],
    }),
    /undefined for record/
  );
});

test("contract schema rejects unsupported operations and attempts to overwrite preserved fields", () => {
  assert.throws(
    () => createContract(sourceContent, {
      ...contractInput,
      derivedFields: [{ field: "lineTotal", operation: "eval", inputs: ["quantity", "unitPrice"] }],
    }),
    /operation must be/
  );
  assert.throws(
    () => createContract(sourceContent, {
      ...contractInput,
      derivedFields: [{ field: "quantity", operation: "multiply", inputs: ["quantity", "unitPrice"] }],
    }),
    /cannot overwrite/
  );
});

test("source and worker CSV files are independently compared", () => {
  const contract = prepareReferenceContract({
    sourceFileName: "buyer-source.csv",
    sourceFormat: "csv",
    sourceContent: "id,quantity,unitPrice,description\nINV-1,3,12.5,Widget\nINV-2,2,7,Cable",
    contract: contractInput,
  });
  const result = verifyReferenceSubmission({
    sourceRecords: contract.sourceRecords,
    sourceArtifact: contract.sourceArtifact,
    contract: contract.criteria,
    outputFileName: "worker-output.csv",
    outputFormat: "csv",
    outputContent: "id,quantity,unitPrice,description,lineTotal\nINV-1,3,12.5,Widget,37.5\nINV-2,2,7,Cable,14",
  });
  assert.equal(result.decision, "PASS");
});
