import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  cropComparisonRgba,
  diffComparisonRgba,
  inspectComparisonDocument,
  rendererFingerprint,
} from "./comparison-observations.js";
import { COMPARISON_CHANNELS } from "./comparison-manifest.js";
import { registerControllerObservationRecords } from "./comparison-observation-registry.js";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value
    : typeof value === "string" ? value : canonical(value)).digest("hex");
}

function markerName(marker) {
  return marker?.replace(/^PAGE-ID: /, "") ?? null;
}

function pageBox(page) {
  return [0, 0, page.width, page.height];
}

function makeObservation(state, channel, document, pageNumber, region, valueSha256, payload) {
  const id = `evidence.reference.${state.observationSequence}`;
  state.observationSequence += 1;
  const page = document.pages[pageNumber - 1];
  const rawResultSha256 = digest(payload);
  state.observations.push({
    id,
    channel,
    document_sha256: document.sha256,
    page: pageNumber,
    page_box: pageBox(page),
    rotation: 0,
    region,
    value_sha256: valueSha256,
    raw_result_sha256: rawResultSha256,
    capture: state.capture,
  });
  state.controllerRecords.push({
    pair_id: state.pairId,
    observation_id: id,
    raw_result_sha256: rawResultSha256,
    capture: state.capture,
  });
  return id;
}

function makeFacet(state, channel, operation, before, after) {
  return {
    channel,
    operation,
    before_evidence_id: before ? makeObservation(state, channel, ...before) : null,
    after_evidence_id: after ? makeObservation(state, channel, ...after) : null,
  };
}

function addEvent(state, salience, summary, facets, disposition) {
  const id = `candidate.reference.${state.eventSequence}`;
  state.eventSequence += 1;
  state.detectedEvents.push({ id, salience, confidence: 1, summary, facets });
  state.presentationDecisions.push({
    event_id: id,
    mode: "default_material",
    disposition,
    rationale: `Deterministic ${salience} policy for the shared-library reference baseline.`,
  });
}

function deriveAlignments(before, after) {
  const afterByMarker = new Map(after.pages.map(page => [page.marker, page.page]));
  return before.pages.map(page => {
    const afterPage = afterByMarker.get(page.marker) ?? null;
    return {
      before_page: page.page,
      after_page: afterPage,
      relation: afterPage === null ? "deleted" : afterPage === page.page ? "same" : "moved",
      anchor: page.marker ?? `page-content:${page.text_sha256}`,
    };
  });
}

function alignedPages(before, after, alignments) {
  return alignments.filter(item => item.before_page !== null && item.after_page !== null).map(item => ({
    alignment: item,
    beforePage: before.pages[item.before_page - 1],
    afterPage: after.pages[item.after_page - 1],
    beforeRender: before.renders[item.before_page - 1],
    afterRender: after.renders[item.after_page - 1],
  }));
}

function semanticChange(beforeText, afterText) {
  return /\bUSD\s+[\d,]+\b/.test(beforeText) && /\bUSD\s+[\d,]+\b/.test(afterText)
    || /\b\d+\s+days\b/.test(beforeText) && /\b\d+\s+days\b/.test(afterText);
}

function comparisonValue(text) {
  const separator = text.indexOf(":");
  return separator === -1 ? text : text.slice(separator + 1).trim();
}

