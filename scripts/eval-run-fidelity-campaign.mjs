#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, degrees } from "pdf-lib";
import { renderComparisonPage, rendererFingerprint } from "../test/eval/comparison-observations.js";
import {
  diffFidelityRgba,
  diffFilesystem,
  inspectFidelityDocument,
  popplerFingerprint,
  renderPopplerPage,
  serializableInspection,
  sha256,
  snapshotFilesystem,
} from "../test/eval/fidelity-observations.js";
import {
  loadFidelityManifest,
  producerCallIndex,
  resolveFidelityDocumentPath,
  verifyFidelityDocuments,
} from "../test/eval/fidelity-manifest.js";
import { evaluateFidelityCell, scoreFidelityReport } from "../test/eval/fidelity-scorer.js";
import {
  digestCanonical,
  digestCell,
  digestReport,
  digestRunIndex,
  prettyCanonicalJson,
} from "../test/eval/fidelity-integrity.js";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "manifest.v1.json");
const requestedOutput = process.argv[2];
if (!requestedOutput) throw new Error("Usage: node scripts/eval-run-fidelity-campaign.mjs /path/to/private-output");
const OUTPUT_ROOT = path.resolve(requestedOutput);
const LOGICAL_PATH = /^(input|output|profiles)\/[A-Za-z0-9._/-]+$/;

function fidelityCellId(caseId, repetition) {
  return `pdf-tools.fidelity.cell.${caseId.replace("pdf-tools.fidelity.case.", "")}.r${repetition}`;
}

function normalizeResultValue(workspace, value) {
  if (typeof value === "string") {
    const logical = toLogical(workspace, value);
    return logical ?? value.replaceAll(`${workspace}${path.sep}`, "<workspace>/");
  }
  if (Array.isArray(value)) return value.map(item => normalizeResultValue(workspace, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeResultValue(workspace, item)]));
  }
  return value;
}

function collectLogicalResultPaths(value, paths = []) {
  if (typeof value === "string" && LOGICAL_PATH.test(value)) paths.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectLogicalResultPaths(item, paths));
  else if (value && typeof value === "object") Object.values(value).forEach(item => collectLogicalResultPaths(item, paths));
  return [...new Set(paths)].sort();
}

function resolveLogical(workspace, logicalPath) {
  if (!LOGICAL_PATH.test(logicalPath)) throw new Error(`Unsafe logical path: ${logicalPath}`);
  const resolved = path.resolve(workspace, logicalPath);
  if (!resolved.startsWith(`${workspace}${path.sep}`)) throw new Error(`Logical path escapes workspace: ${logicalPath}`);
  return resolved;
}

function toLogical(workspace, absolutePath) {
  if (typeof absolutePath !== "string") return null;
  const relative = path.relative(workspace, absolutePath).split(path.sep).join("/");
  return !relative.startsWith("../") && LOGICAL_PATH.test(relative) ? relative : null;
}

function resolveArguments(workspace, value) {
  if (typeof value === "string" && LOGICAL_PATH.test(value)) return resolveLogical(workspace, value);
  if (Array.isArray(value)) return value.map(item => resolveArguments(workspace, item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveArguments(workspace, item)]));
  return value;
}

function textFromResult(result) {
  return result?.content?.find(item => item.type === "text")?.text ?? null;
}

async function readHash(filePath) {
  try { return sha256(await fs.readFile(filePath)); } catch { return null; }
}

async function popplerPageCount(filePath) {
  try {
    const { stdout } = await runFile("pdfinfo", [filePath], { maxBuffer: 4 * 1024 * 1024 });
    const match = stdout.match(/^Pages:\s+(\d+)$/m);
    if (!match) throw new Error("pdfinfo did not report Pages");
    return { opened: true, page_count: Number(match[1]) };
  } catch (error) {
    return { opened: false, page_count: null, error: error.message };
  }
}

