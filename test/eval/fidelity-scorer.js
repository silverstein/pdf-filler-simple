import { createHash } from "node:crypto";
import { FIDELITY_GATES } from "./fidelity-manifest.js";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equal(left, right) {
  return canonical(left) === canonical(right);
}

function normalizeRegion(region) {
  return region?.map(value => Math.round(value * 100) / 100) ?? null;
}

function result(passed, reasons = [], evidence = {}) {
  return { status: passed ? "pass" : "fail", reasons, evidence };
}

function expectedPageCount(caseDefinition, outputPath) {
  return caseDefinition.page_lineage.filter(lineage => lineage.output_path === outputPath).length;
}

function evaluateTools(caseDefinition, cell) {
  const reasons = [];
  if (!Array.isArray(cell.tool_calls) || cell.tool_calls.length !== caseDefinition.tool_calls.length) {
    reasons.push("tool call denominator differs from manifest");
  } else {
    for (const [index, expected] of caseDefinition.tool_calls.entries()) {
      const observed = cell.tool_calls[index];
      if (observed.name !== expected.name) reasons.push(`call ${index + 1} used ${observed.name} instead of ${expected.name}`);
      const expectedArgumentsSha256 = createHash("sha256").update(JSON.stringify(expected.arguments)).digest("hex");
      if (observed.arguments_sha256 !== expectedArgumentsSha256) reasons.push(`call ${index + 1} arguments are not bound to the manifest`);
      if (observed.is_error !== (expected.expect_error === true)) reasons.push(`call ${index + 1} error disposition differed from contract`);
    }
  }
  return result(reasons.length === 0, reasons, { calls: cell.tool_calls?.length ?? 0 });
}

function evaluateArtifacts(manifest, caseDefinition, cell) {
  const reasons = [];
  const documentById = new Map(manifest.documents.map(document => [document.id, document]));
  for (const input of caseDefinition.inputs) {
    if (cell.sources?.[input.logical_path]?.sha256 !== documentById.get(input.document_id)?.sha256) {
      reasons.push(`${input.logical_path} does not match its manifest-bound source SHA-256`);
    }
  }
  for (const outputPath of caseDefinition.expected_outputs) {
    const output = cell.outputs?.[outputPath];
    if (!output?.exists) reasons.push(`${outputPath} is missing`);
    else if (!output.inspection?.sha256 || !(output.inspection.size > 0)) reasons.push(`${outputPath} is empty or unbound`);
  }
  return result(reasons.length === 0, reasons, { expected_outputs: caseDefinition.expected_outputs.length });
}

function evaluatePdfjs(caseDefinition, cell) {
  const reasons = [];
  for (const outputPath of caseDefinition.expected_outputs) {
    const inspection = cell.outputs?.[outputPath]?.inspection;
    if (!inspection) reasons.push(`${outputPath} was not opened by PDF.js/pdf-lib lane`);
    else if (inspection.page_count !== expectedPageCount(caseDefinition, outputPath)) reasons.push(`${outputPath} PDF.js page count differs from lineage`);
    else if ((inspection.renders ?? []).length !== inspection.page_count) reasons.push(`${outputPath} PDF.js did not render every page`);
  }
  return result(reasons.length === 0, reasons);
}

function evaluatePoppler(caseDefinition, cell) {
  const reasons = [];
  if (cell.engines?.poppler?.family !== "poppler" || cell.engines?.poppler?.available !== true) {
    reasons.push("independent Poppler engine is unavailable or misidentified");
  }
  for (const outputPath of caseDefinition.expected_outputs) {
    const observed = cell.outputs?.[outputPath]?.poppler;
    const expectedPages = expectedPageCount(caseDefinition, outputPath);
    if (!observed?.opened) reasons.push(`${outputPath} was not opened by Poppler`);
    else if (observed.page_count !== expectedPages) reasons.push(`${outputPath} Poppler page count differs from lineage`);
    else if (observed.render_count !== expectedPages) reasons.push(`${outputPath} Poppler did not render every page`);
  }
  return result(reasons.length === 0, reasons);
}

