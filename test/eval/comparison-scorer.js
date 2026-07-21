import { createHash } from "node:crypto";
import { COMPARISON_CHANNELS } from "./comparison-manifest.js";

const SHA256 = /^[a-f0-9]{64}$/;
const CHANNELS = new Set(COMPARISON_CHANNELS);
const OPERATIONS = new Set(["added", "removed", "modified", "moved"]);
const STATUSES = new Set(["completed", "engine_unavailable", "harness_failure"]);
const CHANNEL_STATUSES = new Set(["supported", "unavailable", "harness_failure"]);
const DISPOSITIONS = new Set(["report", "suppress", "report_on_request"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function exactKeys(value, required, optional, location, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length) errors.push(`${location} missing keys: ${missing.join(", ")}`);
  if (unknown.length) errors.push(`${location} unknown keys: ${unknown.join(", ")}`);
  return missing.length === 0 && unknown.length === 0;
}

function validateRegion(value, location, errors) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
    || value[2] <= 0 || value[3] <= 0) {
    errors.push(`${location} must be [x, y, positive width, positive height]`);
  }
}

function validateAlignment(value, location, errors) {
  if (!exactKeys(value, ["before_page", "after_page", "relation", "anchor"], ["ambiguity_group"], location, errors)) return;
  for (const key of ["before_page", "after_page"]) {
    if (value[key] !== null && (!Number.isInteger(value[key]) || value[key] < 1)) errors.push(`${location}.${key} is invalid`);
  }
  if (!new Set(["same", "moved", "inserted", "deleted"]).has(value.relation)) errors.push(`${location}.relation is invalid`);
  if (typeof value.anchor !== "string" || value.anchor.length === 0) errors.push(`${location}.anchor must be non-empty`);
  if (Object.hasOwn(value, "ambiguity_group")
    && value.ambiguity_group !== null && (typeof value.ambiguity_group !== "string" || !value.ambiguity_group)) {
    errors.push(`${location}.ambiguity_group must be null or non-empty`);
  }
}

function validateObservation(value, location, allowedHashes, observationIds, errors) {
  if (!exactKeys(value, [
    "id", "channel", "document_sha256", "page", "page_box", "rotation", "region",
    "value_sha256", "raw_result_sha256", "capture",
  ], [], location, errors)) return;
  if (!/^evidence\.[a-z0-9.-]+$/.test(value.id ?? "")) errors.push(`${location}.id is invalid`);
  if (observationIds.has(value.id)) errors.push(`${location}.id is duplicated`);
  observationIds.add(value.id);
  if (!CHANNELS.has(value.channel)) errors.push(`${location}.channel is unsupported`);
  if (!allowedHashes.has(value.document_sha256)) errors.push(`${location}.document_sha256 is not one of the exact pair inputs`);
  if (!Number.isInteger(value.page) || value.page < 1) errors.push(`${location}.page must be positive`);
  if (canonical(value.page_box) !== canonical([0, 0, 612, 792])) errors.push(`${location}.page_box is invalid`);
  if (![0, 90, 180, 270].includes(value.rotation)) errors.push(`${location}.rotation is invalid`);
  validateRegion(value.region, `${location}.region`, errors);
  if (!SHA256.test(value.value_sha256 ?? "")) errors.push(`${location}.value_sha256 is invalid`);
  if (!SHA256.test(value.raw_result_sha256 ?? "")) errors.push(`${location}.raw_result_sha256 is invalid`);
  if (!new Set(["retained_tool_result", "deterministic_baseline", "oracle_calibration"]).has(value.capture)) {
    errors.push(`${location}.capture is unsupported`);
  }
}

