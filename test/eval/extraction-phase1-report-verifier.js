import { PDFDocument } from "pdf-lib";
import { canonicalJson, reportAttemptKey, sha256, verifyPhase1ReportStructure } from "./extraction-phase1-protocol.js";
import { verifyPhase1ReportLayoutEvidence } from "./extraction-phase1-layout-evidence.js";
import { PHASE1_COMPANION_SOURCE_PATHS } from "./extraction-phase1-companion.js";

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function parseCanonicalJson(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} bytes are unavailable`);
  const value = JSON.parse(bytes);
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) throw new Error(`${label} bytes are not canonical`);
  return value;
}

export function validatorSourceSetSha256(sourceBytesByRole) {
  if (!sourceBytesByRole || typeof sourceBytesByRole !== "object" || Array.isArray(sourceBytesByRole)
    || Object.keys(sourceBytesByRole).length === 0) throw new Error("Layout verification requires exact validator source bytes");
  if (canonicalJson(Object.keys(sourceBytesByRole).sort()) !== canonicalJson(Object.keys(PHASE1_COMPANION_SOURCE_PATHS).sort())) {
    throw new Error("Layout validator source roles differ from the closed runner source set");
  }
  const projection = Object.fromEntries(Object.entries(sourceBytesByRole).map(([role, source]) => {
    exactKeys(source, ["bytes", "path"], `Validator source ${role}`);
    if (!Buffer.isBuffer(source.bytes) || source.bytes.length === 0 || typeof source.path !== "string" || !source.path) {
      throw new Error(`Validator source ${role} is invalid`);
    }
    if (source.path !== PHASE1_COMPANION_SOURCE_PATHS[role]) throw new Error(`Validator source ${role} has an unexpected path`);
    return [role, { path: source.path, bytes: source.bytes.length, sha256: sha256(source.bytes) }];
  }));
  return sha256(Buffer.from(canonicalJson(projection)));
}

export async function verifyRetainedPhase1Report({
  reportBytes,
  verification,
  corpus,
  pdfjsLib,
  validatorSourceBytesByRole,
  trustedFailureEvidenceByAttemptKey,
} = {}) {
  if (!verification || !corpus) throw new Error("Composite report verification requires trusted protocol inputs and retained corpus bytes");
  const report = parseCanonicalJson(reportBytes, "Extraction Phase 1 report");
  if (canonicalJson(corpus.manifest) !== canonicalJson(verification.manifest)
    || sha256(corpus.manifestBytes) !== verification.manifestBytesSha256
    || sha256(corpus.manifestSchemaBytes) !== verification.manifestSchemaBytesSha256
    || canonicalJson(corpus.manifestSchema) !== canonicalJson(verification.manifestSchema)) {
    throw new Error("Retained corpus manifest differs from the trusted report protocol inputs");
  }
  if (canonicalJson(corpus.descriptor.selected_case_ids) !== canonicalJson(report.denominator.planned_case_ids)) {
    throw new Error("Retained corpus case order differs from the exact report denominator");
  }
  if (canonicalJson(Object.keys(corpus.fixtureBytesById).sort())
    !== canonicalJson([...report.denominator.planned_case_ids].sort())) {
    throw new Error("Retained corpus fixture coverage is missing, extra, or null");
  }
  const sourceFactsById = {};
  for (const caseId of report.denominator.planned_case_ids) {
    const fixture = corpus.manifest.fixtures.find(item => item.id === caseId);
    const bytes = corpus.fixtureBytesById[caseId];
    if (!fixture || !Buffer.isBuffer(bytes) || sha256(bytes) !== fixture.sha256) throw new Error(`Retained source bytes drifted for ${caseId}`);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    sourceFactsById[caseId] = { sha256: fixture.sha256, size_bytes: bytes.length, page_count: pdf.getPageCount() };
  }
  const layoutEvidenceByAttemptKey = await verifyPhase1ReportLayoutEvidence({
    report,
    manifest: corpus.manifest,
    sourceBytesByFixtureId: corpus.fixtureBytesById,
    pdfjsLib,
    validatorSourceSetSha256: validatorSourceSetSha256(validatorSourceBytesByRole),
  });
  if (!trustedFailureEvidenceByAttemptKey || typeof trustedFailureEvidenceByAttemptKey !== "object"
    || Array.isArray(trustedFailureEvidenceByAttemptKey)
    || canonicalJson(Object.keys(trustedFailureEvidenceByAttemptKey).sort())
      !== canonicalJson(report.attempts.map(reportAttemptKey).sort())) {
    throw new Error("Composite report verification requires exact trusted runner failure evidence coverage");
  }
  verifyPhase1ReportStructure(report, {
    ...verification,
    manifest: corpus.manifest,
    sourceFactsById,
    failureEvidenceByAttemptKey: trustedFailureEvidenceByAttemptKey,
  });
  return { report, layoutEvidenceByAttemptKey, sourceFactsById, failureEvidenceByAttemptKey: structuredClone(trustedFailureEvidenceByAttemptKey) };
}
