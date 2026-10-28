"use strict";

const crypto = require("node:crypto");

const MAX_CONTENT_BYTES = 20 * 1024;
const MAX_RECORDS = 500;
const MAX_COLUMNS = 100;
const MAX_FIELDS_PER_RULE = 20;

function splitFieldList(value, label) {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) throw new TypeError(label + " must be an array of field names.");
  if (value.length > MAX_FIELDS_PER_RULE) {
    throw new TypeError(label + " may contain at most " + MAX_FIELDS_PER_RULE + " fields.");
  }
  const result = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.trim().length > 64) {
      throw new TypeError(label + " must contain non-empty field names up to 64 characters.");
    }
    return entry.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(label + " cannot contain duplicate field names.");
  }
  return result;
}

function normalizeCriteria(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("criteria must be an object.");
  }
  const allowed = new Set(["requiredFields", "uniqueField", "numericFields", "minRows"]);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new TypeError("Unsupported criteria: " + unsupported.join(", "));

  const requiredFields = splitFieldList(value.requiredFields, "requiredFields");
  const numericFields = splitFieldList(value.numericFields, "numericFields");
  const uniqueField = value.uniqueField === undefined || value.uniqueField === null
    ? ""
    : String(value.uniqueField).trim();
  if (uniqueField.length > 64) throw new TypeError("uniqueField must be at most 64 characters.");
  if (value.uniqueField !== undefined && value.uniqueField !== null &&
      (typeof value.uniqueField !== "string" || !uniqueField)) {
    throw new TypeError("uniqueField must be a non-empty string when supplied.");
  }

  const minRows = value.minRows === undefined ? 1 : value.minRows;
  if (!Number.isInteger(minRows) || minRows < 1 || minRows > MAX_RECORDS) {
    throw new TypeError("minRows must be an integer between 1 and " + MAX_RECORDS + ".");
  }
  return { requiredFields, uniqueField, numericFields, minRows };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;

  function pushField() {
    row.push(field.trim());
    field = "";
    afterQuote = false;
  }
  function pushRow() {
    pushField();
    if (row.some((cell) => cell !== "")) rows.push(row);
    row = [];
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else field += ch;
      continue;
    }
    if (afterQuote) {
      if (ch === ",") pushField();
      else if (ch === "\n" || ch === "\r") {
        pushRow();
        if (ch === "\r" && text[i + 1] === "\n") i += 1;
      } else if (ch.trim() === "") {
        // Allow whitespace between a closing quote and its delimiter.
      } else throw new Error("Unexpected character after a quoted CSV field.");
      continue;
    }
    if (ch === '"') {
      if (field.length !== 0) throw new Error("A quote appeared inside an unquoted CSV field.");
      inQuotes = true;
    } else if (ch === ",") pushField();
    else if (ch === "\n" || ch === "\r") {
      pushRow();
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
    } else field += ch;
  }

  if (inQuotes) throw new Error("CSV contains an unterminated quoted field.");
  if (field.length || row.length || afterQuote) pushRow();
  if (!rows.length) throw new Error("CSV has no header row.");

  const headers = rows[0].map((header) => header.trim());
  if (headers.some((header) => !header)) throw new Error("CSV headers cannot be empty.");
  if (headers.length > MAX_COLUMNS) throw new Error("CSV contains more than " + MAX_COLUMNS + " columns.");
  if (new Set(headers.map((header) => header.toLocaleLowerCase())).size !== headers.length) {
    throw new Error("CSV contains duplicate column names.");
  }

  const records = [];
  for (const cells of rows.slice(1)) {
    if (cells.length !== headers.length) {
      throw new Error("CSV row has " + cells.length + " values but " + headers.length + " columns were expected.");
    }
    records.push(Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
    if (records.length > MAX_RECORDS) throw new Error("Artifact contains more than " + MAX_RECORDS + " records.");
  }
  return records;
}