function detectTextChanges(state, before, after, pages, renderer) {
  let detected = 0;
  for (const page of pages) {
    const beforeItems = page.beforePage.items;
    const afterItems = page.afterPage.items;
    if (beforeItems.length !== afterItems.length) continue;
    for (let index = 0; index < beforeItems.length; index += 1) {
      const beforeItem = beforeItems[index];
      const afterItem = afterItems[index];
      if (beforeItem.text === afterItem.text) continue;
      const beforeText = [
        before,
        page.alignment.before_page,
        beforeItem.region,
        digest(comparisonValue(beforeItem.text)),
        beforeItem,
      ];
      const afterText = [
        after,
        page.alignment.after_page,
        afterItem.region,
        digest(comparisonValue(afterItem.text)),
        afterItem,
      ];
      const facets = [makeFacet(state, "text", "modified", beforeText, afterText)];
      if (semanticChange(beforeItem.text, afterItem.text)) {
        facets.unshift(makeFacet(state, "semantic", "modified", beforeText, afterText));
      }
      const beforeCrop = cropComparisonRgba(page.beforeRender, beforeItem.region, renderer);
      const afterCrop = cropComparisonRgba(page.afterRender, afterItem.region, renderer);
      facets.push(makeFacet(state, "visual", "modified",
        [before, page.alignment.before_page, beforeItem.region, beforeCrop.rgba_sha256, beforeCrop.rgba],
        [after, page.alignment.after_page, afterItem.region, afterCrop.rgba_sha256, afterCrop.rgba]));
      addEvent(
        state,
        semanticChange(beforeItem.text, afterItem.text) ? "material" : "minor",
        `Text changes from ${JSON.stringify(beforeItem.text)} to ${JSON.stringify(afterItem.text)}.`,
        facets,
        "report",
      );
      detected += 1;
    }
  }
  return detected;
}

function detectStructureChange(state, before, after, alignments) {
  if (!alignments.some(item => item.relation === "moved")) return 0;
  const beforeSequence = before.pages.map(page => markerName(page.marker)).join("|");
  const afterSequence = after.pages.map(page => markerName(page.marker)).join("|");
  if (beforeSequence === afterSequence) return 0;
  const firstMoved = alignments.find(item => item.relation === "moved");
  addEvent(state, "material", "Page order changes between the two documents", [makeFacet(
    state,
    "structure",
    "moved",
    [before, firstMoved.before_page, pageBox(before.pages[firstMoved.before_page - 1]), digest(beforeSequence), beforeSequence],
    [after, firstMoved.after_page, pageBox(after.pages[firstMoved.after_page - 1]), digest(afterSequence), afterSequence],
  )], "report");
  return 1;
}

function detectFieldChanges(state, before, after, renderer) {
  const afterByName = new Map(after.fields.map(field => [field.name, field]));
  let detected = 0;
  for (const beforeField of before.fields) {
    const afterField = afterByName.get(beforeField.name);
    if (!afterField || canonical(beforeField.value) === canonical(afterField.value)) continue;
    const beforePayload = [before, beforeField.page, beforeField.region, beforeField.value_sha256, beforeField];
    const afterPayload = [after, afterField.page, afterField.region, afterField.value_sha256, afterField];
    const beforeCrop = cropComparisonRgba(before.renders[beforeField.page - 1], beforeField.region, renderer);
    const afterCrop = cropComparisonRgba(after.renders[afterField.page - 1], afterField.region, renderer);
    addEvent(state, "material", `${beforeField.name} changes from ${JSON.stringify(beforeField.value)} to ${JSON.stringify(afterField.value)}.`, [
      makeFacet(state, "form_field", "modified", beforePayload, afterPayload),
      makeFacet(state, "visual", "modified",
        [before, beforeField.page, beforeField.region, beforeCrop.rgba_sha256, beforeCrop.rgba],
        [after, afterField.page, afterField.region, afterCrop.rgba_sha256, afterCrop.rgba]),
    ], "report");
    detected += 1;
  }
  return detected;
}

function annotationKey(annotation) {
  return canonical([annotation.subtype, annotation.contents, annotation.page, annotation.region]);
}

function detectAnnotationChanges(state, before, after) {
  const beforeKeys = new Set(before.annotations.map(annotationKey));
  let detected = 0;
  for (const annotation of after.annotations) {
    if (beforeKeys.has(annotationKey(annotation))) continue;
    addEvent(state, "minor", `Annotation added: ${annotation.contents ?? annotation.subtype}.`, [makeFacet(
      state,
      "annotation",
      "added",
      null,
      [after, annotation.page, annotation.region, annotation.contents_sha256, annotation],
    )], "report");
    detected += 1;
  }
  return detected;
}