function evaluateLineage(caseDefinition, cell) {
  const reasons = [];
  for (const lineage of caseDefinition.page_lineage) {
    const page = cell.outputs?.[lineage.output_path]?.inspection?.pages?.[lineage.output_page - 1];
    if (!page) reasons.push(`${lineage.output_path} page ${lineage.output_page} is absent`);
    else if (!(page.text ?? "").includes(lineage.anchor)) reasons.push(`${lineage.output_path} page ${lineage.output_page} does not contain anchor ${lineage.anchor}`);
  }
  return result(reasons.length === 0, reasons);
}

function evaluateGeometry(caseDefinition, cell) {
  const reasons = [];
  for (const lineage of caseDefinition.page_lineage) {
    const source = cell.sources?.[lineage.source_path]?.pages?.[lineage.source_page - 1];
    const output = cell.outputs?.[lineage.output_path]?.inspection?.pages?.[lineage.output_page - 1];
    if (!source || !output) continue;
    const expectedRotation = (source.rotation + lineage.rotation_delta) % 360;
    if (!equal(source.media_box, output.media_box)) reasons.push(`${lineage.output_path} page ${lineage.output_page} MediaBox drifted`);
    if (!equal(source.crop_box, output.crop_box)) reasons.push(`${lineage.output_path} page ${lineage.output_page} CropBox drifted`);
    if (output.rotation !== expectedRotation) reasons.push(`${lineage.output_path} page ${lineage.output_page} rotation is ${output.rotation}, expected ${expectedRotation}`);
  }
  return result(reasons.length === 0, reasons);
}

