import { createHash } from "node:crypto";
import {
  EncryptedPDFError,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from "pdf-lib";

export const ACCESSIBILITY_INSPECTION_SCHEMA_VERSION =
  "pdf-tools.accessibility-inspection-result/1.0.0";
export const ACCESSIBILITY_INSPECTION_ENGINE = Object.freeze({
  name: "pdf-tools.structural-review-screen",
  version: "1.0.0",
});
export const ACCESSIBILITY_INSPECTION_PARSER = Object.freeze({
  name: "pdf-lib",
  version: "1.17.1",
});
export const ACCESSIBILITY_INSPECTION_CHECKS = Object.freeze([
  Object.freeze({
    id: "parseable_pdf",
    limitation_code: "PARSE_DOES_NOT_ESTABLISH_TAG_SEMANTICS",
  }),
  Object.freeze({
    id: "catalog_marked_true",
    limitation_code: "MARKED_FLAG_IS_NOT_TAG_QUALITY_EVIDENCE",
  }),
  Object.freeze({
    id: "document_language_present",
    limitation_code: "LANGUAGE_VALUE_AND_CHANGES_NOT_ASSESSED",
  }),
  Object.freeze({
    id: "document_title_present",
    limitation_code: "TITLE_MEANING_NOT_ASSESSED",
  }),
  Object.freeze({
    id: "display_document_title_true",
    limitation_code: "VIEWER_PREFERENCE_SIGNAL_ONLY",
  }),
  Object.freeze({
    id: "structure_tree_root_dictionary_present",
    limitation_code: "STRUCTURE_ROOT_CONTENTS_NOT_VALIDATED",
  }),
  Object.freeze({
    id: "structure_root_k_entry_resolves",
    limitation_code: "STRUCTURE_HIERARCHY_ROLES_AND_ORDER_NOT_VALIDATED",
  }),
  Object.freeze({
    id: "structure_parent_tree_entry_resolves",
    limitation_code: "PARENT_TREE_NUMBER_TREE_AND_MAPPINGS_NOT_VALIDATED",
  }),
]);
export const ACCESSIBILITY_INSPECTION_UNRESOLVED_AREAS = Object.freeze([
  "TAG_SEMANTICS",
  "READING_ORDER",
  "ALTERNATIVE_TEXT_QUALITY",
  "TABLE_HEADER_RELATIONSHIPS",
  "FORM_LABELS_AND_KEYBOARD_FLOW",
  "LANGUAGE_CHANGES",
  "CONTRAST_AND_COLOR_DEPENDENCE",
  "LINK_PURPOSE",
  "SCRIPTS_AND_MULTIMEDIA",
  "ASSISTIVE_TECHNOLOGY_BEHAVIOR",
]);
export const ACCESSIBILITY_INSPECTION_LIMITATIONS = Object.freeze([
  "SHALLOW_CATALOG_LEVEL_SIGNALS_ONLY",
  "SOURCE_BOUND_TO_SHA256",
  "NO_SEMANTIC_TAG_VALIDATION",
  "NO_ASSISTIVE_TECHNOLOGY_TESTING",
  "SELF_DECLARATION_NOT_CONFORMANCE_EVIDENCE",
  "QUALIFIED_HUMAN_REVIEW_REQUIRED",
]);

const CHECK_IDS = ACCESSIBILITY_INSPECTION_CHECKS.map(check => check.id);
const CHECK_DEFINITION_BY_ID = new Map(
  ACCESSIBILITY_INSPECTION_CHECKS.map(check => [check.id, check]),
);
const CONCLUSION_KEYS = Object.freeze([
  "pdfua_conformance",
  "wcag_conformance",
  "certification",
  "legal_compliance",
  "document_accessibility",
]);
const MAX_XMP_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PDF_LIB_ENCRYPTED_ERROR_MESSAGE = new EncryptedPDFError().message;

export class AccessibilityInspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AccessibilityInspectionError";
    this.code = code;
  }
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function exactString(value, expected, label) {
  if (value !== expected) throw new TypeError(`${label} is invalid.`);
}

function safeInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function arrayEquals(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function meaningfulText(value) {
  if (typeof value !== "string") return false;
  return value.replace(/[\p{Cc}\p{Cf}\p{Z}\s]/gu, "").length > 0;
}

function lookupMaybe(context, owner, key, type) {
  if (!(owner instanceof PDFDict)) return undefined;
  try {
    const raw = owner.get(PDFName.of(key));
    return raw ? context.lookupMaybe(raw, type) : undefined;
  } catch {
    return undefined;
  }
}

function dictionary(context, owner, key) {
  return lookupMaybe(context, owner, key, PDFDict);
}

function booleanValue(context, owner, key) {
  return lookupMaybe(context, owner, key, PDFBool)?.asBoolean() ?? null;
}

function stringValue(context, owner, key) {
  const value = lookupMaybe(context, owner, key, PDFString)
    ?? lookupMaybe(context, owner, key, PDFHexString);
  try {
    return value?.decodeText() ?? null;
  } catch {
    return null;
  }
}

function entryResolves(context, owner, key) {
  if (!(owner instanceof PDFDict)) return false;
  try {
    const raw = owner.get(PDFName.of(key));
    return Boolean(raw && context.lookup(raw));
  } catch {
    return false;
  }
}

function check(id, status, reasonCode = null) {
  const definition = CHECK_DEFINITION_BY_ID.get(id);
  if (!definition || !["observed", "missing", "unavailable"].includes(status)) {
    throw new TypeError("Accessibility inspection check construction is invalid.");
  }
  if (reasonCode !== null
      && (typeof reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(reasonCode))) {
    throw new TypeError("Accessibility inspection reason code is invalid.");
  }
  return {
    id,
    status,
    limitation_code: definition.limitation_code,
    reason_code: reasonCode,
  };
}

function unavailableDependentChecks(reasonCode) {
  return ACCESSIBILITY_INSPECTION_CHECKS.slice(1).map(definition =>
    check(definition.id, "unavailable", reasonCode)
  );
}

function readSelfDeclaredIdentification(document) {
  const metadata = lookupMaybe(
    document.context,
    document.catalog,
    "Metadata",
    PDFRawStream,
  );
  if (!metadata) {
    return {
      status: "not_observed",
      part: null,
      revision: null,
      reason_code: null,
    };
  }
  if (metadata.dict.has(PDFName.of("Filter"))) {
    return {
      status: "unavailable",
      part: null,
      revision: null,
      reason_code: "COMPRESSED_METADATA_NOT_INSPECTED",
    };
  }
  const contents = metadata.getContents();
  if (!(contents instanceof Uint8Array) || contents.length > MAX_XMP_BYTES) {
    return {
      status: "unavailable",
      part: null,
      revision: null,
      reason_code: "METADATA_SIZE_LIMIT",
    };
  }
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(contents);
  const partText = xml.match(/<pdfuaid:part>\s*([1-9]\d{0,1})\s*<\/pdfuaid:part>/i)?.[1];
  const revisionText = xml.match(/<pdfuaid:rev>\s*([1-9]\d{0,3})\s*<\/pdfuaid:rev>/i)?.[1];
  if (!partText) {
    return {
      status: "not_observed",
      part: null,
      revision: null,
      reason_code: null,
    };
  }
  return {
    status: "observed",
    part: Number(partText),
    revision: revisionText ? Number(revisionText) : null,
    reason_code: null,
  };
}

function sourceFileName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255
      || value === "." || value === ".." || value.includes("/") || value.includes("\\")
      || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new TypeError("source_file_name must be a bounded basename.");
  }
  return value;
}