function detectMetadataChanges(state, before, after) {
  let detected = 0;
  for (const key of Object.keys(before.metadata).sort()) {
    if (before.metadata[key] === after.metadata[key]) continue;
    const isVolatile = key === "ModDate" || key === "CreationDate" || key === "Producer" || key === "Creator";
    addEvent(state, isVolatile ? "noise" : "minor", `${key} metadata changes.`, [makeFacet(
      state,
      "metadata",
      "modified",
      [before, 1, pageBox(before.pages[0]), digest(String(before.metadata[key] ?? "")), { key, value: before.metadata[key] }],
      [after, 1, pageBox(after.pages[0]), digest(String(after.metadata[key] ?? "")), { key, value: after.metadata[key] }],
    )], "suppress");
    detected += 1;
  }
  return detected;
}

function detectResidualVisualChanges(state, before, after, pages, renderer, contentChanges) {
  if (contentChanges > 0) return 0;
  let detected = 0;
  for (const page of pages) {
    const difference = diffComparisonRgba(page.beforeRender, page.afterRender, renderer);
    if (difference.dimension_mismatch || difference.changed_pixels === 0) continue;
    const layoutNoise = page.beforePage.text === page.afterPage.text && difference.components.length > 3;
    const region = layoutNoise ? pageBox(page.beforePage) : difference.bounds;
    const beforeCrop = cropComparisonRgba(page.beforeRender, region, renderer);
    const afterCrop = cropComparisonRgba(page.afterRender, region, renderer);
    addEvent(state, layoutNoise ? "noise" : "minor",
      layoutNoise ? "Layout changes while normalized text remains equal."
        : "Rendered appearance changes while extracted text remains equal.", [makeFacet(
        state,
        "visual",
        "modified",
        [before, page.alignment.before_page, region, beforeCrop.rgba_sha256, beforeCrop.rgba],
        [after, page.alignment.after_page, region, afterCrop.rgba_sha256, afterCrop.rgba],
      )], layoutNoise ? "suppress" : "report");
    detected += 1;
  }
  return detected;
}

async function inspectPair(beforePath, afterPath, renderer) {
  const [before, after] = await Promise.all([
    inspectComparisonDocument(beforePath, renderer),
    inspectComparisonDocument(afterPath, renderer),
  ]);
  return { before, after };
}

export async function buildSharedLibraryPairReport({ pairId, beforePath, afterPath, renderer }) {
  const timingSamples = [];
  const iterationCosts = [];
  let warmupMs = 0;
  let warmupCost;
  let inspected;
  let peakRss = process.memoryUsage().rss;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const started = performance.now();
    const candidate = await inspectPair(beforePath, afterPath, renderer);
    const elapsed = performance.now() - started;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const candidateCost = {
      tool_calls: 0,
      logical_input_bytes: candidate.before.size + candidate.after.size,
      rendered_pixels: [...candidate.before.renders, ...candidate.after.renders]
        .reduce((sum, render) => sum + render.width * render.height, 0),
      peak_rss_bytes: peakRss,
    };
    if (iteration === 0) {
      inspected = candidate;
      warmupMs = elapsed;
      warmupCost = candidateCost;
    } else {
      timingSamples.push(elapsed);
      iterationCosts.push(candidateCost);
    }
  }
  const { before, after } = inspected;
  return buildComparisonPairFromInspections({
    pairId,
    before,
    after,
    renderer,
    timingSamples,
    warmupMs,
    warmupCost,
    iterationCosts,
    peakRss,
    resourceMeasurementStatus: "in_process",
    capture: "deterministic_baseline",
    channelStatus: Object.fromEntries(COMPARISON_CHANNELS.map(channel => [channel, "supported"])),
  });
}