function observedFields(inspection) {
  return (inspection?.fields ?? []).map(field => {
    const widget = field.widgets?.[0] ?? {};
    return {
      name: field.name,
      type: field.type,
      flags: field.flags,
      value: field.value,
      page: widget.pages?.length === 1 ? widget.pages[0] : null,
      region: normalizeRegion(widget.region),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function observedAnnotations(inspection) {
  return (inspection?.annotations ?? []).map(annotation => ({
    page: annotation.page,
    subtype: annotation.subtype,
    contents: annotation.contents,
    region: normalizeRegion(annotation.region),
  })).sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function evaluateSemantics(caseDefinition, cell) {
  const reasons = [];
  for (const expected of caseDefinition.semantics) {
    const inspection = cell.outputs?.[expected.output_path]?.inspection;
    if (!inspection) continue;
    const fields = observedFields(inspection);
    const expectedFields = expected.fields.map(field => ({ ...field, region: normalizeRegion(field.region) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!equal(fields, expectedFields)) reasons.push(`${expected.output_path} field inventory differs from contract`);
    if (!equal(observedAnnotations(inspection), expected.annotations)) reasons.push(`${expected.output_path} non-widget annotation inventory differs from contract`);
    if (inspection.widget_consistency?.passed !== true) reasons.push(`${expected.output_path} has orphan, missing, duplicated, or off-page widgets`);
    const sourceMetadata = cell.sources?.[expected.metadata.preserve_from]?.metadata;
    if (!sourceMetadata) reasons.push(`${expected.output_path} metadata source is unavailable`);
    else {
      for (const key of expected.metadata.preserve_keys) {
        if (!equal(inspection.metadata?.[key], sourceMetadata[key])) reasons.push(`${expected.output_path} metadata ${key} was not preserved`);
      }
      for (const [key, pattern] of Object.entries(expected.metadata.required_patterns)) {
        if (!(new RegExp(pattern).test(inspection.metadata?.[key] ?? ""))) reasons.push(`${expected.output_path} metadata ${key} lacks required audit pattern`);
      }
    }
  }
  return result(reasons.length === 0, reasons);
}

function evaluateVisual(caseDefinition, cell, kind) {
  const reasons = [];
  const requiredRegions = caseDefinition.intended_regions.filter(region => region.required_visible_delta);
  const expectedKeys = caseDefinition.page_lineage.flatMap(lineage => ["pdfjs", "poppler"].map(engine =>
    `${engine}|${lineage.output_path}|${lineage.output_page}|${lineage.source_path}|${lineage.source_page}|${lineage.rotation_delta}`));
  const observedKeys = (cell.visual_comparisons ?? []).map(comparison =>
    `${comparison.engine}|${comparison.output_path}|${comparison.output_page}|${comparison.source_path}|${comparison.source_page}|${comparison.rotation_delta}`);
  if (new Set(observedKeys).size !== observedKeys.length) reasons.push("visual comparison denominator contains duplicates");
  for (const key of expectedKeys) {
    if (!observedKeys.includes(key)) reasons.push(`visual comparison denominator is missing ${key}`);
  }
  for (const key of observedKeys) {
    if (!expectedKeys.includes(key)) reasons.push(`visual comparison denominator contains unplanned ${key}`);
  }
  for (const comparison of cell.visual_comparisons ?? []) {
    if (!comparison.metrics) reasons.push(`${comparison.engine} ${comparison.output_path} page ${comparison.output_page} lacks visual evidence`);
    else if (comparison.metrics.dimension_mismatch) reasons.push(`${comparison.engine} ${comparison.output_path} page ${comparison.output_page} dimensions differ`);
    if (kind === "forbidden" && comparison.metrics?.outside_counts?.[8] !== 0) {
      reasons.push(`${comparison.engine} ${comparison.output_path} page ${comparison.output_page} has ${comparison.metrics.outside_counts[8]} unexpected pixels above delta 8`);
    }
  }
  if (kind === "intended") {
    for (const region of requiredRegions) {
      for (const engine of ["pdfjs", "poppler"]) {
        const comparisons = (cell.visual_comparisons ?? []).filter(item => item.engine === engine
          && item.output_path === region.output_path && item.output_page === region.page);
        if (comparisons.length !== 1) reasons.push(`${engine} intended region ${region.output_path} page ${region.page} has incomplete evidence`);
        else if (!(comparisons[0].metrics?.inside_counts?.[8] > 0)) reasons.push(`${engine} intended region ${region.output_path} page ${region.page} has no visible delta above 8`);
      }
    }
  }
  return result(reasons.length === 0, reasons);
}

function evaluateFilesystem(caseDefinition, cell) {
  const reasons = [];
  const diff = cell.filesystem?.diff ?? { created: [], modified: [], deleted: [] };
  const expected = caseDefinition.filesystem;
  const patterns = expected.dynamic_created_patterns.map(pattern => new RegExp(pattern));
  const dynamicCreated = diff.created.filter(item => patterns.some(pattern => pattern.test(item)));
  const staticCreated = diff.created.filter(item => !patterns.some(pattern => pattern.test(item)));
  if (!equal(staticCreated.sort(), [...expected.created, ...expected.created_directories].sort())) reasons.push("created filesystem set differs from contract");
  if (patterns.some(pattern => !dynamicCreated.some(item => pattern.test(item)))) reasons.push("required dynamic filesystem creation is missing");
  if (!equal(diff.modified.sort(), [...expected.modified].sort())) reasons.push("modified filesystem set differs from contract");
  if (!equal(diff.deleted.sort(), [...expected.deleted].sort())) reasons.push("deleted filesystem set differs from contract");
  const forbidden = (cell.filesystem?.after ?? []).filter(entry => ["symlink", "socket", "fifo", "character", "block", "unknown"].includes(entry.type)
    || /(^|\/)(?:\.tmp|tmp-|.*\.tmp(?:-|$)|.*\.partial(?:-|$))/i.test(entry.path));
  if (forbidden.length) reasons.push("filesystem contains temporary or unsupported nodes");
  return result(reasons.length === 0, reasons, { diff });
}

function evaluateLifecycle(caseDefinition, cell) {
  const active = cell.lifecycle?.active;
  const reasons = [];
  if (!active || active.active_path !== caseDefinition.lifecycle.active_path) reasons.push("active document path differs from contract");
  if (!active || active.last_mutation_tool !== caseDefinition.lifecycle.last_mutation_tool) reasons.push("last mutation tool differs from contract");
  return result(reasons.length === 0, reasons);
}

function evaluateBackup(caseDefinition, cell) {
  const policy = caseDefinition.lifecycle.backup_policy;
  const backup = cell.backup ?? {};
  const reasons = [];
  if (policy === "immutable-original") {
    if (!backup.first_path || backup.first_path !== backup.final_path) reasons.push("original backup path was not retained");
    if (!backup.original_sha256 || backup.first_sha256 !== backup.original_sha256 || backup.final_sha256 !== backup.original_sha256) reasons.push("original backup bytes were not immutable H0");
    if (backup.created_paths?.length !== 1) reasons.push("same-path mutations did not use exactly one backup");
  } else if (policy === "missing-original-fail-closed") {
    if (backup.second_call_error !== true) reasons.push("mutation did not fail after the recorded original backup disappeared");
    if (backup.hash_before_second !== backup.hash_after_second) reasons.push("working PDF changed after missing-backup failure");
    if ((backup.created_paths_after_fault ?? []).length !== 0) reasons.push("a replacement backup was manufactured from mutated state");
  }
  return result(reasons.length === 0, reasons);
}

export function evaluateFidelityCell(manifest, caseDefinition, cell) {
  const gates = {
    tool_execution: evaluateTools(caseDefinition, cell),
    artifact: evaluateArtifacts(manifest, caseDefinition, cell),
    pdfjs_engine: evaluatePdfjs(caseDefinition, cell),
    poppler_engine: evaluatePoppler(caseDefinition, cell),
    lineage: evaluateLineage(caseDefinition, cell),
    geometry: evaluateGeometry(caseDefinition, cell),
    semantics: evaluateSemantics(caseDefinition, cell),
    intended_visual: evaluateVisual(caseDefinition, cell, "intended"),
    forbidden_visual: evaluateVisual(caseDefinition, cell, "forbidden"),
    filesystem: evaluateFilesystem(caseDefinition, cell),
    lifecycle: evaluateLifecycle(caseDefinition, cell),
    backup: evaluateBackup(caseDefinition, cell),
  };
  const passed = caseDefinition.required_gates.every(gate => gates[gate]?.status === "pass");
  return { case_id: caseDefinition.id, repetition: cell.repetition, passed, gates };
}

export function scoreFidelityReport(manifest, report) {
  const errors = [];
  if (report?.schema_version !== 1) errors.push("report.schema_version must be 1");
  if (report?.benchmark_id !== manifest.benchmark_id || report?.benchmark_version !== manifest.benchmark_version) errors.push("report benchmark binding differs from manifest");
  if (report?.failure_evidence_integrity !== true) errors.push("report failure evidence was not hash-verified");
  const expected = manifest.cases.flatMap(item => Array.from({ length: manifest.measurement_policy.repetitions }, (_, index) => `${item.id}#${index + 1}`));
  const cells = Array.isArray(report?.cells) ? report.cells : [];
  const actual = cells.map(cell => `${cell.case_id}#${cell.repetition}`);
  if (new Set(actual).size !== actual.length) errors.push("report contains duplicate case/repetition cells");
  for (const key of expected) if (!actual.includes(key)) errors.push(`report is missing planned cell ${key}`);
  for (const key of actual) if (!expected.includes(key)) errors.push(`report contains unplanned cell ${key}`);
  const caseById = new Map(manifest.cases.map(item => [item.id, item]));
  const results = cells.filter(cell => caseById.has(cell.case_id))
    .map(cell => evaluateFidelityCell(manifest, caseById.get(cell.case_id), cell));
  const requiredFailures = results.flatMap(item => Object.entries(item.gates)
    .filter(([gate, gateResult]) => caseById.get(item.case_id).required_gates.includes(gate) && gateResult.status !== "pass")
    .map(([gate, gateResult]) => ({ case_id: item.case_id, repetition: item.repetition, gate, reasons: gateResult.reasons })));
  return {
    schema_version: 1,
    benchmark_id: manifest.benchmark_id,
    benchmark_version: manifest.benchmark_version,
    valid: errors.length === 0,
    passed: errors.length === 0 && results.length === expected.length && requiredFailures.length === 0,
    denominator: { planned: expected.length, observed: cells.length, unique: new Set(actual).size },
    validation_errors: errors,
    results,
    required_failures: requiredFailures,
    gate_ids: [...FIDELITY_GATES],
    scoring_policy: "conjunction-only; no averaging",
  };
}
