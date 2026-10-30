"use strict";

const crypto = require("node:crypto");
const {
  MAX_CONTENT_BYTES,
  MAX_RECORDS,
  parseRecords,
} = require("./artifact-verifier");

const MAX_PRESERVE_FIELDS = 20;
const MAX_DERIVED_FIELDS = 10;
const ALLOWED_OPERATIONS = new Set(["add", "subtract", "multiply", "divide"]);

function validateFile(fileName, format, content, label) {
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 120 ||
      /[\\/\u0000-\u001f]/.test(fileName)) {
    throw new TypeError(label + " fileName must be a simple file name up to 120 characters.");
  }
  if (!["json", "csv"].includes(format)) {
    throw new TypeError(label + " format must be json or csv.");
  }
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") === 0) {
    throw new TypeError(label + " content must be non-empty text.");
  }
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_CONTENT_BYTES) {
    throw new TypeError(label + " exceeds the 20 KB upload limit.");
  }
  return {
    fileName: fileName.trim(),
    format,
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    sizeBytes,
  };
}

function parseSource(file) {
  let records;
  try {
    records = parseRecords(file.format, file.content);
  } catch (error) {
    throw new TypeError("Buyer source data must be valid JSON or CSV: " + error.message);
  }
  if (!records.length) throw new TypeError("Buyer source data must contain at least one record.");
  if (records.length > MAX_RECORDS) throw new TypeError("Buyer source data exceeds the record limit.");
  return records;
}

function fieldName(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 64) {
    throw new TypeError(label + " must be a non-empty field name up to 64 characters.");
  }
  return value.trim();
}

function fieldList(value, label, { required = false, max = MAX_PRESERVE_FIELDS } = {}) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) throw new TypeError(label + " must be an array of field names.");
  if (value.length > max) throw new TypeError(label + " may contain at most " + max + " entries.");
  const result = value.map((entry) => fieldName(entry, label));
  if (new Set(result).size !== result.length) throw new TypeError(label + " cannot contain duplicates.");
  if (required && !result.length) throw new TypeError(label + " must contain at least one field.");
  return result;
}

function normalizeContract(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("contract must be an object.");
  }
  const allowed = new Set(["keyField", "preserveFields", "derivedFields"]);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new TypeError("Unsupported contract fields: " + unsupported.join(", "));

  const keyField = fieldName(value.keyField, "keyField");
  const preserveFields = fieldList(value.preserveFields, "preserveFields");
  if (!preserveFields.includes(keyField)) preserveFields.unshift(keyField);
  if (preserveFields.length > MAX_PRESERVE_FIELDS) {
    throw new TypeError("preserveFields may contain at most " + MAX_PRESERVE_FIELDS + " fields including keyField.");
  }

  if (!Array.isArray(value.derivedFields) || value.derivedFields.length < 1 ||
      value.derivedFields.length > MAX_DERIVED_FIELDS) {
    throw new TypeError("derivedFields must contain between 1 and " + MAX_DERIVED_FIELDS + " deterministic formulas.");
  }
  const derivedFields = value.derivedFields.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("derivedFields[" + index + "] must be an object.");
    }
    const keys = Object.keys(entry);
    const unsupportedKeys = keys.filter((key) => !["field", "operation", "inputs"].includes(key));
    if (unsupportedKeys.length) throw new TypeError("Unsupported formula properties: " + unsupportedKeys.join(", "));
    const field = fieldName(entry.field, "derivedFields[" + index + "].field");
    if (!ALLOWED_OPERATIONS.has(entry.operation)) {
      throw new TypeError("Formula operation must be add, subtract, multiply, or divide.");
    }
    const inputs = fieldList(entry.inputs, "derivedFields[" + index + "].inputs", { required: true, max: 2 });
    if (inputs.length !== 2) throw new TypeError("Each formula must use exactly two source fields.");
    if (field === keyField || preserveFields.includes(field)) {
      throw new TypeError("A derived field cannot overwrite the key or a preserved source field: " + field);
    }
    return { field, operation: entry.operation, inputs };
  });

  // Formula inputs must remain identical to the buyer source. Otherwise a
  // worker could alter an input field while submitting the correct source-based
  // derived value, leaving the submitted row internally inconsistent.
  for (const formula of derivedFields) {
    for (const input of formula.inputs) {
      if (!preserveFields.includes(input)) preserveFields.push(input);
    }
  }
  if (preserveFields.length > MAX_PRESERVE_FIELDS) {
    throw new TypeError("preserveFields plus formula inputs may contain at most " + MAX_PRESERVE_FIELDS + " fields.");
  }

  const formulaNames = derivedFields.map((entry) => entry.field);
  if (new Set(formulaNames).size !== formulaNames.length) {
    throw new TypeError("Derived formula output fields must be unique.");
  }
  return { keyField, preserveFields, derivedFields };
}