export function buildComparisonPairFromInspections({
  pairId,
  before,
  after,
  renderer,
  timingSamples,
  warmupMs,
  warmupCost,
  iterationCosts,
  peakRss,
  resourceMeasurementStatus,
  capture,
  channelStatus,
}) {
  const alignments = deriveAlignments(before, after);
  const pages = alignedPages(before, after, alignments);
  const state = {
    pairId,
    observationSequence: 1,
    eventSequence: 1,
    observations: [],
    detectedEvents: [],
    presentationDecisions: [],
    controllerRecords: [],
    capture,
  };
  const textChanges = detectTextChanges(state, before, after, pages, renderer);
  const structureChanges = detectStructureChange(state, before, after, alignments);
  const fieldChanges = detectFieldChanges(state, before, after, renderer);
  const annotationChanges = detectAnnotationChanges(state, before, after);
  const metadataChanges = detectMetadataChanges(state, before, after);
  detectResidualVisualChanges(
    state,
    before,
    after,
    pages,
    renderer,
    textChanges + structureChanges + fieldChanges + annotationChanges + metadataChanges,
  );
  return { pairReport: {
    pair_id: pairId,
    before_sha256: before.sha256,
    after_sha256: after.sha256,
    status: "completed",
    channel_status: channelStatus,
    alignments,
    observations: state.observations,
    detected_events: state.detectedEvents,
    presentation_decisions: state.presentationDecisions,
    timing_samples_ms: timingSamples,
    warmup_ms: warmupMs,
    warmup_cost: warmupCost,
    iteration_costs: iterationCosts,
    peak_rss_bytes: peakRss,
    resource_measurement_status: resourceMeasurementStatus,
    rendered_pixels: warmupCost.rendered_pixels
      + iterationCosts.reduce((sum, cost) => sum + cost.rendered_pixels, 0),
    tool_calls: warmupCost.tool_calls + iterationCosts.reduce((sum, cost) => sum + cost.tool_calls, 0),
    logical_input_bytes: warmupCost.logical_input_bytes
      + iterationCosts.reduce((sum, cost) => sum + cost.logical_input_bytes, 0),
    source_immutable: true,
    undeclared_requests: [],
    model_transport_requests: 0,
  }, controllerRecords: state.controllerRecords };
}

export async function buildSharedLibraryReferenceReport({
  benchmarkId,
  benchmarkVersion,
  renderer,
  pairs,
}) {
  const pairReports = [];
  const controllerRecords = [];
  for (const pair of pairs) {
    const built = await buildSharedLibraryPairReport({ ...pair, renderer });
    pairReports.push(built.pairReport);
    controllerRecords.push(...built.controllerRecords);
  }
  const report = {
    report_schema_version: 1,
    benchmark_id: benchmarkId,
    benchmark_version: benchmarkVersion,
    mode: "default_material",
    claim_boundary: "Shared pdf-lib/PDF.js/canvas dependencies on the seven public synthetic v1 pairs; not independent confirmation or general product evidence.",
    benchmark_claim_ready: false,
    engine: {
      id: "pdf-tools-shared-library-reference",
      kind: "shared_library",
      version: "1",
      license: "MIT and Apache-2.0 dependency licenses",
      provenance: "pdf-lib 1.17.1; pdfjs-dist 5.4.624; @napi-rs/canvas 0.1.99",
      bundle_increment_bytes: 0,
      native_targets: [`${process.platform}-${process.arch}`],
      network_requests: 0,
      external_processes: 0,
      renderer_fingerprint_sha256: rendererFingerprint(renderer),
    },
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      host: "silvercloud-vm",
      model: "none",
      model_cost_usd: 0,
    },
    isolation: {
      truth_manifest_visible: true,
      shell_access: true,
      sut_network: "not_enforced",
      model_endpoint: null,
      allowed_directory_evidence_sha256: digest(pairs.flatMap(pair => [pair.beforeSha256, pair.afterSha256]).sort()),
    },
    pairs: pairReports,
  };
  return registerControllerObservationRecords(report, controllerRecords);
}