async function renderAllPoppler(filePath, pageCount, temporaryDirectory, dpi) {
  const renders = [];
  for (let page = 1; page <= pageCount; page += 1) renders.push(await renderPopplerPage(filePath, page, dpi, temporaryDirectory));
  return renders;
}

async function renderExpectedSourcePage(workspace, lineage, scale, temporaryDirectory) {
  const sourcePath = resolveLogical(workspace, lineage.source_path);
  if (lineage.rotation_delta === 0) return null;
  const pdf = await PDFDocument.load(await fs.readFile(sourcePath), { updateMetadata: false });
  const page = pdf.getPage(lineage.source_page - 1);
  page.setRotation(degrees((page.getRotation().angle + lineage.rotation_delta) % 360));
  const referencePath = path.join(temporaryDirectory, `expected-${lineage.output_page}-${Date.now()}.pdf`);
  const bytes = Buffer.from(await pdf.save({ updateFieldAppearances: false }));
  await fs.writeFile(referencePath, bytes);
  try {
    return {
      pdfjs: await renderComparisonPage(bytes, lineage.source_page, { scale }),
      poppler: await renderPopplerPage(referencePath, lineage.source_page, 144, temporaryDirectory),
    };
  } finally {
    await fs.rm(referencePath, { force: true });
  }
}

async function writeRgbaPng(render, filePath) {
  const canvas = createCanvas(render.width, render.height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(render.width, render.height);
  image.data.set(render.rgba);
  context.putImageData(image, 0, 0);
  const png = canvas.toBuffer("image/png");
  await fs.writeFile(filePath, png);
  return { path: path.relative(OUTPUT_ROOT, filePath).split(path.sep).join("/"), sha256: sha256(png), width: render.width, height: render.height };
}

async function writeUnexpectedHeatmap(before, after, filePath) {
  const width = after.width;
  const height = after.height;
  const rgba = Buffer.alloc(width * height * 4, 255);
  if (before.width === width && before.height === height) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) delta = Math.max(delta, Math.abs(before.rgba[offset + channel] - after.rgba[offset + channel]));
      if (delta > 8) {
        rgba[offset] = 220;
        rgba[offset + 1] = 20;
        rgba[offset + 2] = 60;
      }
    }
  }
  return writeRgbaPng({ width, height, rgba }, filePath);
}

async function verifyFailureEvidence(cells) {
  for (const cell of cells) {
    for (const evidence of cell.failure_evidence ?? []) {
      for (const artifact of [evidence.before, evidence.after, evidence.unexpected_delta_gt8]) {
        const resolved = path.resolve(OUTPUT_ROOT, artifact.path);
        if (!resolved.startsWith(`${OUTPUT_ROOT}${path.sep}`)) return false;
        const bytes = await fs.readFile(resolved);
        if (sha256(bytes) !== artifact.sha256 || bytes.length === 0) return false;
      }
    }
  }
  return true;
}