function createResult(bytes, fileName, checks, identification) {
  const observed = checks.filter(item => item.status === "observed").length;
  const missing = checks.filter(item => item.status === "missing").length;
  const unavailable = checks.filter(item => item.status === "unavailable").length;
  const result = unavailable > 0
    ? "indeterminate"
    : missing > 0
      ? "findings_detected"
      : "no_findings_detected";
  const inspection = {
    schema_version: ACCESSIBILITY_INSPECTION_SCHEMA_VERSION,
    engine: { ...ACCESSIBILITY_INSPECTION_ENGINE },
    parser: { ...ACCESSIBILITY_INSPECTION_PARSER },
    source: {
      file_name: fileName,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspection_status: unavailable > 0 ? "partial" : "complete",
    result,
    checks,
    summary: {
      total: checks.length,
      observed,
      missing,
      unavailable,
      text: `Observed ${observed}, missing ${missing}, and unavailable ${unavailable} of 8 reviewed signals. Human review is required.`,
    },
    self_declared_identification: identification,
    machine_profile_validation: { status: "not_run" },
    human_review: {
      status: "required",
      unresolved_areas: [...ACCESSIBILITY_INSPECTION_UNRESOLVED_AREAS],
    },
    conclusions: Object.fromEntries(CONCLUSION_KEYS.map(key => [key, "not_established"])),
    limitations: [...ACCESSIBILITY_INSPECTION_LIMITATIONS],
  };
  return validateAccessibilityInspectionResult(inspection);
}

export async function inspectPdfAccessibilityBytes(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) {
    throw new TypeError("Accessibility inspection requires non-empty PDF bytes.");
  }
  exactKeys(options, ["source_file_name"], "accessibility inspection options");
  const fileName = sourceFileName(options.source_file_name);
  let document;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError
        || error?.message === PDF_LIB_ENCRYPTED_ERROR_MESSAGE) {
      throw new AccessibilityInspectionError(
        "PDF_ENCRYPTED_INSPECTION_UNAVAILABLE",
        "Encrypted PDF inspection is unavailable because this operation does not accept a password.",
      );
    }
    return createResult(
      bytes,
      fileName,
      [
        check("parseable_pdf", "missing"),
        ...unavailableDependentChecks("STRICT_PARSE_FAILED"),
      ],
      {
        status: "unavailable",
        part: null,
        revision: null,
        reason_code: "STRICT_PARSE_FAILED",
      },
    );
  }

  const { catalog, context } = document;
  const markInfo = dictionary(context, catalog, "MarkInfo");
  const viewerPreferences = dictionary(context, catalog, "ViewerPreferences");
  const structureRoot = dictionary(context, catalog, "StructTreeRoot");
  const language = stringValue(context, catalog, "Lang");
  let title = null;
  try {
    title = document.getTitle();
  } catch {}
  const checks = [
    check("parseable_pdf", "observed"),
    check("catalog_marked_true", booleanValue(context, markInfo, "Marked") === true ? "observed" : "missing"),
    check("document_language_present", meaningfulText(language) ? "observed" : "missing"),
    check("document_title_present", meaningfulText(title) ? "observed" : "missing"),
    check(
      "display_document_title_true",
      booleanValue(context, viewerPreferences, "DisplayDocTitle") === true ? "observed" : "missing",
    ),
    check("structure_tree_root_dictionary_present", structureRoot ? "observed" : "missing"),
    check("structure_root_k_entry_resolves", entryResolves(context, structureRoot, "K") ? "observed" : "missing"),
    check(
      "structure_parent_tree_entry_resolves",
      entryResolves(context, structureRoot, "ParentTree") ? "observed" : "missing",
    ),
  ];
  return createResult(bytes, fileName, checks, readSelfDeclaredIdentification(document));
}