function scalarToken(value, label) {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new TypeError(label + " must be a scalar string, number, boolean, or null.");
}

function recordKey(record, keyField, label) {
  if (!Object.prototype.hasOwnProperty.call(record, keyField)) return null;
  const value = record[keyField];
  if ((typeof value !== "string" && typeof value !== "number") ||
      String(value).trim() === "" || !Number.isFinite(typeof value === "number" ? value : 0)) {
    return null;
  }
  return String(value).trim();
}

function numericValue(value, label) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      String(value).trim() === "") {
    throw new TypeError(label + " must be numeric.");
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError(label + " must be a finite number.");
  return result;
}

function calculate(operation, left, right) {
  switch (operation) {
    case "add": return left + right;
    case "subtract": return left - right;
    case "multiply": return left * right;
    case "divide": return right === 0 ? null : left / right;
    default: return null;
  }
}

function prepareReferenceContract({ sourceFileName, sourceFormat, sourceContent, contract }) {
  const sourceFile = validateFile(sourceFileName, sourceFormat, sourceContent, "Source");
  const criteria = normalizeContract(contract);
  const sourceRecords = parseSource({ ...sourceFile, content: sourceContent });
  const seenKeys = new Set();

  for (let index = 0; index < sourceRecords.length; index += 1) {
    const record = sourceRecords[index];
    const key = recordKey(record, criteria.keyField, "Source record " + (index + 1));
    if (key === null) throw new TypeError("Buyer source record " + (index + 1) + " has a missing or invalid " + criteria.keyField + ".");
    if (seenKeys.has(key)) throw new TypeError("Buyer source contains duplicate " + criteria.keyField + " value: " + key + ".");
    seenKeys.add(key);

    for (const field of criteria.preserveFields) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) {
        throw new TypeError("Buyer source is missing preserved field " + field + " in record " + key + ".");
      }
      scalarToken(record[field], "Source field " + field + " in record " + key);
    }

    for (const formula of criteria.derivedFields) {
      for (const input of formula.inputs) {
        if (!Object.prototype.hasOwnProperty.call(record, input)) {
          throw new TypeError("Buyer source is missing formula input " + input + " in record " + key + ".");
        }
        numericValue(record[input], "Source formula input " + input + " in record " + key);
      }
      const expected = calculate(
        formula.operation,
        numericValue(record[formula.inputs[0]], formula.inputs[0]),
        numericValue(record[formula.inputs[1]], formula.inputs[1])
      );
      if (expected === null || !Number.isFinite(expected)) {
        throw new TypeError("Buyer source formula " + formula.field + " is undefined for record " + key + ".");
      }
    }
  }

  return {
    sourceArtifact: {
      ...sourceFile,
      recordCount: sourceRecords.length,
    },
    criteria,
    sourceRecords,
  };
}

