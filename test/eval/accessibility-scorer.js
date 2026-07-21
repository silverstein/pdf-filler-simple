import fs from "node:fs/promises";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from "pdf-lib";

export const ACCESSIBILITY_SCORER_ID = "pdf_accessibility_structural_screen";
export const ACCESSIBILITY_SCORER_VERSION = 1;

function finding(id, passed, description, actual) {
  return {
    id,
    classification: "machine_checkable_structural_signal",
    passed,
    description,
    actual,
  };
}

function lookupMaybe(context, owner, key, type) {
  if (!owner) return undefined;
  try {
    const raw = owner.get(PDFName.of(key));
    return raw ? context.lookupMaybe(raw, type) : undefined;
  } catch {
    return undefined;
  }
}

function decodedString(context, owner, key) {
  const value = lookupMaybe(context, owner, key, PDFString)
    ?? lookupMaybe(context, owner, key, PDFHexString);
  return value?.decodeText().trim() || null;
}

function booleanValue(context, owner, key) {
  return lookupMaybe(context, owner, key, PDFBool)?.asBoolean() ?? null;
}

function hasObject(context, owner, key) {
  try {
    const raw = owner.get(PDFName.of(key));
    return Boolean(raw && context.lookup(raw));
  } catch {
    return false;
  }
}

function readPdfUaIdentification(document) {
  const stream = lookupMaybe(document.context, document.catalog, "Metadata", PDFRawStream);
  if (!stream) return { declared: false, part: null, revision: null };
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(stream.getContents());
  const part = xml.match(/<pdfuaid:part>\s*(\d+)\s*<\/pdfuaid:part>/i)?.[1];
  const revision = xml.match(/<pdfuaid:rev>\s*(\d+)\s*<\/pdfuaid:rev>/i)?.[1];
  return {
    declared: Boolean(part),
    part: part ? Number(part) : null,
    revision: revision ? Number(revision) : null,
  };
}

function blockedEvidence(evidence) {
  return {
    status: "not_established",
    evidence_received: evidence !== undefined && evidence !== null,
    evidence_disposition: evidence === undefined || evidence === null
      ? "none_supplied"
      : "rejected_no_trusted_v1_ingestion_adapter",
  };
}

export function applyAccessibilityClaimGate(screen, evidence = {}) {
  const screenPassed = screen.status === "pass";
  return {
    gate_version: 1,
    maximum_claim_state: screenPassed
      ? "no_structural_failures_detected"
      : "structural_failures_detected",
    allowed_statement: screenPassed
      ? "Automated structural screening found no failures among the checks it performed."
      : "Automated structural screening detected the listed machine-checkable failures.",
    pdfua_identification_is_self_declared: screen.observations.pdfua_identification.declared,
    machine_validation: blockedEvidence(evidence.machine_validation),
    human_review: {
      ...blockedEvidence(evidence.human_review),
      required_for_conformance_assessment: true,
    },
    pdfua_conformance: {
      status: "not_established",
      reason: "Structural screening and self-declared metadata cannot establish PDF/UA conformance; no trusted complete machine-plus-human evidence path exists in gate v1.",
    },
    wcag_conformance: {
      status: "not_established",
      reason: "WCAG conformance is a separate normative assessment and is never inferred from PDF/UA signals.",
    },
    certified_conformance: {
      ...blockedEvidence(evidence.certification),
      reason: "This repository does not issue accessibility certification and gate v1 trusts no certification authority adapter.",
    },
    prohibited_claims: [
      "accessible PDF",
      "PDF/UA compliant",
      "WCAG compliant",
      "certified accessible",
    ],
  };
}

export async function screenPdfAccessibility(candidatePath, { evidence } = {}) {
  let document;
  try {
    document = await PDFDocument.load(await fs.readFile(candidatePath), { ignoreEncryption: true });
  } catch (error) {
    const screen = {
      scorer_id: ACCESSIBILITY_SCORER_ID,
      scorer_version: ACCESSIBILITY_SCORER_VERSION,
      status: "fail",
      findings: [finding("parseable_pdf", false, "File parses as a PDF", error.message)],
      failures: ["parseable_pdf"],
      observations: { pdfua_identification: { declared: false, part: null, revision: null } },
      limitations: ["No accessibility properties can be inspected because the file did not parse."],
    };
    return { screen, claims: applyAccessibilityClaimGate(screen, evidence) };
  }

  const { catalog, context } = document;
  const markInfo = lookupMaybe(context, catalog, "MarkInfo", PDFDict);
  const structTree = lookupMaybe(context, catalog, "StructTreeRoot", PDFDict);
  const viewerPreferences = lookupMaybe(context, catalog, "ViewerPreferences", PDFDict);
  const language = decodedString(context, catalog, "Lang");
  const title = document.getTitle()?.trim() || null;
  const rootChildren = structTree
    ? lookupMaybe(context, structTree, "K", PDFArray) ?? (hasObject(context, structTree, "K") ? "present_non_array" : null)
    : null;

  const findings = [
    finding("parseable_pdf", true, "File parses as a PDF", true),
    finding("catalog_marked", booleanValue(context, markInfo, "Marked") === true, "Catalog MarkInfo/Marked is true", booleanValue(context, markInfo, "Marked")),
    finding("document_language", Boolean(language), "Catalog Lang is a non-empty string", language),
    finding("document_title", Boolean(title), "Document information title is non-empty", title),
    finding("display_document_title", booleanValue(context, viewerPreferences, "DisplayDocTitle") === true, "ViewerPreferences/DisplayDocTitle is true", booleanValue(context, viewerPreferences, "DisplayDocTitle")),
    finding("structure_tree_root", Boolean(structTree), "Catalog contains a structure-tree root dictionary", Boolean(structTree)),
    finding("structure_root_children", rootChildren !== null, "Structure-tree root contains a K entry", rootChildren === null ? false : true),
    finding("structure_parent_tree", Boolean(structTree && hasObject(context, structTree, "ParentTree")), "Structure-tree root contains a ParentTree entry", Boolean(structTree && hasObject(context, structTree, "ParentTree"))),
  ];
  const failures = findings.filter(item => !item.passed).map(item => item.id);
  const screen = {
    scorer_id: ACCESSIBILITY_SCORER_ID,
    scorer_version: ACCESSIBILITY_SCORER_VERSION,
    status: failures.length === 0 ? "pass" : "fail",
    findings,
    failures,
    observations: { pdfua_identification: readPdfUaIdentification(document) },
    limitations: [
      "This is a shallow catalog-level screen, not a PDF/UA validator.",
      "It does not evaluate semantic tag correctness, reading order, alternate text quality, table structure, contrast, scripting, assistive-technology behavior, or any human-verifiable requirement.",
      "A PDF/UA identification entry is a self-declaration and is recorded only as an observation.",
    ],
  };
  return { screen, claims: applyAccessibilityClaimGate(screen, evidence) };
}