function validateDetectedEvent(value, location, truthIds, observationIds, eventIds, errors) {
  if (!exactKeys(value, ["id", "salience", "confidence", "summary", "facets"], [], location, errors)) return;
  if (!/^candidate\.[a-z0-9.-]+$/.test(value.id ?? "")) errors.push(`${location}.id is invalid`);
  if (truthIds.has(value.id)) errors.push(`${location}.id must not equal a truth event ID`);
  if (eventIds.has(value.id)) errors.push(`${location}.id is duplicated`);
  eventIds.add(value.id);
  if (!new Set(["material", "minor", "noise", "unknown"]).has(value.salience)) errors.push(`${location}.salience is invalid`);
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push(`${location}.confidence must be between 0 and 1`);
  if (typeof value.summary !== "string" || !value.summary) errors.push(`${location}.summary must be non-empty`);
  if (!Array.isArray(value.facets) || value.facets.length === 0) {
    errors.push(`${location}.facets must be non-empty`);
    return;
  }
  const facetChannels = new Set();
  for (const [index, facet] of value.facets.entries()) {
    const facetLocation = `${location}.facets[${index}]`;
    if (!exactKeys(facet, ["channel", "operation", "before_evidence_id", "after_evidence_id"], [], facetLocation, errors)) continue;
    if (!CHANNELS.has(facet.channel)) errors.push(`${facetLocation}.channel is unsupported`);
    if (facetChannels.has(facet.channel)) errors.push(`${facetLocation}.channel is duplicated`);
    facetChannels.add(facet.channel);
    if (!OPERATIONS.has(facet.operation)) errors.push(`${facetLocation}.operation is unsupported`);
    for (const key of ["before_evidence_id", "after_evidence_id"]) {
      const id = facet[key];
      if (id !== null && !observationIds.has(id)) errors.push(`${facetLocation}.${key} references unknown evidence`);
    }
    if (facet.operation === "added" && facet.before_evidence_id !== null) errors.push(`${facetLocation}.before_evidence_id must be null for added`);
    if (facet.operation === "removed" && facet.after_evidence_id !== null) errors.push(`${facetLocation}.after_evidence_id must be null for removed`);
    if (["modified", "moved"].includes(facet.operation)
      && (facet.before_evidence_id === null || facet.after_evidence_id === null)) {
      errors.push(`${facetLocation} ${facet.operation} requires evidence on both sides`);
    }
  }
}

function validatePairReport(pairReport, truthPair, truthIds, errors, location) {
  if (!exactKeys(pairReport, [
    "pair_id", "before_sha256", "after_sha256", "status", "channel_status",
    "alignments", "observations", "detected_events", "presentation_decisions",
    "timing_samples_ms", "peak_rss_bytes", "rendered_pixels", "tool_calls", "bytes_read",
    "source_immutable", "undeclared_requests", "model_transport_requests",
  ], [], location, errors)) return;
  if (!truthPair) {
    errors.push(`${location}.pair_id is unknown`);
    return;
  }
  if (pairReport.before_sha256 !== truthPair.before.sha256) errors.push(`${location}.before_sha256 does not bind the truth input`);
  if (pairReport.after_sha256 !== truthPair.after.sha256) errors.push(`${location}.after_sha256 does not bind the truth input`);
  if (!STATUSES.has(pairReport.status)) errors.push(`${location}.status is unsupported`);
  if (!exactKeys(pairReport.channel_status, COMPARISON_CHANNELS, [], `${location}.channel_status`, errors)) return;
  for (const channel of COMPARISON_CHANNELS) {
    if (!CHANNEL_STATUSES.has(pairReport.channel_status[channel])) errors.push(`${location}.channel_status.${channel} is unsupported`);
  }
  if (!Array.isArray(pairReport.alignments)) errors.push(`${location}.alignments must be an array`);
  else pairReport.alignments.forEach((alignment, index) => validateAlignment(alignment, `${location}.alignments[${index}]`, errors));
  const observationIds = new Set();
  const allowedHashes = new Set([truthPair.before.sha256, truthPair.after.sha256]);
  if (!Array.isArray(pairReport.observations)) errors.push(`${location}.observations must be an array`);
  else pairReport.observations.forEach((observation, index) =>
    validateObservation(observation, `${location}.observations[${index}]`, allowedHashes, observationIds, errors));
  const eventIds = new Set();
  if (!Array.isArray(pairReport.detected_events)) errors.push(`${location}.detected_events must be an array`);
  else pairReport.detected_events.forEach((event, index) =>
    validateDetectedEvent(event, `${location}.detected_events[${index}]`, truthIds, observationIds, eventIds, errors));
  if (!Array.isArray(pairReport.presentation_decisions)) errors.push(`${location}.presentation_decisions must be an array`);
  else {
    const decided = new Set();
    for (const [index, decision] of pairReport.presentation_decisions.entries()) {
      const decisionLocation = `${location}.presentation_decisions[${index}]`;
      if (!exactKeys(decision, ["event_id", "mode", "disposition", "rationale"], [], decisionLocation, errors)) continue;
      if (!eventIds.has(decision.event_id)) errors.push(`${decisionLocation}.event_id references unknown candidate event`);
      if (decided.has(decision.event_id)) errors.push(`${decisionLocation}.event_id is duplicated`);
      decided.add(decision.event_id);
      if (!new Set(["default_material", "forensic"]).has(decision.mode)) errors.push(`${decisionLocation}.mode is invalid`);
      if (!DISPOSITIONS.has(decision.disposition)) errors.push(`${decisionLocation}.disposition is invalid`);
      if (typeof decision.rationale !== "string" || !decision.rationale) errors.push(`${decisionLocation}.rationale must be non-empty`);
    }
  }
  if (!Array.isArray(pairReport.timing_samples_ms) || pairReport.timing_samples_ms.length !== 5
    || pairReport.timing_samples_ms.some(value => !Number.isFinite(value) || value < 0)) {
    errors.push(`${location}.timing_samples_ms must contain five nonnegative measurements`);
  }
  for (const key of ["peak_rss_bytes", "rendered_pixels", "tool_calls", "bytes_read", "model_transport_requests"]) {
    if (!Number.isInteger(pairReport[key]) || pairReport[key] < 0) errors.push(`${location}.${key} must be a nonnegative integer`);
  }
  if (typeof pairReport.source_immutable !== "boolean") errors.push(`${location}.source_immutable must be boolean`);
  if (!Array.isArray(pairReport.undeclared_requests)
    || pairReport.undeclared_requests.some(value => typeof value !== "string" || !value)) {
    errors.push(`${location}.undeclared_requests must contain strings`);
  }
}