function parseRecords(format, content) {
  if (format === "csv") return parseCsv(content);
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error("JSON could not be parsed."); }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (!records.length) return [];
  if (records.length > MAX_RECORDS) throw new Error("Artifact contains more than " + MAX_RECORDS + " records.");
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error("JSON must be an object or an array of objects.");
  }
  const keyCount = new Set(records.flatMap((record) => Object.keys(record))).size;
  if (keyCount > MAX_COLUMNS) throw new Error("Artifact contains more than " + MAX_COLUMNS + " distinct fields.");
  return records;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function verifyArtifact({ fileName, format, content, criteria = {} }) {
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 120 ||
      /[\\/\u0000-\u001f]/.test(fileName)) {
    throw new TypeError("fileName must be a simple file name up to 120 characters.");
  }
  if (!["json", "csv"].includes(format)) throw new TypeError("format must be json or csv.");
  if (typeof content !== "string") throw new TypeError("content must be text.");
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes === 0) throw new TypeError("Artifact content is empty.");
  if (contentBytes > MAX_CONTENT_BYTES) throw new TypeError("Artifact exceeds the 20 KB upload limit.");

  const normalizedCriteria = normalizeCriteria(criteria);
  const artifact = {
    fileName: fileName.trim(),
    format,
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    sizeBytes: contentBytes,
    recordCount: 0,
  };

  let records;
  try {
    records = parseRecords(format, content);
    artifact.recordCount = records.length;
  } catch (error) {
    return {
      decision: "REVIEW",
      reason: "The artifact could not be parsed confidently. No payment should be attempted.",
      artifact,
      criteria: normalizedCriteria,
      checks: [{ id: "parse", label: "Artifact can be parsed", passed: false, decision: "REVIEW", details: error.message }],
      recordsPreview: [],
      parsed: false,
    };
  }

  const checks = [{
    id: "minimum-rows",
    label: "Minimum record count",
    passed: records.length >= normalizedCriteria.minRows,
    details: records.length + " record(s) found; at least " + normalizedCriteria.minRows + " required.",
  }];

  for (const field of normalizedCriteria.requiredFields) {
    const headerPresent = records.length > 0 && records.every((record) =>
      Object.prototype.hasOwnProperty.call(record, field)
    );
    const valuesPresent = headerPresent && records.every((record) => hasValue(record[field]));
    checks.push({
      id: "required:" + field,
      label: "Required field: " + field,
      passed: valuesPresent,
      details: valuesPresent
        ? "Field exists and is non-empty in every record."
        : "Field is missing or empty in one or more records.",
    });
  }

  if (normalizedCriteria.uniqueField) {
    const field = normalizedCriteria.uniqueField;
    const fieldPresent = records.length > 0 && records.every((record) =>
      Object.prototype.hasOwnProperty.call(record, field) && hasValue(record[field])
    );
    const values = fieldPresent ? records.map((record) => String(record[field]).trim().toLocaleLowerCase()) : [];
    const unique = fieldPresent && new Set(values).size === values.length;
    checks.push({
      id: "unique:" + field,
      label: "Unique field: " + field,
      passed: unique,
      details: unique
        ? "Every record has a distinct value for this field."
        : "The field is missing, empty, or contains duplicate values.",
    });
  }

  for (const field of normalizedCriteria.numericFields) {
    const numeric = records.length > 0 && records.every((record) => {
      if (!Object.prototype.hasOwnProperty.call(record, field)) return false;
      const value = record[field];
      if (typeof value !== "string" && typeof value !== "number") return false;
      if (String(value).trim() === "") return false;
      return Number.isFinite(Number(value));
    });
    checks.push({
      id: "numeric:" + field,
      label: "Numeric field: " + field,
      passed: numeric,
      details: numeric
        ? "Field contains a finite numeric value in every record."
        : "Field is missing or contains a non-numeric value in one or more records.",
    });
  }

  const passed = checks.every((check) => check.passed);
  return {
    decision: passed ? "PASS" : "FAIL",
    reason: passed
      ? "All configured structural acceptance checks passed for " + records.length + " record(s)."
      : "One or more configured acceptance checks failed. Inspect each check before deciding what to do next.",
    artifact,
    criteria: normalizedCriteria,
    checks,
    recordsPreview: records.slice(0, 3),
    parsed: true,
  };
}

module.exports = {
  MAX_CONTENT_BYTES,
  MAX_RECORDS,
  normalizeCriteria,
  parseCsv,
  parseRecords,
  verifyArtifact,
};