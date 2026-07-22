import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createHash } from "node:crypto";
import { TOOL_SUCCESS_OUTPUT_SCHEMAS } from "../../server/output-schemas.js";
import {
  extractPdfLayout,
  validatePdfLayoutSemantics,
  validatePdfLayoutSourceEvidence,
} from "../../server/layout-extraction.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const PHASE1_LAYOUT_EVIDENCE_ID = "pdf-tools.extraction-phase1-layout-evidence.v1";
export const PHASE1_LAYOUT_EVIDENCE_CONTRACT_SHA256 = sha256(Buffer.from(canonicalJson({
  candidate_evidence: "untrusted-proposal-v1",
  source_spans: "unicode-code-point-half-open-contiguous-line-v1",
  source_validation: "read-pdf-layout-schema-semantics-source-reparse-v1",
  coordinate_gate: "zero-origin-equal-box-zero-rotation-user-unit-one-display-identity-v1",
  bbox: "whole-source-item-union-v1",
  field_value: "exact-json-pointer-canonical-value-sha256-v1",
  fact_credit: "scorer-only-none-any-all-v1",
})));

const DISPLAY_COORDINATE_SPACE = "pdf-tools.display-top-left-points.v1";
const ITEM_SPACE = Object.freeze({
  origin: "top_left",
  unit: "points_1_72_in_after_user_unit",
  reference_box: "pdfjs_display_viewport",
});
const SUPPORTED_MODES = new Set(["layout_ir", "direct_pdf", "raster"]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function valueAtPointer(value, pointer) {
  if (pointer === "") return { found: true, value };
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || current === undefined || !Object.hasOwn(current, key)) {
      return { found: false, value: undefined };
    }
    current = current[key];
  }
  return { found: true, value: current };
}

export function canonicalEvidenceValueSha256(fieldPath, value) {
  return sha256(Buffer.from(`pdf-tools.extraction-phase1-evidence-value.v1\0${canonicalJson({ field_path: fieldPath, value })}`));
}

function exactBox(left, right) {
  return left && right && ["x", "y", "width", "height"].every(key => Object.is(left[key], right[key]));
}

