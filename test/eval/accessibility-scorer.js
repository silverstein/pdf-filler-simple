import fs from "node:fs/promises";
import {
  inspectPdfAccessibilityBytes,
} from "../../server/accessibility-inspection.js";

export const ACCESSIBILITY_SCORER_ID = "pdf_accessibility_structural_screen";
export const ACCESSIBILITY_SCORER_VERSION = 1;
export const ACCESSIBILITY_CLAIM_GATE_VERSION = 1;
export const ACCESSIBILITY_RULES = Object.freeze([
  { id: "parseable_pdf", family: "file_integrity" },
  { id: "catalog_marked", family: "tagged_pdf_structure" },
  { id: "document_language", family: "document_metadata" },
  { id: "document_title", family: "document_metadata" },
  { id: "display_document_title", family: "document_metadata" },
  { id: "structure_tree_root", family: "tagged_pdf_structure" },
  { id: "structure_root_children", family: "tagged_pdf_structure" },
  { id: "structure_parent_tree", family: "tagged_pdf_structure" },
]);
export const ACCESSIBILITY_ALLOWED_STATEMENTS = Object.freeze({
  structural_failures_detected: "Automated structural screening detected the listed machine-checkable failures.",
  no_structural_failures_detected: "Automated structural screening found no failures among the checks it performed.",
});
export const ACCESSIBILITY_PROHIBITED_CLAIMS = Object.freeze([
  "accessible PDF",
  "PDF/UA compliant",
  "WCAG compliant",
  "certified accessible",
]);

const RULE_BY_ID = new Map(ACCESSIBILITY_RULES.map(rule => [rule.id, rule]));

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateAccessibilityTaxonomyContract(taxonomy) {
  const errors = [];
  const capability = taxonomy?.automated_lane_capability;
  if (taxonomy?.taxonomy_version !== 1) errors.push("taxonomy_version must equal 1");
  if (capability?.scorer_id !== ACCESSIBILITY_SCORER_ID) errors.push("taxonomy scorer_id does not match executable scorer");
  if (capability?.scorer_version !== ACCESSIBILITY_SCORER_VERSION) errors.push("taxonomy scorer_version does not match executable scorer");
  if (capability?.claim_gate_version !== ACCESSIBILITY_CLAIM_GATE_VERSION) errors.push("taxonomy claim_gate_version does not match executable gate");
  if (capability?.maximum_emittable_state !== "no_structural_failures_detected") {
    errors.push("taxonomy maximum_emittable_state does not match executable gate");
  }
  const executableStates = Object.keys(ACCESSIBILITY_ALLOWED_STATEMENTS);
  if (!sameJson(capability?.executable_claim_states, executableStates)) {
    errors.push("taxonomy executable_claim_states do not exactly match executable gate states");
  }
  for (const state of executableStates) {
    if (taxonomy?.claim_states?.[state]?.allowed_statement !== ACCESSIBILITY_ALLOWED_STATEMENTS[state]) {
      errors.push(`taxonomy statement for ${state} does not match executable gate`);
    }
  }
  if (!sameJson(taxonomy?.prohibited_unqualified_terms, ACCESSIBILITY_PROHIBITED_CLAIMS)) {
    errors.push("taxonomy prohibited terms do not exactly match executable gate");
  }
  if (!sameJson(capability?.structural_rules, ACCESSIBILITY_RULES)) {
    errors.push("taxonomy structural rules do not exactly match executable scorer");
  }
  return errors;
}

function finding(id, passed, description, actual) {
  const rule = RULE_BY_ID.get(id);
  if (!rule) throw new Error(`Unknown accessibility structural rule: ${id}`);
  return {
    id,
    rule_family: rule.family,
    classification: "machine_checkable_structural_signal",
    passed,
    description,
    actual,
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
  const maximumClaimState = screenPassed
    ? "no_structural_failures_detected"
    : "structural_failures_detected";
  return {
    gate_version: ACCESSIBILITY_CLAIM_GATE_VERSION,
    maximum_claim_state: maximumClaimState,
    allowed_statement: ACCESSIBILITY_ALLOWED_STATEMENTS[maximumClaimState],
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
    prohibited_claims: [...ACCESSIBILITY_PROHIBITED_CLAIMS],
  };
}

export async function screenPdfAccessibility(candidatePath, { evidence } = {}) {
  const bytes = await fs.readFile(candidatePath);
  const inspection = await inspectPdfAccessibilityBytes(bytes, {
    source_file_name: "evaluation-fixture.pdf",
  });
  const ruleProjection = new Map([
    ["parseable_pdf", ["parseable_pdf", "File parses as a PDF"]],
    ["catalog_marked_true", ["catalog_marked", "Catalog MarkInfo/Marked is true"]],
    ["document_language_present", ["document_language", "Catalog Lang is a non-empty string"]],
    ["document_title_present", ["document_title", "Document information title is non-empty"]],
    ["display_document_title_true", ["display_document_title", "ViewerPreferences/DisplayDocTitle is true"]],
    ["structure_tree_root_dictionary_present", ["structure_tree_root", "Catalog contains a structure-tree root dictionary"]],
    ["structure_root_k_entry_resolves", ["structure_root_children", "Structure-tree root contains a K entry"]],
    ["structure_parent_tree_entry_resolves", ["structure_parent_tree", "Structure-tree root contains a ParentTree entry"]],
  ]);
  const productChecks = inspection.inspection_status === "partial"
    ? inspection.checks.filter(item => item.id === "parseable_pdf")
    : inspection.checks;
  const findings = productChecks.map(item => {
    const [ruleId, description] = ruleProjection.get(item.id);
    return finding(ruleId, item.status === "observed", description, item.status);
  });
  const failures = findings.filter(item => !item.passed).map(item => item.id);
  const screen = {
    scorer_id: ACCESSIBILITY_SCORER_ID,
    scorer_version: ACCESSIBILITY_SCORER_VERSION,
    status: inspection.result === "no_findings_detected" ? "pass" : "fail",
    findings,
    failures,
    observations: {
      pdfua_identification: {
        declared: inspection.self_declared_identification.status === "observed",
        part: inspection.self_declared_identification.part,
        revision: inspection.self_declared_identification.revision,
      },
    },
    limitations: [
      "This is a shallow catalog-level screen, not a PDF/UA validator.",
      "It does not evaluate semantic tag correctness, reading order, alternate text quality, table structure, contrast, scripting, assistive-technology behavior, or any human-verifiable requirement.",
      "A PDF/UA identification entry is a self-declaration and is recorded only as an observation.",
    ],
  };
  return { screen, claims: applyAccessibilityClaimGate(screen, evidence) };
}