export function validateComparisonReport(manifest, report) {
  const errors = [];
  if (!exactKeys(report, [
    "report_schema_version", "benchmark_id", "benchmark_version", "mode", "claim_boundary",
    "benchmark_claim_ready", "engine", "platform", "isolation", "pairs",
  ], [], "report", errors)) return errors;
  if (report.report_schema_version !== 1) errors.push("report.report_schema_version must equal 1");
  if (report.benchmark_id !== manifest.benchmark_id) errors.push("report.benchmark_id does not match manifest");
  if (report.benchmark_version !== manifest.benchmark_version) errors.push("report.benchmark_version does not match manifest");
  if (!new Set(["default_material", "forensic"]).has(report.mode)) errors.push("report.mode is unsupported");
  if (typeof report.claim_boundary !== "string" || !report.claim_boundary) errors.push("report.claim_boundary must be non-empty");
  if (report.benchmark_claim_ready !== false) errors.push("report.benchmark_claim_ready must remain false");
  if (exactKeys(report.engine, [
    "id", "kind", "version", "license", "provenance", "bundle_increment_bytes",
    "native_targets", "network_requests", "external_processes",
  ], [], "report.engine", errors)) {
    if (!new Set(["pdf_tools_mcp", "shared_library", "external_cli", "oracle_calibration"]).has(report.engine.kind)) errors.push("report.engine.kind is unsupported");
    for (const key of ["id", "version", "license", "provenance"]) {
      if (typeof report.engine[key] !== "string" || !report.engine[key]) errors.push(`report.engine.${key} must be non-empty`);
    }
    if (!Number.isInteger(report.engine.bundle_increment_bytes) || report.engine.bundle_increment_bytes < 0) errors.push("report.engine.bundle_increment_bytes is invalid");
    for (const key of ["network_requests", "external_processes"]) {
      if (!Number.isInteger(report.engine[key]) || report.engine[key] < 0) errors.push(`report.engine.${key} is invalid`);
    }
    if (!Array.isArray(report.engine.native_targets)
      || report.engine.native_targets.some(value => typeof value !== "string" || !value)
      || new Set(report.engine.native_targets).size !== report.engine.native_targets.length) {
      errors.push("report.engine.native_targets must contain unique non-empty strings");
    }
  }
  if (exactKeys(report.platform, ["os", "arch", "node", "host", "model", "model_cost_usd"], [], "report.platform", errors)) {
    for (const key of ["os", "arch", "node", "host", "model"]) {
      if (typeof report.platform[key] !== "string" || !report.platform[key]) errors.push(`report.platform.${key} must be non-empty`);
    }
    if (!Number.isFinite(report.platform.model_cost_usd) || report.platform.model_cost_usd < 0) {
      errors.push("report.platform.model_cost_usd must be a nonnegative finite number");
    }
  }
  if (exactKeys(report.isolation, [
    "truth_manifest_visible", "shell_access", "sut_network", "model_endpoint", "allowed_directory_evidence_sha256",
  ], [], "report.isolation", errors)) {
    if (report.isolation.truth_manifest_visible !== false) errors.push("report.isolation.truth_manifest_visible must be false");
    if (report.isolation.shell_access !== false) errors.push("report.isolation.shell_access must be false");
    if (report.isolation.sut_network !== "denied") errors.push("report.isolation.sut_network must be denied");
    if (report.isolation.model_endpoint !== null
      && (typeof report.isolation.model_endpoint !== "string" || !report.isolation.model_endpoint)) {
      errors.push("report.isolation.model_endpoint must be null or non-empty");
    }
    if (!SHA256.test(report.isolation.allowed_directory_evidence_sha256 ?? "")) errors.push("report.isolation.allowed_directory_evidence_sha256 is invalid");
  }
  if (!Array.isArray(report.pairs)) {
    errors.push("report.pairs must be an array");
    return errors;
  }
  const documentById = new Map(manifest.documents.map(document => [document.id, document]));
  const truthPairById = new Map(manifest.pairs.map(pair => [pair.id, {
    ...pair,
    before: documentById.get(pair.before_document_id),
    after: documentById.get(pair.after_document_id),
  }]));
  const truthIds = new Set(manifest.pairs.flatMap(pair => pair.events.map(event => event.id)));
  const pairIds = new Set();
  for (const [index, pairReport] of report.pairs.entries()) {
    if (pairIds.has(pairReport?.pair_id)) errors.push(`report.pairs[${index}].pair_id is duplicated`);
    pairIds.add(pairReport?.pair_id);
    validatePairReport(pairReport, truthPairById.get(pairReport?.pair_id), truthIds, errors, `report.pairs[${index}]`);
  }
  const expectedPairIds = manifest.pairs.map(pair => pair.id).sort();
  if (canonical([...pairIds].sort()) !== canonical(expectedPairIds)) errors.push("report.pairs must cover every manifest pair exactly once");
  return errors;
}