function sameRoundedBox(left, right) {
  return exactBox(left, right);
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function unionBoxes(items) {
  const left = Math.min(...items.map(item => item.bbox.x));
  const top = Math.min(...items.map(item => item.bbox.y));
  const right = Math.max(...items.map(item => item.bbox.x + item.bbox.width));
  const bottom = Math.max(...items.map(item => item.bbox.y + item.bbox.height));
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

function exactArray(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function phase0CoordinateEquivalence(page) {
  const geometry = page?.geometry;
  if (!geometry) return { eligible: false, reason: "missing_page_geometry" };
  if (!exactArray(geometry.item_space, ITEM_SPACE)) return { eligible: false, reason: "unsupported_item_space" };
  if (!geometry.media_box || !geometry.crop_box || !exactBox(geometry.media_box, geometry.crop_box)) {
    return { eligible: false, reason: "media_crop_box_mismatch" };
  }
  const { media_box: box } = geometry;
  if (box.x !== 0 || box.y !== 0) return { eligible: false, reason: "nonzero_page_origin" };
  if (geometry.raw_pdf_rotation !== 0 || geometry.display_rotation !== 0 || geometry.rotation_matches_raw !== true) {
    return { eligible: false, reason: "nonzero_or_unverified_rotation" };
  }
  if (geometry.user_unit !== 1) return { eligible: false, reason: "unsupported_user_unit" };
  if (!exactArray(geometry.pdfjs_view, [0, 0, box.width, box.height])) {
    return { eligible: false, reason: "unsupported_pdfjs_view" };
  }
  if (geometry.display_width !== box.width || geometry.display_height !== box.height) {
    return { eligible: false, reason: "display_dimensions_mismatch" };
  }
  if (!exactArray(geometry.viewport_transform, [1, 0, 0, -1, 0, box.height])) {
    return { eligible: false, reason: "unsupported_viewport_transform" };
  }
  if (page.truncation?.truncated || page.errors?.length !== 0
    || page.raw_items.some(item => !item.geometry_valid
      || (item.text_kind === "non_whitespace" && (item.bbox_status !== "valid" || !item.bbox
        || item.bbox.width <= 0 || item.bbox.height <= 0)))) {
    return { eligible: false, reason: "partial_truncated_or_invalid_page_geometry" };
  }
  return { eligible: true, reason: null };
}

function spanText(item, span) {
  const codePoints = [...item.text];
  if (!Number.isInteger(span.start_code_point) || !Number.isInteger(span.end_code_point)
    || span.start_code_point < 0 || span.end_code_point <= span.start_code_point
    || span.end_code_point > codePoints.length) {
    throw new Error(`Evidence span is outside Unicode code-point bounds for ${item.id}`);
  }
  return codePoints.slice(span.start_code_point, span.end_code_point).join("");
}

function joinSpanText(items, spans, lineDirection) {
  let text = "";
  let previous = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (previous) {
      const gap = lineDirection === "rtl"
        ? previous.x - (item.x + item.width)
        : item.x - (previous.x + previous.width);
      const threshold = Math.max(1, Math.min(item.line_height ?? 8, previous.line_height ?? 8) * 0.2);
      if (gap > threshold && !text.endsWith(" ")) text += " ";
    }
    text += spanText(item, spans[index]);
    previous = item;
  }
  return text;
}

function interItemSpace(previous, item, lineDirection) {
  const gap = lineDirection === "rtl"
    ? previous.x - (item.x + item.width)
    : item.x - (previous.x + previous.width);
  const threshold = Math.max(1, Math.min(item.line_height ?? 8, previous.line_height ?? 8) * 0.2);
  return gap > threshold && !previous.text.endsWith(" ") ? " " : "";
}

function occurrenceRecord({ layout, layoutIrSha256, page, lineId, lineStartCodePoint, lineEndCodePoint, items, sourceSpans, quote, bbox }) {
  const occurrence = {
    source_sha256: layout.source.sha256,
    layout_ir_sha256: layoutIrSha256,
    page,
    line_id: lineId,
    line_start_code_point: lineStartCodePoint,
    line_end_code_point: lineEndCodePoint,
    source_item_ids: items.map(item => item.id),
    source_spans: structuredClone(sourceSpans),
    quote,
    bbox: { ...bbox },
  };
  return {
    ...occurrence,
    occurrence_sha256: sha256(Buffer.from(`pdf-tools.extraction-phase1-occurrence.v1\0${canonicalJson(occurrence)}`)),
  };
}

function projectLine(items, lineDirection) {
  const projection = [];
  let previous = null;
  for (const item of items) {
    if (previous && interItemSpace(previous, item, lineDirection) === " ") projection.push({ codePoint: " ", item: null, offset: null });
    [...item.text].forEach((codePoint, offset) => projection.push({ codePoint, item, offset }));
    previous = item;
  }
  return projection;
}

export function enumerateExactLayoutOccurrences(layout, { page: pageNumber, quote }) {
  const page = layout.pages.find(item => item.page === pageNumber);
  if (!page || typeof quote !== "string" || quote.length === 0) return [];
  const needle = [...quote];
  if (needle.length > 10000) throw new Error("Layout fact anchor exceeds the bounded Unicode occurrence contract");
  const prefix = new Array(needle.length).fill(0);
  for (let index = 1, matched = 0; index < needle.length;) {
    if (needle[index] === needle[matched]) prefix[index++] = ++matched;
    else if (matched > 0) matched = prefix[matched - 1];
    else prefix[index++] = 0;
  }
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  const layoutIrSha256 = sha256(Buffer.from(canonicalJson(layout)));
  const occurrences = [];
  for (const line of page.lines) {
    const items = line.item_ids.map(id => itemById.get(id));
    if (items.some(item => !item || !item.geometry_valid || item.bbox_status !== "valid" || !item.bbox
      || item.bbox.width <= 0 || item.bbox.height <= 0)) continue;
    const projection = projectLine(items, line.direction);
    const haystack = projection.map(point => point.codePoint);
    for (let index = 0, matched = 0; index < haystack.length;) {
      if (haystack[index] === needle[matched]) {
        index += 1;
        matched += 1;
        if (matched === needle.length) {
          const start = index - matched;
          if (projection[start].item !== null && projection[start + needle.length - 1].item !== null) {
            if (occurrences.length >= 1000) throw new Error("Layout fact anchor has too many exact occurrences");
            const selected = projection.slice(start, start + needle.length).filter(point => point.item !== null);
            const selectedItems = [];
            for (const point of selected) {
              if (selectedItems.at(-1)?.id !== point.item.id) selectedItems.push(point.item);
            }
            const sourceSpans = selectedItems.map(item => {
              const offsets = selected.filter(point => point.item.id === item.id).map(point => point.offset);
              return { source_item_id: item.id, start_code_point: offsets[0], end_code_point: offsets.at(-1) + 1 };
            });
            occurrences.push(occurrenceRecord({
              layout,
              layoutIrSha256,
              page: pageNumber,
              lineId: line.id,
              lineStartCodePoint: start,
              lineEndCodePoint: start + needle.length,
              items: selectedItems,
              sourceSpans,
              quote,
              bbox: unionBoxes(selectedItems),
            }));
          }
          matched = prefix[matched - 1];
        }
      } else if (matched > 0) matched = prefix[matched - 1];
      else index += 1;
    }
  }
  const unique = new Map(occurrences.map(item => [canonicalJson(item.source_spans), item]));
  return [...unique.values()];
}

export async function verifyPhase1ReportLayoutEvidence({
  report,
  manifest,
  sourceBytesByFixtureId,
  pdfjsLib,
  validatorSourceSetSha256,
} = {}) {
  if (!report || !manifest || !sourceBytesByFixtureId || typeof sourceBytesByFixtureId !== "object"
    || Array.isArray(sourceBytesByFixtureId)) {
    throw new Error("Independent layout evidence verification requires report, manifest, and retained fixture bytes");
  }
  const fixturesById = new Map(manifest.fixtures.map(item => [item.id, item]));
  const validationCache = new Map();
  const verified = {};
  for (const attempt of report.attempts) {
    const key = `${attempt.candidate_id}\u0000${attempt.case_id}\u0000${attempt.repetition}`;
    if (!attempt.response) {
      if (attempt.runner_evidence !== null || attempt.runner_field_bindings.length !== 0) {
        throw new Error(`No-response attempt retains layout evidence for ${attempt.case_id}`);
      }
      verified[key] = null;
      continue;
    }
    const fixture = fixturesById.get(attempt.case_id);
    if (!fixture) throw new Error(`Layout evidence report references an unknown fixture: ${attempt.case_id}`);
    const sourceBytes = sourceBytesByFixtureId[fixture.id];
    if (!Buffer.isBuffer(sourceBytes)) throw new Error(`Retained fixture bytes are missing for ${fixture.id}`);
    const rederived = await reconcileLayoutIrEvidence({
      request: attempt.request,
      response: attempt.response,
      sourceBytes,
      pdfjsLib,
      validatorSourceSetSha256,
      validationCache,
    });
    if (canonicalJson(rederived) !== canonicalJson(attempt.runner_evidence)
      || canonicalJson(rederived.field_bindings) !== canonicalJson(attempt.runner_field_bindings)) {
      throw new Error(`Retained runner layout evidence differs from independent rederivation for ${attempt.case_id}`);
    }
    verified[key] = rederived;
  }
  return verified;
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

export function classifyLayoutFactOccurrence(layout, fact) {
  const page = layout.pages.find(item => item.page === fact.page);
  const coordinate = page ? phase0CoordinateEquivalence(page) : { eligible: false, reason: "page_not_retained" };
  const occurrences = page ? enumerateExactLayoutOccurrences(layout, { page: fact.page, quote: fact.anchor_text }) : [];
  let approved = null;
  if (coordinate.eligible && occurrences.length === 1) approved = occurrences[0];
  if (coordinate.eligible && occurrences.length > 1) {
    const ranked = occurrences.map(occurrence => ({ occurrence, overlap: intersectionArea(occurrence.bbox, fact.bbox) }))
      .sort((left, right) => right.overlap - left.overlap || left.occurrence.occurrence_sha256.localeCompare(right.occurrence.occurrence_sha256));
    if (ranked[0].overlap > 0 && ranked[0].overlap > ranked[1].overlap) approved = ranked[0].occurrence;
  }
  let status = "approved_unique";
  let statusReason = occurrences.length === 1
    ? "one exact Unicode occurrence exists on the source-validated layout page"
    : "one exact occurrence has a unique positive maximum overlap with the manifest review region";
  if (!page) {
    status = "layout_unavailable";
    statusReason = "the canonical layout input does not retain the manifest fact page";
  } else if (!coordinate.eligible) {
    status = "coordinate_unavailable";
    statusReason = `the canonical layout page fails the Phase 0 coordinate-equivalence gate: ${coordinate.reason}`;
  } else if (occurrences.length === 0) {
    status = "absent";
    statusReason = "the exact anchor text is absent from the source-validated ODA text items";
  } else if (!approved) {
    status = "ambiguous";
    statusReason = "multiple exact Unicode occurrences remain indistinguishable under the reviewed source region";
  }
  return { coordinate, occurrences, approved, status, statusReason };
}

export async function buildCanonicalLayoutEvidenceInput({ sourceBytes, sourceSha256, pageCount, pdfjsLib }) {
  return extractPdfLayout({
    pdfjsLib,
    pdfBytes: sourceBytes,
    sourcePath: "source.pdf",
    sourceFileName: "source.pdf",
    sourceSha256,
    requestedStartPage: 1,
    requestedEndPage: pageCount,
    maxItems: 5000,
    maxCharacters: 100000,
    maxOutputCharacters: 200000,
    deadlineMs: 20000,
  });
}

function reconcileProposal(proposal, layout, request, layoutIrSha256) {
  exactKeys(proposal, ["bbox", "coordinate_space", "id", "page", "quote", "source_spans"], `Evidence proposal ${proposal.id}`);
  if (proposal.coordinate_space !== DISPLAY_COORDINATE_SPACE) throw new Error("Layout evidence uses an unsupported coordinate space");
  const page = layout.pages.find(item => item.page === proposal.page);
  if (!page) throw new Error(`Evidence proposal ${proposal.id} references a page outside retained layout IR`);
  if (proposal.source_spans.length === 0) throw new Error(`Evidence proposal ${proposal.id} has no source spans`);
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  const items = proposal.source_spans.map(span => {
    exactKeys(span, ["end_code_point", "source_item_id", "start_code_point"], `Evidence span in ${proposal.id}`);
    const item = itemById.get(span.source_item_id);
    if (!item) throw new Error(`Evidence proposal ${proposal.id} has a dangling or cross-source item ID`);
    return item;
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Evidence proposal ${proposal.id} repeats a source item`);
  if (items.some(item => !item.geometry_valid || !item.bbox || item.bbox_status !== "valid"
    || item.bbox.width <= 0 || item.bbox.height <= 0)) {
    throw new Error(`Evidence proposal ${proposal.id} uses an item without valid source geometry`);
  }
  const lineId = items[0].line_id;
  if (lineId === null || items.some(item => item.line_id !== lineId)) throw new Error(`Evidence proposal ${proposal.id} crosses source lines`);
  const line = page.lines.find(item => item.id === lineId);
  if (!line) throw new Error(`Evidence proposal ${proposal.id} has a dangling source line`);
  const positions = items.map(item => line.item_ids.indexOf(item.id));
  if (positions.some(position => position < 0)
    || positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
    throw new Error(`Evidence proposal ${proposal.id} skips or reverses source reading order`);
  }
  if (items.length > 1) {
    if (proposal.source_spans[0].end_code_point !== [...items[0].text].length
      || proposal.source_spans.at(-1).start_code_point !== 0) {
      throw new Error(`Evidence proposal ${proposal.id} skips a source-item suffix or prefix`);
    }
  }
  for (let index = 1; index < items.length - 1; index += 1) {
    const span = proposal.source_spans[index];
    if (span.start_code_point !== 0 || span.end_code_point !== [...items[index].text].length) {
      throw new Error(`Evidence proposal ${proposal.id} has a noncontiguous interior item span`);
    }
  }
  const quote = joinSpanText(items, proposal.source_spans, line.direction);
  if (quote !== proposal.quote || quote.trim().length === 0) throw new Error(`Evidence proposal ${proposal.id} quote differs from exact source spans`);
  const bbox = unionBoxes(items);
  if (!sameRoundedBox(proposal.bbox, bbox)) throw new Error(`Evidence proposal ${proposal.id} bbox differs from the exact source-item union`);
  if (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > page.geometry.display_width
    || bbox.y + bbox.height > page.geometry.display_height) {
    throw new Error(`Evidence proposal ${proposal.id} bbox is outside source display geometry`);
  }
  const coordinate = phase0CoordinateEquivalence(page);
  const lineItems = line.item_ids.map(id => itemById.get(id));
  const projection = projectLine(lineItems, line.direction);
  const firstSpan = proposal.source_spans[0];
  const lastSpan = proposal.source_spans.at(-1);
  const lineStartCodePoint = projection.findIndex(point => point.item?.id === firstSpan.source_item_id && point.offset === firstSpan.start_code_point);
  let lineEndCodePoint = -1;
  for (let index = projection.length - 1; index >= 0; index -= 1) {
    const point = projection[index];
    if (point.item?.id === lastSpan.source_item_id && point.offset === lastSpan.end_code_point - 1) {
      lineEndCodePoint = index + 1;
      break;
    }
  }
  if (lineStartCodePoint < 0 || lineEndCodePoint <= lineStartCodePoint) throw new Error(`Evidence proposal ${proposal.id} cannot be projected onto its source line`);
  const occurrence = occurrenceRecord({
    layout,
    layoutIrSha256,
    page: proposal.page,
    lineId: line.id,
    lineStartCodePoint,
    lineEndCodePoint,
    items,
    sourceSpans: proposal.source_spans,
    quote,
    bbox,
  });
  return {
    evidence_id: proposal.id,
    ...occurrence,
    phase0_coordinate_equivalent: coordinate.eligible,
    coordinate_unavailable_reason: coordinate.reason,
  };
}

export async function reconcileLayoutIrEvidence({
  request,
  response,
  sourceBytes,
  pdfjsLib,
  layoutSchema = TOOL_SUCCESS_OUTPUT_SCHEMAS.read_pdf_layout,
  validatorSourceSetSha256,
  validationCache = null,
} = {}) {
  if (!request || !response || !SUPPORTED_MODES.has(request.input_mode)) throw new Error("Layout evidence reconciliation requires a retained request and response");
  if (request.input_mode !== "layout_ir") {
    if (response.evidence.length > 0 || response.field_evidence.length > 0) {
      throw new Error("Only layout_ir attempts may propose ODA canonical evidence");
    }
    return {
      evidence_contract_id: PHASE1_LAYOUT_EVIDENCE_ID,
      evidence_contract_sha256: PHASE1_LAYOUT_EVIDENCE_CONTRACT_SHA256,
      mode: request.input_mode,
      availability: "unavailable",
      layout_ir_sha256: null,
      coordinate_pages: [],
      records: [],
      field_bindings: [],
      unavailable_reasons: ["canonical evidence is unavailable for non-layout_ir candidate inputs"],
    };
  }
  const layout = request.inputs.layout_ir;
  const actualSourceSha256 = sha256(sourceBytes);
  if (actualSourceSha256 !== request.source.sha256 || sourceBytes.length !== request.source.size_bytes) {
    throw new Error("Layout evidence source bytes differ from the retained runner request");
  }
  if (!/^[a-f0-9]{64}$/.test(validatorSourceSetSha256 ?? "")) {
    throw new Error("Layout evidence reconciliation requires an exact validator source-set digest");
  }
  if (response.evidence.length > 1000 || response.field_evidence.length > 1000
    || response.evidence.some(item => item.source_spans.length > 100)
    || response.field_evidence.some(item => item.evidence_ids.length > 100)) {
    throw new Error("Layout evidence proposal exceeds the bounded reconciliation contract");
  }
  const validation = new AjvJsonSchemaValidator().getValidator(layoutSchema)(layout);
  if (!validation.valid) throw new Error(`Layout IR violates the exact read_pdf_layout output schema: ${validation.errorMessage}`);
  if (String(pdfjsLib?.version ?? "") !== "5.4.624") throw new Error("Layout evidence requires pinned PDF.js 5.4.624");
  const layoutIrSha256 = sha256(Buffer.from(canonicalJson(layout)));
  const validationKey = sha256(Buffer.from(`pdf-tools.extraction-phase1-layout-validation-cache.v1\0${canonicalJson({
    source_sha256: actualSourceSha256,
    layout_ir_sha256: layoutIrSha256,
    layout_schema_sha256: sha256(Buffer.from(canonicalJson(layoutSchema))),
    pdfjs_version: String(pdfjsLib.version),
    validator_source_set_sha256: validatorSourceSetSha256,
  })}`));
  const validateSource = async () => {
    validatePdfLayoutSemantics(layout, { sourceBytes });
    await validatePdfLayoutSourceEvidence(layout, { pdfjsLib, sourceBytes });
  };
  if (validationCache instanceof Map) {
    if (!validationCache.has(validationKey)) validationCache.set(validationKey, validateSource());
    try {
      await validationCache.get(validationKey);
    } catch (error) {
      validationCache.delete(validationKey);
      throw error;
    }
  } else {
    await validateSource();
  }
  if (layout.source.sha256 !== request.source.sha256 || layout.source.size_bytes !== request.source.size_bytes
    || layout.source.pdf_path !== "source.pdf" || layout.source.file_name !== "source.pdf"
    || layout.page_range.total_pages !== request.source.page_count
    || layout.page_range.requested_start_page !== 1 || layout.page_range.start_page !== 1
    || layout.page_range.requested_end_page !== request.source.page_count
    || layout.page_range.end_page !== request.source.page_count) {
    throw new Error("Layout IR is not bound to the exact candidate source request");
  }
  const records = response.evidence.map(proposal => reconcileProposal(proposal, layout, request, layoutIrSha256));
  const evidenceIds = records.map(record => record.evidence_id);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Candidate response contains duplicate canonical evidence IDs");
  const canonicalRecordTokens = records.map(record => canonicalJson({
    page: record.page,
    source_item_ids: record.source_item_ids,
    source_spans: record.source_spans,
    quote: record.quote,
    bbox: record.bbox,
  }));
  if (new Set(canonicalRecordTokens).size !== canonicalRecordTokens.length) throw new Error("Candidate response contains duplicate canonical evidence occurrences");
  const evidenceIdSet = new Set(evidenceIds);
  const fieldPaths = new Set();
  const gapPaths = new Set(response.gaps.map(item => item.field_path));
  const fieldBindings = response.field_evidence.map(binding => {
    exactKeys(binding, ["disposition", "evidence_ids", "field_path", "value_sha256"], `Field evidence ${binding.field_path}`);
    if (fieldPaths.has(binding.field_path)) throw new Error(`Candidate response repeats field evidence for ${binding.field_path}`);
    fieldPaths.add(binding.field_path);
    const observed = valueAtPointer(response.structured_candidate, binding.field_path);
    if (binding.disposition === "answer" && (!observed.found || gapPaths.has(binding.field_path))) {
      throw new Error(`Answer evidence references a field without an exact answer: ${binding.field_path}`);
    }
    if (binding.disposition === "gap" && (!gapPaths.has(binding.field_path) || observed.found)) {
      throw new Error(`Gap evidence references a field without an exact typed gap: ${binding.field_path}`);
    }
    const expectedValueSha256 = binding.disposition === "answer"
      ? canonicalEvidenceValueSha256(binding.field_path, observed.value) : null;
    if (binding.value_sha256 !== expectedValueSha256) throw new Error(`Field evidence value digest differs from its exact disposition: ${binding.field_path}`);
    for (const evidenceId of binding.evidence_ids) {
      if (!evidenceIdSet.has(evidenceId)) throw new Error(`Field evidence references unknown evidence ID ${evidenceId}`);
    }
    return {
      field_path: binding.field_path,
      disposition: binding.disposition,
      value_sha256: expectedValueSha256,
      evidence_ids: [...binding.evidence_ids],
    };
  });
  return {
    evidence_contract_id: PHASE1_LAYOUT_EVIDENCE_ID,
    evidence_contract_sha256: PHASE1_LAYOUT_EVIDENCE_CONTRACT_SHA256,
    mode: "layout_ir",
    availability: "measured",
    layout_ir_sha256: layoutIrSha256,
    coordinate_pages: layout.pages.map(page => layout.truncation.truncated
      ? { page: page.page, eligible: false, reason: "document_level_truncation" }
      : { page: page.page, ...phase0CoordinateEquivalence(page) }),
    records,
    field_bindings: fieldBindings,
    unavailable_reasons: [...new Set(records.filter(item => !item.phase0_coordinate_equivalent).map(item => item.coordinate_unavailable_reason))].sort(),
  };
}

function metric({ applicable, evaluable, matched, missing, spurious = 0 }) {
  const availability = applicable === 0 ? "not_applicable"
    : evaluable === 0 ? "unavailable"
      : evaluable < applicable ? "partial" : "measured";
  const precision = matched + spurious === 0 ? (evaluable === 0 ? null : 0) : matched / (matched + spurious);
  const recall = evaluable === 0 ? null : matched / evaluable;
  const f1 = precision === null || recall === null ? null
    : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    availability,
    applicable,
    evaluable,
    matched,
    missing,
    spurious,
    coverage: applicable === 0 ? null : evaluable / applicable,
    precision,
    recall,
    score: f1,
  };
}

export function scoreLayoutCanonicalEvidence({ fixture, oracleCase, layoutOracleCase, response, reconciliation, layout }) {
  const unavailable = reason => ({
    availability: "unavailable",
    reason,
    page: metric({ applicable: fixture.expected.facts.length, evaluable: 0, matched: 0, missing: fixture.expected.facts.length }),
    bbox: metric({ applicable: fixture.expected.facts.length, evaluable: 0, matched: 0, missing: fixture.expected.facts.length }),
    fact: metric({ applicable: fixture.expected.facts.length, evaluable: 0, matched: 0, missing: fixture.expected.facts.length }),
    answer: metric({ applicable: oracleCase.truth_leaves.filter(item => item.disposition === "answer" && item.fact_support.mode !== "none").length, evaluable: 0, matched: 0, missing: oracleCase.truth_leaves.filter(item => item.disposition === "answer" && item.fact_support.mode !== "none").length }),
  });
  if (!reconciliation || reconciliation.mode !== "layout_ir") return unavailable("canonical evidence is unavailable outside layout_ir attempts");
  if (reconciliation.availability !== "measured") return unavailable("runner-owned layout evidence was not measured");
  if (!layoutOracleCase || !layout || layoutOracleCase.case_id !== fixture.id
    || layoutOracleCase.source_sha256 !== fixture.sha256
    || layoutOracleCase.layout_ir_sha256 !== reconciliation.layout_ir_sha256
    || layoutOracleCase.layout_ir_sha256 !== sha256(Buffer.from(canonicalJson(layout)))) {
    throw new Error(`Layout occurrence oracle is not bound to the exact source and layout IR for ${fixture.id}`);
  }
  const recordById = new Map(reconciliation.records.map(record => [record.evidence_id, record]));
  const bindingsByPath = new Map(reconciliation.field_bindings.map(binding => [binding.field_path, binding]));
  const factOracleById = new Map(layoutOracleCase.facts.map(item => [item.fact_id, item]));
  if (canonicalJson(layoutOracleCase.facts.map(item => item.fact_id)) !== canonicalJson(fixture.expected.facts.map(item => item.id))) {
    throw new Error(`Layout occurrence oracle fact order drifted for ${fixture.id}`);
  }
  const approvedByFactId = new Map();
  const observedByFactId = new Map();
  for (const fact of fixture.expected.facts) {
    const factOracle = factOracleById.get(fact.id);
    if (!factOracle || factOracle.field_path !== fact.field_path || factOracle.anchor_text !== fact.anchor_text || factOracle.page !== fact.page) {
      throw new Error(`Layout occurrence oracle fact binding drifted for ${fact.id}`);
    }
    const classified = classifyLayoutFactOccurrence(layout, fact);
    const observed = classified.occurrences;
    observedByFactId.set(fact.id, observed);
    const observedDigests = observed.map(item => item.occurrence_sha256).sort();
    if (classified.status !== factOracle.status
      || classified.statusReason !== factOracle.status_reason
      || (classified.coordinate.eligible ? "eligible" : "unavailable") !== factOracle.geometry_status
      || classified.coordinate.reason !== factOracle.geometry_reason
      || canonicalJson(observedDigests) !== canonicalJson([...factOracle.observed_occurrence_sha256].sort())
      || canonicalJson(classified.approved) !== canonicalJson(factOracle.approved_occurrence)) {
      throw new Error(`Layout occurrence oracle source occurrences drifted for ${fact.id}`);
    }
    if (factOracle.status === "approved_unique") {
      approvedByFactId.set(fact.id, factOracle.approved_occurrence);
    }
  }
  const rawRecordSupportsApproved = (record, factId, approved) => {
    if (!record || !approved || record.phase0_coordinate_equivalent !== true
      || record.source_sha256 !== approved.source_sha256
      || record.layout_ir_sha256 !== approved.layout_ir_sha256
      || record.page !== approved.page || record.line_id !== approved.line_id
      || record.line_start_code_point > approved.line_start_code_point
      || record.line_end_code_point < approved.line_end_code_point) return false;
    const contained = observedByFactId.get(factId).filter(occurrence => occurrence.line_id === record.line_id
      && occurrence.line_start_code_point >= record.line_start_code_point
      && occurrence.line_end_code_point <= record.line_end_code_point);
    return contained.length === 1 && contained[0].occurrence_sha256 === approved.occurrence_sha256;
  };
  const contiguousWithAssignments = (approved, assignments) => assignments.every(existing =>
    existing.source_sha256 === approved.source_sha256
      && existing.layout_ir_sha256 === approved.layout_ir_sha256
      && existing.page === approved.page
      && existing.line_id === approved.line_id
      && existing.line_start_code_point <= approved.line_end_code_point
      && approved.line_start_code_point <= existing.line_end_code_point);
  const eligibleFactIdsByRecord = new Map(reconciliation.records.map(record => {
    const assignments = [];
    const factIds = new Set();
    for (const fact of fixture.expected.facts) {
      const approved = approvedByFactId.get(fact.id);
      if (rawRecordSupportsApproved(record, fact.id, approved) && contiguousWithAssignments(approved, assignments)) {
        assignments.push(approved);
        factIds.add(fact.id);
      }
    }
    return [record.evidence_id, factIds];
  }));
  const recordSupportsApproved = (record, factId, approved) =>
    eligibleFactIdsByRecord.get(record?.evidence_id)?.has(factId) === true
      && rawRecordSupportsApproved(record, factId, approved);
  const matchedPageFacts = new Set();
  const matchedBboxFacts = new Set();
  const matchedSemanticFacts = new Set();
  const pageRecordIds = new Set();
  const bboxRecordIds = new Set();
  const factRecordIds = new Set();
  for (const fact of fixture.expected.facts) {
    const approved = approvedByFactId.get(fact.id);
    if (!approved) continue;
    const supportedPaths = oracleCase.truth_leaves
      .filter(leaf => leaf.fact_support.fact_ids.includes(fact.id))
      .map(leaf => leaf.field_path);
    const records = reconciliation.records.filter(record => supportedPaths.some(fieldPath =>
      bindingsByPath.get(fieldPath)?.evidence_ids.includes(record.evidence_id)));
    const pageRecord = records.find(record => record.phase0_coordinate_equivalent === true
      && record.source_sha256 === approved.source_sha256 && record.layout_ir_sha256 === approved.layout_ir_sha256
      && record.page === approved.page && eligibleFactIdsByRecord.get(record.evidence_id)?.has(fact.id));
    if (pageRecord) {
      matchedPageFacts.add(fact.id);
      pageRecordIds.add(pageRecord.evidence_id);
    }
    const bboxRecord = records.find(record => record.phase0_coordinate_equivalent === true
      && record.source_sha256 === approved.source_sha256 && record.layout_ir_sha256 === approved.layout_ir_sha256
      && record.page === approved.page && record.line_id === approved.line_id && exactBox(record.bbox, approved.bbox)
      && eligibleFactIdsByRecord.get(record.evidence_id)?.has(fact.id));
    if (bboxRecord) {
      matchedBboxFacts.add(fact.id);
      bboxRecordIds.add(bboxRecord.evidence_id);
    }
    const semanticRecord = records.find(record => recordSupportsApproved(record, fact.id, approved));
    if (semanticRecord) {
      matchedSemanticFacts.add(fact.id);
      factRecordIds.add(semanticRecord.evidence_id);
    }
  }
  const supportedLeaves = oracleCase.truth_leaves.filter(item => item.disposition === "answer" && item.fact_support.mode !== "none");
  let evaluableAnswers = 0;
  let matchedAnswers = 0;
  const answerRecordIds = new Set();
  for (const leaf of supportedLeaves) {
    const facts = leaf.fact_support.fact_ids.map(id => approvedByFactId.get(id));
    if (facts.length === 0) throw new Error(`Scorer fact mode ${leaf.fact_support.mode} has an empty fact set`);
    const factsEvaluable = facts.filter(Boolean);
    const answerEvaluable = leaf.fact_support.mode === "all"
      ? factsEvaluable.length === facts.length
      : factsEvaluable.length > 0;
    if (!answerEvaluable) continue;
    evaluableAnswers += 1;
    const binding = bindingsByPath.get(leaf.field_path);
    const observed = valueAtPointer(response.structured_candidate, leaf.field_path);
    if (!binding || binding.disposition !== "answer" || !observed.found || !Object.is(observed.value, leaf.value)
      || binding.value_sha256 !== canonicalEvidenceValueSha256(leaf.field_path, observed.value)) continue;
    const matchedRecords = leaf.fact_support.fact_ids.map((factId, index) => binding.evidence_ids
      .map(id => recordById.get(id)).find(record => recordSupportsApproved(record, factId, facts[index])));
    const factSemanticsMatch = leaf.fact_support.mode === "all" ? matchedRecords.every(Boolean) : matchedRecords.some(Boolean);
    const distinctOccurrences = matchedRecords.filter(Boolean).map(item => item.occurrence_sha256);
    if (factSemanticsMatch && new Set(distinctOccurrences).size === distinctOccurrences.length) {
      matchedAnswers += 1;
      matchedRecords.filter(Boolean).forEach(item => answerRecordIds.add(item.evidence_id));
    }
  }
  const referencedByAnswer = new Set(reconciliation.field_bindings.filter(item => item.disposition === "answer").flatMap(item => item.evidence_ids));
  const evaluableFacts = approvedByFactId.size;
  const pageSpurious = reconciliation.records.filter(record => !pageRecordIds.has(record.evidence_id)).length;
  const bboxSpurious = reconciliation.records.filter(record => !bboxRecordIds.has(record.evidence_id)).length;
  const factSpurious = reconciliation.records.filter(record => !factRecordIds.has(record.evidence_id)).length;
  const answerSpurious = [...referencedByAnswer].filter(id => !answerRecordIds.has(id)).length;
  const page = metric({ applicable: fixture.expected.facts.length, evaluable: evaluableFacts, matched: matchedPageFacts.size, missing: evaluableFacts - matchedPageFacts.size, spurious: pageSpurious });
  const bbox = metric({ applicable: fixture.expected.facts.length, evaluable: evaluableFacts, matched: matchedBboxFacts.size, missing: evaluableFacts - matchedBboxFacts.size, spurious: bboxSpurious });
  const fact = metric({ applicable: fixture.expected.facts.length, evaluable: evaluableFacts, matched: matchedSemanticFacts.size, missing: evaluableFacts - matchedSemanticFacts.size, spurious: factSpurious });
  const answer = metric({ applicable: supportedLeaves.length, evaluable: evaluableAnswers, matched: matchedAnswers, missing: evaluableAnswers - matchedAnswers, spurious: answerSpurious });
  const availability = [page, bbox, fact, answer].some(item => item.availability === "partial") ? "partial"
    : [page, bbox, fact, answer].every(item => ["unavailable", "not_applicable"].includes(item.availability)) ? "unavailable"
      : "measured";
  return { availability, reason: null, page, bbox, fact, answer };
}

export function aggregateLayoutCanonicalEvidence(attempts) {
  const keys = ["page", "bbox", "fact", "answer"];
  const result = {};
  for (const key of keys) {
    const values = attempts.map(item => item.canonical_evidence[key]);
    result[key] = metric({
      applicable: values.reduce((sum, item) => sum + item.applicable, 0),
      evaluable: values.reduce((sum, item) => sum + item.evaluable, 0),
      matched: values.reduce((sum, item) => sum + item.matched, 0),
      missing: values.reduce((sum, item) => sum + item.missing, 0),
      spurious: values.reduce((sum, item) => sum + item.spurious, 0),
    });
  }
  result.availability = Object.values(result).some(item => item.availability === "partial") ? "partial"
    : Object.values(result).every(item => ["unavailable", "not_applicable"].includes(item.availability)) ? "unavailable"
      : "measured";
  return result;
}