function verifyReferenceSubmission({
  sourceRecords,
  sourceArtifact,
  contract,
  outputFileName,
  outputFormat,
  outputContent,
}) {
  if (!Array.isArray(sourceRecords) || sourceRecords.length === 0) {
    throw new TypeError("A stored buyer source dataset is required.");
  }
  const outputArtifact = validateFile(outputFileName, outputFormat, outputContent, "Output");
  const criteria = normalizeContract(contract);
  let outputRecords;
  try {
    outputRecords = parseRecords(outputFormat, outputContent);
  } catch (error) {
    return {
      decision: "REVIEW",
      reason: "Worker output could not be parsed. No payment should be attempted.",
      sourceArtifact,
      outputArtifact: { ...outputArtifact, recordCount: 0 },
      criteria,
      checks: [{
        id: "output-parse",
        label: "Worker output is parseable",
        passed: false,
        decision: "REVIEW",
        details: error.message,
      }],
      recordsPreview: [],
      parsed: false,
    };
  }

  const checks = [];
  const addCheck = (id, label, passed, details) => checks.push({ id, label, passed, details });
  const sourceByKey = new Map();
  const outputByKey = new Map();
  const sourceInvalid = [];
  const outputInvalid = [];

  for (let i = 0; i < sourceRecords.length; i += 1) {
    const key = recordKey(sourceRecords[i], criteria.keyField, "Source");
    if (key === null || sourceByKey.has(key)) sourceInvalid.push("source row " + (i + 1));
    else sourceByKey.set(key, sourceRecords[i]);
  }
  for (let i = 0; i < outputRecords.length; i += 1) {
    const key = recordKey(outputRecords[i], criteria.keyField, "Output");
    if (key === null || outputByKey.has(key)) outputInvalid.push("output row " + (i + 1));
    else outputByKey.set(key, outputRecords[i]);
  }

  addCheck(
    "source-key-uniqueness",
    "Buyer source keys are unique",
    sourceInvalid.length === 0,
    sourceInvalid.length ? "Invalid or duplicate keys: " + sourceInvalid.slice(0, 3).join(", ") : "The stored buyer dataset has one unique key per record."
  );
  addCheck(
    "output-key-uniqueness",
    "Worker output keys are unique",
    outputInvalid.length === 0,
    outputInvalid.length ? "Invalid or duplicate keys: " + outputInvalid.slice(0, 3).join(", ") : "The submitted output has one unique key per record."
  );
  addCheck(
    "record-count",
    "Output record count matches source",
    outputRecords.length === sourceRecords.length,
    "Source has " + sourceRecords.length + " record(s); output has " + outputRecords.length + "."
  );

  const missing = [...sourceByKey.keys()].filter((key) => !outputByKey.has(key));
  const unexpected = [...outputByKey.keys()].filter((key) => !sourceByKey.has(key));
  const sameKeys = sourceInvalid.length === 0 && outputInvalid.length === 0 &&
    missing.length === 0 && unexpected.length === 0 &&
    sourceByKey.size === outputByKey.size;
  addCheck(
    "source-key-coverage",
    "Every source record appears exactly once",
    sameKeys,
    sameKeys
      ? "The worker output contains the same unique record keys as the buyer source."
      : "Missing keys: " + (missing.slice(0, 3).join(", ") || "none") +
        "; unexpected keys: " + (unexpected.slice(0, 3).join(", ") || "none") +
        "; invalid or duplicate keys: " + [...sourceInvalid, ...outputInvalid].slice(0, 3).join(", ")
  );

  for (const field of criteria.preserveFields) {
    const mismatches = [];
    for (const [key, sourceRecord] of sourceByKey) {
      const outputRecord = outputByKey.get(key);
      if (!outputRecord || !Object.prototype.hasOwnProperty.call(outputRecord, field)) {
        mismatches.push(key + " (missing)");
        continue;
      }
      try {
        if (scalarToken(sourceRecord[field], field) !== scalarToken(outputRecord[field], field)) {
          mismatches.push(key);
        }
      } catch {
        mismatches.push(key + " (non-scalar)");
      }
    }
    addCheck(
      "preserve:" + field,
      "Preserved source field: " + field,
      mismatches.length === 0 && sameKeys,
      mismatches.length
        ? "Values differ or are missing for record(s): " + mismatches.slice(0, 3).join(", ")
        : sameKeys ? "Every output value matches the buyer-controlled source." : "Cannot verify field preservation until key coverage passes."
    );
  }

  for (const formula of criteria.derivedFields) {
    const mismatches = [];
    for (const [key, sourceRecord] of sourceByKey) {
      const outputRecord = outputByKey.get(key);
      if (!outputRecord || !Object.prototype.hasOwnProperty.call(outputRecord, formula.field)) {
        mismatches.push(key + " (missing)");
        continue;
      }
      try {
        const expected = calculate(
          formula.operation,
          numericValue(sourceRecord[formula.inputs[0]], formula.inputs[0]),
          numericValue(sourceRecord[formula.inputs[1]], formula.inputs[1])
        );
        const actual = numericValue(outputRecord[formula.field], formula.field);
        const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
        if (expected === null || !Number.isFinite(expected) || Math.abs(actual - expected) > tolerance) {
          mismatches.push(key);
        }
      } catch {
        mismatches.push(key + " (non-numeric)");
      }
    }
    addCheck(
      "derived:" + formula.field,
      "Calculated field: " + formula.field + " = " + formula.inputs[0] + " " + formula.operation + " " + formula.inputs[1],
      mismatches.length === 0 && sameKeys,
      mismatches.length
        ? "Incorrect or missing calculated values for record(s): " + mismatches.slice(0, 3).join(", ")
        : sameKeys ? "Every calculated value matches the buyer-approved formula." : "Cannot verify calculated values until key coverage passes."
    );
  }

  const passed = checks.every((check) => check.passed);
  return {
    decision: passed ? "PASS" : "FAIL",
    reason: passed
      ? "Worker output matches the buyer-controlled source, preserves contracted fields, and passes every deterministic calculation."
      : "Worker output failed one or more independent source-backed checks.",
    sourceArtifact,
    outputArtifact: { ...outputArtifact, recordCount: outputRecords.length },
    criteria,
    checks,
    recordsPreview: outputRecords.slice(0, 3),
    parsed: true,
  };
}

module.exports = {
  normalizeContract,
  prepareReferenceContract,
  verifyReferenceSubmission,
};