function intersectionOverUnion(left, right) {
  const x1 = Math.max(left[0], right[0]);
  const y1 = Math.max(left[1], right[1]);
  const x2 = Math.min(left[0] + left[2], right[0] + right[2]);
  const y2 = Math.min(left[1] + left[3], right[1] + right[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left[2] * left[3] + right[2] * right[3] - intersection;
  return union === 0 ? 0 : intersection / union;
}

function assessAnchor(expected, evidenceId, observations) {
  if (expected === null) return { matched: evidenceId === null, expected: false, iou: null };
  if (evidenceId === null) return { matched: false, expected: true, iou: null };
  const actual = observations.get(evidenceId);
  const sourceBound = Boolean(actual
    && actual.document_sha256 === expected.document_sha256
    && actual.page === expected.page
    && canonical(actual.page_box) === canonical(expected.page_box)
    && actual.rotation === expected.rotation);
  const iou = sourceBound ? intersectionOverUnion(actual.region, expected.region) : null;
  return {
    matched: Boolean(sourceBound && actual.value_sha256 === expected.value_sha256 && iou >= 0.5),
    expected: true,
    iou,
  };
}

function assessFacet(expected, actual, observations) {
  const before = assessAnchor(expected.before, actual?.before_evidence_id ?? null, observations);
  const after = assessAnchor(expected.after, actual?.after_evidence_id ?? null, observations);
  return {
    before,
    after,
    matched: Boolean(actual
    && actual.channel === expected.channel
    && actual.operation === expected.operation
    && before.matched
    && after.matched),
  };
}

function eventCompatibility(truth, candidate, observations, alignmentCorrect) {
  const matchedChannels = [];
  for (const facet of truth.facets) {
    const actual = candidate.facets.find(item => item.channel === facet.channel);
    if (assessFacet(facet, actual, observations).matched) matchedChannels.push(facet.channel);
  }
  const mandatory = truth.facets.filter(facet => facet.mandatory).map(facet => facet.channel);
  const complete = alignmentCorrect && mandatory.every(channel => matchedChannels.includes(channel));
  return { complete, matchedChannels, weight: matchedChannels.length };
}

function betterAssignment(left, right) {
  if (!right) return true;
  if (left.complete !== right.complete) return left.complete > right.complete;
  if (left.weight !== right.weight) return left.weight > right.weight;
  return left.signature < right.signature;
}

function assignEvents(truthEvents, candidateEvents, observations, alignmentCorrect) {
  let best;
  function visit(index, used, assignments, complete, weight) {
    if (index === truthEvents.length) {
      const signature = assignments.map(item => item ? `${item.truthIndex}:${item.candidateIndex}` : "-").join("|");
      const result = { assignments: [...assignments], complete, weight, signature };
      if (betterAssignment(result, best)) best = result;
      return;
    }
    assignments.push(null);
    visit(index + 1, used, assignments, complete, weight);
    assignments.pop();
    for (let candidateIndex = 0; candidateIndex < candidateEvents.length; candidateIndex += 1) {
      if (used.has(candidateIndex)) continue;
      const compatibility = eventCompatibility(
        truthEvents[index], candidateEvents[candidateIndex], observations, alignmentCorrect
      );
      if (compatibility.weight === 0) continue;
      used.add(candidateIndex);
      assignments.push({ truthIndex: index, candidateIndex, ...compatibility });
      visit(index + 1, used, assignments, complete + Number(compatibility.complete), weight + compatibility.weight);
      assignments.pop();
      used.delete(candidateIndex);
    }
  }
  visit(0, new Set(), [], 0, 0);
  return best?.assignments ?? truthEvents.map(() => null);
}

function metric(tp, fp, fn) {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? (precision === 0 || recall === 0 ? 0 : null)
    : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function sampleStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.length < 2 ? null
    : samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (samples.length - 1);
  const quantile = value => sorted[Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1)];
  return { samples_ms: samples, mean_ms: mean, p50_ms: quantile(0.5), p95_ms: quantile(0.95), sample_variance: variance };
}

function scorePair(truthPair, pairReport, mode) {
  const observations = new Map(pairReport.observations.map(item => [item.id, item]));
  const expectedAlignments = truthPair.alignments.map(item => ({ ...item })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const actualAlignments = pairReport.alignments.map(({ ambiguity_group: _ignored, ...item }) => item)
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const alignmentCorrect = canonical(expectedAlignments) === canonical(actualAlignments);
  const assignments = assignEvents(truthPair.events, pairReport.detected_events, observations, alignmentCorrect);
  const assignedCandidateIndexes = new Set(assignments.filter(Boolean).map(item => item.candidateIndex));
  const channelCounts = Object.fromEntries(COMPARISON_CHANNELS.map(channel => [channel, { tp: 0, fp: 0, fn: 0 }]));
  let eventTp = 0;
  let eventFn = 0;
  let eventFp = pairReport.detected_events.length - assignedCandidateIndexes.size;
  let presentationCorrect = 0;
  let presentationTotal = 0;
  let expectedAnchors = 0;
  let matchedAnchors = 0;
  let twoSidedTotal = 0;
  let twoSidedComplete = 0;
  const matchedAnchorIous = [];
  const supportedCandidateFacets = new Set();
  const eventResults = [];

  for (const [truthIndex, truth] of truthPair.events.entries()) {
    const assignment = assignments[truthIndex];
    if (!assignment) {
      eventFn += 1;
      for (const facet of truth.facets) channelCounts[facet.channel].fn += 1;
      eventResults.push({ truth_id: truth.id, candidate_id: null, status: "missed", matched_channels: [] });
      continue;
    }
    const candidate = pairReport.detected_events[assignment.candidateIndex];
    if (assignment.complete) eventTp += 1;
    else {
      eventFn += 1;
      eventFp += 1;
    }
    for (const facet of truth.facets) {
      const candidateFacetIndex = candidate.facets.findIndex(item => item.channel === facet.channel);
      const assessment = assessFacet(facet, candidate.facets[candidateFacetIndex], observations);
      if (assessment.matched) {
        channelCounts[facet.channel].tp += 1;
        supportedCandidateFacets.add(`${assignment.candidateIndex}:${candidateFacetIndex}`);
      } else channelCounts[facet.channel].fn += 1;
      for (const anchor of [assessment.before, assessment.after]) {
        if (!anchor.expected) continue;
        expectedAnchors += 1;
        if (anchor.matched) {
          matchedAnchors += 1;
          matchedAnchorIous.push(anchor.iou);
        }
      }
      if (["modified", "moved"].includes(facet.operation)) {
        twoSidedTotal += 1;
        if (assessment.before.matched && assessment.after.matched) twoSidedComplete += 1;
      }
    }
    for (const facet of candidate.facets) {
      if (!assignment.matchedChannels.includes(facet.channel)) channelCounts[facet.channel].fp += 1;
    }
    const decision = pairReport.presentation_decisions.find(item => item.event_id === candidate.id && item.mode === mode);
    presentationTotal += 1;
    if (decision?.disposition === truth.presentation[mode]) presentationCorrect += 1;
    eventResults.push({
      truth_id: truth.id,
      candidate_id: candidate.id,
      status: assignment.complete ? "matched" : "matched_incomplete",
      matched_channels: assignment.matchedChannels,
    });
  }
  for (const [truthIndex, truth] of truthPair.events.entries()) {
    if (assignments[truthIndex]) continue;
    for (const facet of truth.facets) {
      expectedAnchors += Number(facet.before !== null) + Number(facet.after !== null);
      if (["modified", "moved"].includes(facet.operation)) twoSidedTotal += 1;
    }
  }
  for (const [index, candidate] of pairReport.detected_events.entries()) {
    if (assignedCandidateIndexes.has(index)) continue;
    for (const facet of candidate.facets) channelCounts[facet.channel].fp += 1;
  }

  const referencedObservations = new Set();
  const unsupportedEvidence = new Set();
  let unsupportedCandidateFacets = 0;
  for (const [eventIndex, candidate] of pairReport.detected_events.entries()) {
    for (const [facetIndex, facet] of candidate.facets.entries()) {
      const evidenceIds = [facet.before_evidence_id, facet.after_evidence_id].filter(Boolean);
      evidenceIds.forEach(id => referencedObservations.add(id));
      if (supportedCandidateFacets.has(`${eventIndex}:${facetIndex}`)) continue;
      unsupportedCandidateFacets += 1;
      evidenceIds.forEach(id => unsupportedEvidence.add(id));
    }
  }

  const materialEvents = truthPair.events.filter(event => event.salience === "material");
  const materialMatched = eventResults.filter(result => result.status === "matched"
    && materialEvents.some(event => event.id === result.truth_id)).length;
  const materialMandatoryFacets = materialEvents.flatMap(event => event.facets.filter(facet => facet.mandatory));
  const materialFacetMatched = eventResults.reduce((count, result) => {
    const truth = materialEvents.find(event => event.id === result.truth_id);
    return count + (truth ? truth.facets.filter(facet => facet.mandatory
      && result.matched_channels.includes(facet.channel)).length : 0);
  }, 0);
  const channelMetrics = Object.fromEntries(COMPARISON_CHANNELS.map(channel => [
    channel,
    { ...metric(channelCounts[channel].tp, channelCounts[channel].fp, channelCounts[channel].fn), status: pairReport.channel_status[channel] },
  ]));
  const identicalSpecific = truthPair.role !== "identical" || pairReport.detected_events.length === 0;
  const visualOnlyFound = truthPair.role !== "visual_only" || channelMetrics.visual.tp > 0;
  const materialRecall = materialEvents.length === 0 ? null : materialMatched / materialEvents.length;
  const materialFacetRecall = materialMandatoryFacets.length === 0 ? null : materialFacetMatched / materialMandatoryFacets.length;
  const layoutDecision = truthPair.role === "layout_noise" && eventResults[0]?.candidate_id
    ? pairReport.presentation_decisions.find(item => item.event_id === eventResults[0].candidate_id && item.mode === mode)
    : null;
  const hardGates = {
    completed: pairReport.status === "completed",
    alignment_correct: alignmentCorrect,
    source_immutable: pairReport.source_immutable,
    no_undeclared_requests: pairReport.undeclared_requests.length === 0,
    event_detection_complete: eventFn === 0 && eventFp === 0,
    material_event_recall: materialRecall === null || materialRecall === 1,
    mandatory_material_facet_recall: materialFacetRecall === null || materialFacetRecall === 1,
    evidence_complete: expectedAnchors === matchedAnchors,
    identical_specificity: identicalSpecific,
    visual_only_detected: visualOnlyFound,
    layout_noise_suppressed: truthPair.role !== "layout_noise" || mode !== "default_material"
      || layoutDecision?.disposition === "suppress",
  };
  return {
    pair_id: truthPair.id,
    role: truthPair.role,
    passed: Object.values(hardGates).every(Boolean),
    hard_gates: hardGates,
    event_metrics: metric(eventTp, eventFp, eventFn),
    channel_metrics: channelMetrics,
    alignment_accuracy: alignmentCorrect ? 1 : 0,
    material_event_recall: materialRecall,
    mandatory_material_facet_recall: materialFacetRecall,
    presentation_accuracy: presentationTotal === 0 ? null : presentationCorrect / presentationTotal,
    evidence_metrics: {
      expected_anchors: expectedAnchors,
      matched_anchors: matchedAnchors,
      completeness: expectedAnchors === 0 ? null : matchedAnchors / expectedAnchors,
      two_sided_facets: twoSidedTotal,
      two_sided_complete: twoSidedComplete,
      two_sided_citation_rate: twoSidedTotal === 0 ? null : twoSidedComplete / twoSidedTotal,
      mean_region_iou: matchedAnchorIous.length === 0 ? null
        : matchedAnchorIous.reduce((sum, value) => sum + value, 0) / matchedAnchorIous.length,
      unsupported_candidate_facets: unsupportedCandidateFacets,
      unsupported_evidence_references: unsupportedEvidence.size,
      orphan_observations: pairReport.observations.filter(item => !referencedObservations.has(item.id)).length,
    },
    event_results: eventResults,
    performance: sampleStats(pairReport.timing_samples_ms),
    cost: {
      peak_rss_bytes: pairReport.peak_rss_bytes,
      rendered_pixels: pairReport.rendered_pixels,
      tool_calls: pairReport.tool_calls,
      bytes_read: pairReport.bytes_read,
      model_transport_requests: pairReport.model_transport_requests,
    },
  };
}

function aggregateCounts(pairScores, section) {
  return pairScores.reduce((counts, score) => {
    counts.tp += score[section].tp;
    counts.fp += score[section].fp;
    counts.fn += score[section].fn;
    return counts;
  }, { tp: 0, fp: 0, fn: 0 });
}

export function scoreComparisonReport(manifest, report) {
  const validationErrors = validateComparisonReport(manifest, report);
  if (validationErrors.length) {
    return { valid: false, passed: false, validation_errors: validationErrors, benchmark_claim_ready: false };
  }
  const reportPairById = new Map(report.pairs.map(pair => [pair.pair_id, pair]));
  const pairScores = manifest.pairs.map(pair => scorePair(pair, reportPairById.get(pair.id), report.mode));
  const eventCounts = aggregateCounts(pairScores, "event_metrics");
  const channelMetrics = Object.fromEntries(COMPARISON_CHANNELS.map(channel => {
    const counts = pairScores.reduce((total, score) => {
      total.tp += score.channel_metrics[channel].tp;
      total.fp += score.channel_metrics[channel].fp;
      total.fn += score.channel_metrics[channel].fn;
      return total;
    }, { tp: 0, fp: 0, fn: 0 });
    return [channel, metric(counts.tp, counts.fp, counts.fn)];
  }));
  const materialNumerator = pairScores.reduce((sum, score) =>
    sum + (score.material_event_recall === null ? 0 : score.material_event_recall), 0);
  const materialDenominator = pairScores.filter(score => score.material_event_recall !== null).length;
  const evidenceTotals = pairScores.reduce((total, score) => {
    total.expected += score.evidence_metrics.expected_anchors;
    total.matched += score.evidence_metrics.matched_anchors;
    total.twoSided += score.evidence_metrics.two_sided_facets;
    total.twoSidedComplete += score.evidence_metrics.two_sided_complete;
    total.unsupportedFacets += score.evidence_metrics.unsupported_candidate_facets;
    total.unsupportedEvidence += score.evidence_metrics.unsupported_evidence_references;
    total.orphans += score.evidence_metrics.orphan_observations;
    return total;
  }, { expected: 0, matched: 0, twoSided: 0, twoSidedComplete: 0, unsupportedFacets: 0, unsupportedEvidence: 0, orphans: 0 });
  const result = {
    valid: true,
    passed: pairScores.every(score => score.passed),
    benchmark_id: manifest.benchmark_id,
    benchmark_version: manifest.benchmark_version,
    report_sha256: digest(report),
    benchmark_claim_ready: false,
    claim_boundary: report.claim_boundary,
    aggregate: {
      event_metrics: metric(eventCounts.tp, eventCounts.fp, eventCounts.fn),
      channel_metrics: channelMetrics,
      material_event_recall: materialDenominator === 0 ? null : materialNumerator / materialDenominator,
      evidence_metrics: {
        expected_anchors: evidenceTotals.expected,
        matched_anchors: evidenceTotals.matched,
        completeness: evidenceTotals.expected === 0 ? null : evidenceTotals.matched / evidenceTotals.expected,
        two_sided_facets: evidenceTotals.twoSided,
        two_sided_complete: evidenceTotals.twoSidedComplete,
        two_sided_citation_rate: evidenceTotals.twoSided === 0 ? null
          : evidenceTotals.twoSidedComplete / evidenceTotals.twoSided,
        unsupported_candidate_facets: evidenceTotals.unsupportedFacets,
        unsupported_evidence_references: evidenceTotals.unsupportedEvidence,
        orphan_observations: evidenceTotals.orphans,
      },
      pairs_passed: pairScores.filter(score => score.passed).length,
      pairs_total: pairScores.length,
      model_cost_usd: report.platform.model_cost_usd,
      bundle_increment_bytes: report.engine.bundle_increment_bytes,
      network_requests: report.engine.network_requests,
      external_processes: report.engine.external_processes,
    },
    pairs: pairScores,
  };
  return result;
}

function calibrationObservation(anchor, channel, id) {
  if (anchor === null) return null;
  return {
    id,
    channel,
    document_sha256: anchor.document_sha256,
    page: anchor.page,
    page_box: anchor.page_box,
    rotation: anchor.rotation,
    region: anchor.region,
    value_sha256: anchor.value_sha256,
    raw_result_sha256: digest({ anchor, channel }),
    capture: "oracle_calibration",
  };
}

export function buildOracleCalibrationReport(manifest, mode = "default_material") {
  const documentById = new Map(manifest.documents.map(document => [document.id, document]));
  return {
    report_schema_version: 1,
    benchmark_id: manifest.benchmark_id,
    benchmark_version: manifest.benchmark_version,
    mode,
    claim_boundary: "Scorer calibration generated from public truth; not product or benchmark evidence.",
    benchmark_claim_ready: false,
    engine: {
      id: "comparison-oracle-calibration",
      kind: "oracle_calibration",
      version: "1",
      license: "MIT",
      provenance: "public_truth_manifest",
      bundle_increment_bytes: 0,
      native_targets: [],
      network_requests: 0,
      external_processes: 0,
    },
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      host: "none",
      model: "none",
      model_cost_usd: 0,
    },
    isolation: {
      truth_manifest_visible: false,
      shell_access: false,
      sut_network: "denied",
      model_endpoint: null,
      allowed_directory_evidence_sha256: digest("oracle-calibration-no-sut"),
    },
    pairs: manifest.pairs.map((pair, pairIndex) => {
      const observations = [];
      const detectedEvents = pair.events.map((event, eventIndex) => ({
        id: `candidate.p${pairIndex + 1}.e${eventIndex + 1}`,
        salience: event.salience,
        confidence: 1,
        summary: event.summary,
        facets: event.facets.map((facet, facetIndex) => {
          const prefix = `evidence.p${pairIndex + 1}.e${eventIndex + 1}.f${facetIndex + 1}`;
          const before = calibrationObservation(facet.before, facet.channel, `${prefix}.before`);
          const after = calibrationObservation(facet.after, facet.channel, `${prefix}.after`);
          if (before) observations.push(before);
          if (after) observations.push(after);
          return {
            channel: facet.channel,
            operation: facet.operation,
            before_evidence_id: before?.id ?? null,
            after_evidence_id: after?.id ?? null,
          };
        }),
      }));
      return {
        pair_id: pair.id,
        before_sha256: documentById.get(pair.before_document_id).sha256,
        after_sha256: documentById.get(pair.after_document_id).sha256,
        status: "completed",
        channel_status: Object.fromEntries(COMPARISON_CHANNELS.map(channel => [channel, "supported"])),
        alignments: pair.alignments,
        observations,
        detected_events: detectedEvents,
        presentation_decisions: detectedEvents.map((event, index) => ({
          event_id: event.id,
          mode,
          disposition: pair.events[index].presentation[mode],
          rationale: "Oracle calibration mirrors the predeclared presentation contract.",
        })),
        timing_samples_ms: [0, 0, 0, 0, 0],
        peak_rss_bytes: 0,
        rendered_pixels: 0,
        tool_calls: 0,
        bytes_read: 0,
        source_immutable: true,
        undeclared_requests: [],
        model_transport_requests: 0,
      };
    }),
  };
}