export function validateAccessibilityInspectionResult(value) {
  exactKeys(value, [
    "checks",
    "conclusions",
    "engine",
    "human_review",
    "inspection_status",
    "limitations",
    "machine_profile_validation",
    "parser",
    "result",
    "schema_version",
    "self_declared_identification",
    "source",
    "summary",
  ], "accessibility inspection result");
  exactString(value.schema_version, ACCESSIBILITY_INSPECTION_SCHEMA_VERSION, "schema_version");
  exactKeys(value.engine, ["name", "version"], "engine");
  exactString(value.engine.name, ACCESSIBILITY_INSPECTION_ENGINE.name, "engine.name");
  exactString(value.engine.version, ACCESSIBILITY_INSPECTION_ENGINE.version, "engine.version");
  exactKeys(value.parser, ["name", "version"], "parser");
  exactString(value.parser.name, ACCESSIBILITY_INSPECTION_PARSER.name, "parser.name");
  exactString(value.parser.version, ACCESSIBILITY_INSPECTION_PARSER.version, "parser.version");
  exactKeys(value.source, ["file_name", "sha256", "size_bytes"], "source");
  sourceFileName(value.source.file_name);
  safeInteger(value.source.size_bytes, 1, Number.MAX_SAFE_INTEGER, "source.size_bytes");
  if (!SHA256_PATTERN.test(value.source.sha256)) throw new TypeError("source.sha256 is invalid.");
  if (!Array.isArray(value.checks) || value.checks.length !== CHECK_IDS.length) {
    throw new TypeError("checks must contain exactly eight entries.");
  }
  for (const [index, item] of value.checks.entries()) {
    exactKeys(item, ["id", "limitation_code", "reason_code", "status"], `checks[${index}]`);
    exactString(item.id, CHECK_IDS[index], `checks[${index}].id`);
    exactString(
      item.limitation_code,
      CHECK_DEFINITION_BY_ID.get(item.id).limitation_code,
      `checks[${index}].limitation_code`,
    );
    if (!["observed", "missing", "unavailable"].includes(item.status)) {
      throw new TypeError(`checks[${index}].status is invalid.`);
    }
    if (item.reason_code !== null
        && (typeof item.reason_code !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(item.reason_code))) {
      throw new TypeError(`checks[${index}].reason_code is invalid.`);
    }
    if (item.status === "unavailable" && item.reason_code === null) {
      throw new TypeError(`checks[${index}] unavailable status requires a reason code.`);
    }
    if (item.status !== "unavailable" && item.reason_code !== null) {
      throw new TypeError(`checks[${index}] reason code contradicts its status.`);
    }
  }
  const observed = value.checks.filter(item => item.status === "observed").length;
  const missing = value.checks.filter(item => item.status === "missing").length;
  const unavailable = value.checks.filter(item => item.status === "unavailable").length;
  exactKeys(value.summary, ["missing", "observed", "text", "total", "unavailable"], "summary");
  for (const [key, expected] of Object.entries({
    total: CHECK_IDS.length,
    observed,
    missing,
    unavailable,
  })) {
    safeInteger(value.summary[key], expected, expected, `summary.${key}`);
  }
  const expectedText = `Observed ${observed}, missing ${missing}, and unavailable ${unavailable} of 8 reviewed signals. Human review is required.`;
  exactString(value.summary.text, expectedText, "summary.text");
  const expectedStatus = unavailable > 0 ? "partial" : "complete";
  const expectedResult = unavailable > 0
    ? "indeterminate"
    : missing > 0
      ? "findings_detected"
      : "no_findings_detected";
  exactString(value.inspection_status, expectedStatus, "inspection_status");
  exactString(value.result, expectedResult, "result");
  exactKeys(
    value.self_declared_identification,
    ["part", "reason_code", "revision", "status"],
    "self_declared_identification",
  );
  if (!["observed", "not_observed", "unavailable"].includes(value.self_declared_identification.status)) {
    throw new TypeError("self_declared_identification.status is invalid.");
  }
  const identification = value.self_declared_identification;
  if (identification.status === "observed") {
    safeInteger(identification.part, 1, 99, "self_declared_identification.part");
    if (identification.revision !== null) {
      safeInteger(identification.revision, 1, 9999, "self_declared_identification.revision");
    }
    if (identification.reason_code !== null) {
      throw new TypeError("Observed self-declared identification cannot have a reason code.");
    }
  } else {
    if (identification.part !== null || identification.revision !== null) {
      throw new TypeError("Unobserved self-declared identification cannot carry a value.");
    }
    if (identification.status === "unavailable") {
      if (typeof identification.reason_code !== "string"
          || !/^[A-Z][A-Z0-9_]{1,127}$/.test(identification.reason_code)) {
        throw new TypeError("Unavailable self-declared identification requires a reason code.");
      }
    } else if (identification.reason_code !== null) {
      throw new TypeError("Unobserved self-declared identification cannot have a reason code.");
    }
  }
  exactKeys(value.machine_profile_validation, ["status"], "machine_profile_validation");
  exactString(value.machine_profile_validation.status, "not_run", "machine_profile_validation.status");
  exactKeys(value.human_review, ["status", "unresolved_areas"], "human_review");
  exactString(value.human_review.status, "required", "human_review.status");
  if (!arrayEquals(value.human_review.unresolved_areas, ACCESSIBILITY_INSPECTION_UNRESOLVED_AREAS)) {
    throw new TypeError("human_review.unresolved_areas is invalid.");
  }
  exactKeys(value.conclusions, CONCLUSION_KEYS, "conclusions");
  for (const key of CONCLUSION_KEYS) {
    exactString(value.conclusions[key], "not_established", `conclusions.${key}`);
  }
  if (!arrayEquals(value.limitations, ACCESSIBILITY_INSPECTION_LIMITATIONS)) {
    throw new TypeError("limitations are invalid.");
  }
  return value;
}