async function openServer(workspace) {
  const client = new Client({ name: "pdf-tools-fidelity-v1", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server", "index.js"), "--allowed-directories", workspace],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ALLOWED_DIRECTORIES: JSON.stringify([workspace]),
      DEFAULT_PDF_DIR: path.join(workspace, "input"),
      DEFAULT_DOWNLOAD_DIR: path.join(workspace, "output"),
      DEFAULT_PROFILES_DIR: path.join(workspace, "profiles"),
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function runCell(manifest, caseDefinition, repetition, engineFingerprint) {
  const startedAt = new Date().toISOString();
  const cellDirectory = path.join(OUTPUT_ROOT, "runs", caseDefinition.id.replaceAll(".", "_"), `repeat-${repetition}`);
  const workspace = path.join(cellDirectory, "workspace");
  const rasterTemp = path.join(cellDirectory, "raster-tmp");
  await fs.mkdir(path.join(workspace, "input"), { recursive: true });
  await fs.mkdir(path.join(workspace, "output"), { recursive: true });
  await fs.mkdir(path.join(workspace, "profiles", "backups"), { recursive: true });
  await fs.mkdir(path.join(workspace, "profiles", "signatures"), { recursive: true });
  await fs.mkdir(rasterTemp, { recursive: true });
  const documentById = new Map(manifest.documents.map(document => [document.id, document]));
  for (const input of caseDefinition.inputs) {
    await fs.copyFile(
      resolveFidelityDocumentPath(MANIFEST_PATH, documentById.get(input.document_id)),
      resolveLogical(workspace, input.logical_path),
    );
  }

  const sourceInspections = {};
  const sourceRenders = { pdfjs: {}, poppler: {} };
  for (const input of caseDefinition.inputs) {
    const filePath = resolveLogical(workspace, input.logical_path);
    const inspection = await inspectFidelityDocument(filePath, { scale: manifest.measurement_policy.renderer.scale });
    sourceInspections[input.logical_path] = inspection;
    sourceRenders.pdfjs[input.logical_path] = inspection.renders;
    sourceRenders.poppler[input.logical_path] = await renderAllPoppler(filePath, inspection.page_count, rasterTemp, 144);
  }
  const initialSnapshot = await snapshotFilesystem(workspace);
  const originalSamePathHash = caseDefinition.family === "same_path"
    ? sourceInspections[caseDefinition.inputs[0].logical_path].sha256 : null;
  const toolCalls = [];
  let firstBackupPath = null;
  let firstBackupHash = null;
  let snapshotAfterFault = null;
  let hashBeforeSecond = null;
  let hashAfterSecond = null;
  let secondCallError = null;
  let activeBeforeExpectedFailure = null;
  let runtime;
  let active = null;
  try {
    runtime = await openServer(workspace);
    for (const [index, call] of caseDefinition.tool_calls.entries()) {
      const result = await runtime.client.callTool({ name: call.name, arguments: resolveArguments(workspace, call.arguments) });
      const normalizedResult = normalizeResultValue(workspace, result);
      toolCalls.push({
        call_index: index + 1,
        name: call.name,
        arguments_sha256: digestCanonical("tool-arguments", call.arguments),
        result_sha256: digestCanonical("report", normalizedResult),
        is_error: result.isError === true,
        error_text: result.isError ? textFromResult(result) : null,
        reported_output_paths: collectLogicalResultPaths(normalizedResult.structuredContent),
      });
      const reportedBackup = result.structuredContent?.backup_path;
      if (index === 0 && reportedBackup) {
        firstBackupPath = reportedBackup;
        firstBackupHash = await readHash(reportedBackup);
      }
      const fault = caseDefinition.fault_actions?.find(action => action.after_call === index + 1);
      if (fault?.action === "delete_reported_backup") {
        if (!firstBackupPath) throw new Error("Fault plan expected the first call to report backup_path");
        await fs.rm(firstBackupPath);
        snapshotAfterFault = await snapshotFilesystem(workspace);
        hashBeforeSecond = await readHash(resolveLogical(workspace, caseDefinition.inputs[0].logical_path));
        const beforeFailure = await runtime.client.callTool({ name: "get_active_document", arguments: {} });
        activeBeforeExpectedFailure = {
          active_path: toLogical(workspace, beforeFailure.structuredContent?.active_path),
          backup_path: toLogical(workspace, beforeFailure.structuredContent?.backup_path),
          last_mutation_tool: beforeFailure.structuredContent?.last_mutation_tool ?? null,
          last_mutation_at: beforeFailure.structuredContent?.last_mutation_at ?? null,
        };
      }
      if (index === 1 && caseDefinition.lifecycle.backup_policy === "missing-original-fail-closed") {
        secondCallError = result.isError === true;
        hashAfterSecond = await readHash(resolveLogical(workspace, caseDefinition.inputs[0].logical_path));
      }
    }
    const activeResult = await runtime.client.callTool({ name: "get_active_document", arguments: {} });
    active = {
      active_path: toLogical(workspace, activeResult.structuredContent?.active_path),
      backup_path: toLogical(workspace, activeResult.structuredContent?.backup_path),
      last_mutation_tool: activeResult.structuredContent?.last_mutation_tool ?? null,
      last_mutation_at: activeResult.structuredContent?.last_mutation_at ?? null,
    };
  } finally {
    await runtime?.transport.close();
  }

  const finalSnapshot = await snapshotFilesystem(workspace);
  const filesystemDiff = diffFilesystem(initialSnapshot, finalSnapshot);
  const faultDiff = snapshotAfterFault ? diffFilesystem(snapshotAfterFault, finalSnapshot) : null;
  const outputInspections = {};
  const outputRenders = { pdfjs: {}, poppler: {} };
  for (const outputPath of caseDefinition.expected_outputs) {
    const filePath = resolveLogical(workspace, outputPath);
    try {
      const inspection = await inspectFidelityDocument(filePath, { scale: manifest.measurement_policy.renderer.scale });
      const poppler = await popplerPageCount(filePath);
      const popplerRenders = poppler.opened ? await renderAllPoppler(filePath, poppler.page_count, rasterTemp, 144) : [];
      outputRenders.pdfjs[outputPath] = inspection.renders;
      outputRenders.poppler[outputPath] = popplerRenders;
      outputInspections[outputPath] = {
        exists: true,
        producer_call_index: producerCallIndex(caseDefinition, outputPath),
        inspection: serializableInspection(inspection),
        poppler: { ...poppler, render_count: popplerRenders.length },
      };
    } catch (error) {
      outputInspections[outputPath] = { exists: false, producer_call_index: producerCallIndex(caseDefinition, outputPath), error: error.message, inspection: null, poppler: { opened: false, page_count: null, render_count: 0 } };
    }
  }

  const visualComparisons = [];
  const visualPairs = [];
  for (const lineage of caseDefinition.page_lineage) {
    const intendedRegions = caseDefinition.intended_regions
      .map((region, regionIndex) => ({ ...region, region_index: regionIndex }))
      .filter(region => region.output_path === lineage.output_path && region.page === lineage.output_page);
    const regions = intendedRegions.map(region => region.region);
    const transformed = await renderExpectedSourcePage(
      workspace,
      lineage,
      manifest.measurement_policy.renderer.scale,
      rasterTemp,
    );
    for (const engine of ["pdfjs", "poppler"]) {
      const source = transformed?.[engine] ?? sourceRenders[engine][lineage.source_path]?.[lineage.source_page - 1];
      const output = outputRenders[engine][lineage.output_path]?.[lineage.output_page - 1];
      if (!source || !output) {
        visualComparisons.push({
          engine, output_path: lineage.output_path, output_page: lineage.output_page,
          source_path: lineage.source_path, source_page: lineage.source_page,
          rotation_delta: lineage.rotation_delta, metrics: null, region_metrics: [],
        });
        continue;
      }
      const outputInspection = outputInspections[lineage.output_path]?.inspection;
      const pageGeometry = outputInspection?.pages?.[lineage.output_page - 1];
      const pdfjsRender = outputRenders.pdfjs[lineage.output_path]?.[lineage.output_page - 1];
      if (pageGeometry && pdfjsRender?.viewport_transform) {
        const ratioX = output.width / pdfjsRender.width;
        const ratioY = output.height / pdfjsRender.height;
        const [a, b, c, d, e, f] = pdfjsRender.viewport_transform;
        output.mask_geometry = {
          media_box: pageGeometry.media_box,
          viewport_transform: [a * ratioX, b * ratioY, c * ratioX, d * ratioY, e * ratioX, f * ratioY],
        };
      }
      visualComparisons.push({
        engine,
        output_path: lineage.output_path,
        output_page: lineage.output_page,
        source_path: lineage.source_path,
        source_page: lineage.source_page,
        rotation_delta: lineage.rotation_delta,
        metrics: diffFidelityRgba(source, output, regions, manifest.measurement_policy.renderer),
        region_metrics: intendedRegions.map(region => ({
          region_index: region.region_index,
          region: region.region,
          metrics: diffFidelityRgba(source, output, [region.region], manifest.measurement_policy.renderer),
        })),
      });
      visualPairs.push({ engine, lineage, before: source, after: output });
    }
  }

  const backupEntries = finalSnapshot.filter(entry => /^profiles\/backups\/.*\.pdf$/.test(entry.path));
  const firstLogical = toLogical(workspace, firstBackupPath);
  const finalBackup = firstLogical ? finalSnapshot.find(entry => entry.path === firstLogical) : null;
  const cell = {
    cell_schema_version: 2,
    cell_id: fidelityCellId(caseDefinition.id, repetition),
    case_id: caseDefinition.id,
    case_contract_sha256: digestCanonical("case", caseDefinition),
    repetition,
    outcome: "completed",
    provenance: {
      provenance_schema_version: 1,
      invocation_id: `${caseDefinition.id}.r${repetition}`,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    },
    artifact_ids: [],
    tool_calls: toolCalls,
    engines: { poppler: engineFingerprint },
    sources: Object.fromEntries(Object.entries(sourceInspections).map(([key, value]) => [key, serializableInspection(value)])),
    outputs: outputInspections,
    visual_comparisons: visualComparisons,
    filesystem: { before: initialSnapshot, after: finalSnapshot, diff: filesystemDiff },
    lifecycle: { active, before_expected_failure: activeBeforeExpectedFailure },
    backup: {
      original_sha256: originalSamePathHash,
      first_path: firstLogical,
      first_sha256: firstBackupHash,
      final_path: active?.backup_path,
      final_sha256: finalBackup?.sha256 ?? null,
      created_paths: backupEntries.map(entry => entry.path),
      second_call_error: secondCallError,
      hash_before_second: hashBeforeSecond,
      hash_after_second: hashAfterSecond,
      created_paths_after_fault: faultDiff?.created.filter(item => /^profiles\/backups\/.*\.pdf$/.test(item)) ?? [],
    },
    harness_failure: null,
  };
  const preliminary = evaluateFidelityCell(manifest, caseDefinition, cell);
  cell.failure_evidence = [];
  if (!preliminary.passed) {
    const evidenceDirectory = path.join(cellDirectory, "failure-evidence");
    await fs.mkdir(evidenceDirectory, { recursive: true });
    for (const [index, pair] of visualPairs.entries()) {
      const stem = `${pair.engine}-${pair.lineage.output_path.replaceAll("/", "_")}-page-${pair.lineage.output_page}-${index + 1}`;
      const before = await writeRgbaPng(pair.before, path.join(evidenceDirectory, `${stem}-before.png`));
      const after = await writeRgbaPng(pair.after, path.join(evidenceDirectory, `${stem}-after.png`));
      const unexpected = await writeUnexpectedHeatmap(pair.before, pair.after, path.join(evidenceDirectory, `${stem}-delta-gt8.png`));
      cell.failure_evidence.push({
        engine: pair.engine,
        output_path: pair.lineage.output_path,
        output_page: pair.lineage.output_page,
        source_path: pair.lineage.source_path,
        source_page: pair.lineage.source_page,
        rotation_delta: pair.lineage.rotation_delta,
        source_pdf_sha256: sourceInspections[pair.lineage.source_path].sha256,
        output_pdf_sha256: outputInspections[pair.lineage.output_path]?.inspection?.sha256 ?? null,
        before,
        after,
        unexpected_delta_gt8: unexpected,
      });
    }
  }
  return cell;
}

await fs.mkdir(OUTPUT_ROOT, { recursive: true });
for (const reserved of ["runs", "fidelity-report.v2.json", "fidelity-score.v2.json", "run-index.v2.json"]) {
  try {
    await fs.lstat(path.join(OUTPUT_ROOT, reserved));
    throw new Error(`Output root is not fresh; reserved path already exists: ${reserved}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const manifest = await loadFidelityManifest(MANIFEST_PATH);
const fixtureBindings = await verifyFidelityDocuments(MANIFEST_PATH, manifest);
if (!fixtureBindings.every(binding => binding.passed)) throw new Error("Fidelity fixture SHA-256 verification failed");
const engineFingerprint = await popplerFingerprint();
const productRendererFingerprint = rendererFingerprint(manifest.measurement_policy.renderer);
const sourceRevision = (await runFile("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
const sourceTree = (await runFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: REPO_ROOT })).stdout.trim();
const dirty = (await runFile("git", ["status", "--porcelain"], { cwd: REPO_ROOT })).stdout.trim();
if (dirty) throw new Error("Fidelity campaigns require a tracked-clean source tree");
const campaignStartedAt = new Date().toISOString();
const cells = [];
for (const caseDefinition of manifest.cases) {
  for (let repetition = 1; repetition <= manifest.measurement_policy.repetitions; repetition += 1) {
    process.stderr.write(`fidelity ${caseDefinition.id} repeat ${repetition}\n`);
    try {
      cells.push(await runCell(manifest, caseDefinition, repetition, engineFingerprint));
    } catch (error) {
      const cellId = fidelityCellId(caseDefinition.id, repetition);
      const cellDirectory = path.join(OUTPUT_ROOT, "runs", caseDefinition.id.replaceAll(".", "_"), `repeat-${repetition}`);
      await fs.mkdir(cellDirectory, { recursive: true });
      const detail = (error instanceof Error ? error.message : String(error))
        .replaceAll(REPO_ROOT, "<repo>").replaceAll(OUTPUT_ROOT, "<output>");
      const logPath = path.join(cellDirectory, "harness.log");
      await fs.writeFile(logPath, `${detail}\n`, { mode: 0o600 });
      const artifactId = `artifact.${cellId.replace("pdf-tools.fidelity.cell.", "")}.harness-log`;
      cells.push({
        cell_schema_version: 2,
        cell_id: cellId,
        case_id: caseDefinition.id,
        case_contract_sha256: digestCanonical("case", caseDefinition),
        repetition,
        outcome: "harness_failure",
        provenance: {
          provenance_schema_version: 1,
          invocation_id: `${caseDefinition.id}.r${repetition}`,
          started_at: campaignStartedAt,
          finished_at: new Date().toISOString(),
        },
        artifact_ids: [artifactId],
        harness_failure: {
          harness_schema_version: 1,
          code: "run_cell_failure",
          phase: "run_cell",
          detail,
          artifact_id: artifactId,
        },
      });
    }
  }
}
const artifacts = [];
for (const cell of cells) {
  if (cell.outcome === "harness_failure") {
    const artifactPath = `runs/${cell.case_id.replaceAll(".", "_")}/repeat-${cell.repetition}/harness.log`;
    const bytes = await fs.readFile(path.join(OUTPUT_ROOT, artifactPath));
    artifacts.push({ artifact_id: cell.artifact_ids[0], role: "harness_log", path: artifactPath, media_type: "text/plain", sha256: sha256(bytes), byte_length: bytes.length, cell_id: cell.cell_id });
    continue;
  }
  for (const [evidenceIndex, evidence] of cell.failure_evidence.entries()) {
    for (const [key, role] of [["before", "failure_before"], ["after", "failure_after"], ["unexpected_delta_gt8", "failure_delta"]]) {
      const image = evidence[key];
      const artifactId = `artifact.${cell.cell_id.replace("pdf-tools.fidelity.cell.", "")}.${evidenceIndex + 1}.${role.replace("failure_", "")}`;
      const bytes = await fs.readFile(path.join(OUTPUT_ROOT, image.path));
      artifacts.push({ artifact_id: artifactId, role, path: image.path, media_type: "image/png", sha256: image.sha256, byte_length: bytes.length, cell_id: cell.cell_id });
      cell.artifact_ids.push(artifactId);
    }
  }
}
const cellBindings = cells.map(cell => ({
  cell_id: cell.cell_id,
  case_id: cell.case_id,
  case_contract_sha256: cell.case_contract_sha256,
  repetition: cell.repetition,
  outcome: cell.outcome,
  cell_sha256: digestCell(cell),
  artifact_ids: [...cell.artifact_ids],
}));
const report = {
  schema_version: 2,
  report_schema_version: 2,
  benchmark_id: manifest.benchmark_id,
  benchmark_version: manifest.benchmark_version,
  claim_boundary: "Linux source-server evidence with PDF.js 5.4.624 and installed Poppler at 144 DPI; not packed MCPB or native Claude Desktop evidence.",
  generated_at: new Date().toISOString(),
  digests: {
    manifest_sha256: digestCanonical("manifest", manifest),
    runner_sha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
    source_revision: sourceRevision,
    source_tree_sha256: sha256(Buffer.from(sourceTree)),
  },
  provenance: {
    provenance_schema_version: 1,
    producer: "scripts/eval-run-fidelity-campaign.mjs",
    capture_mode: "source_server",
    started_at: campaignStartedAt,
    finished_at: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node_version: process.version, hostname_sha256: sha256(Buffer.from(os.hostname())) },
  },
  fixture_bindings: fixtureBindings,
  engine_fingerprints: { pdfjs_canvas_runtime_sha256: productRendererFingerprint, poppler: engineFingerprint },
  failure_evidence_integrity: await verifyFailureEvidence(cells),
  artifacts,
  cell_bindings: cellBindings,
  cells,
};
const score = scoreFidelityReport(manifest, report);
const reportPath = path.join(OUTPUT_ROOT, "fidelity-report.v2.json");
const scorePath = path.join(OUTPUT_ROOT, "fidelity-score.v2.json");
await fs.writeFile(reportPath, prettyCanonicalJson(report));
await fs.writeFile(scorePath, prettyCanonicalJson(score));
const reportBytes = await fs.readFile(reportPath);
const scoreBytes = await fs.readFile(scorePath);
const index = {
  schema_version: 2,
  run_index_schema_version: 2,
  benchmark_id: manifest.benchmark_id,
  benchmark_version: manifest.benchmark_version,
  generated_at: report.generated_at,
  benchmark_claim_ready: score.passed,
  claim_boundary: report.claim_boundary,
  digests: {
    manifest_sha256: report.digests.manifest_sha256,
    runner_sha256: report.digests.runner_sha256,
    source_revision: sourceRevision,
    report_sha256: sha256(reportBytes),
    score_sha256: sha256(scoreBytes),
    cell_set_sha256: digestCanonical("report", cellBindings),
  },
  provenance: report.provenance,
  denominator: score.denominator,
  result: {
    valid: score.valid,
    execution_complete: score.execution_complete,
    passed: score.passed,
    product_failures: score.required_failures.filter(failure => failure.gate !== "harness").length,
    harness_failures: score.denominator.harness_failures,
  },
  artifacts: [
    { artifact_id: "artifact.report", role: "report", path: path.basename(reportPath), media_type: "application/json", sha256: sha256(reportBytes), byte_length: reportBytes.length, cell_id: null },
    { artifact_id: "artifact.score", role: "score", path: path.basename(scorePath), media_type: "application/json", sha256: sha256(scoreBytes), byte_length: scoreBytes.length, cell_id: null },
    ...artifacts,
  ],
  cell_bindings: cellBindings,
};
index.run_sha256 = digestRunIndex(index);
await fs.writeFile(path.join(OUTPUT_ROOT, "run-index.v2.json"), prettyCanonicalJson(index));
process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
