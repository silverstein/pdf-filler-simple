#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  resolveFidelityDocumentPath,
  verifyFidelityDocuments,
} from "../test/eval/fidelity-manifest.js";
import { evaluateFidelityCell, scoreFidelityReport } from "../test/eval/fidelity-scorer.js";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "manifest.v1.json");
const requestedOutput = process.argv[2];
if (!requestedOutput) throw new Error("Usage: node scripts/eval-run-fidelity-campaign.mjs /path/to/private-output");
const OUTPUT_ROOT = path.resolve(requestedOutput);
const LOGICAL_PATH = /^(input|output|profiles)\/[A-Za-z0-9._/-]+$/;

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  let runtime;
  let active = null;
  try {
    runtime = await openServer(workspace);
    for (const [index, call] of caseDefinition.tool_calls.entries()) {
      const result = await runtime.client.callTool({ name: call.name, arguments: resolveArguments(workspace, call.arguments) });
      toolCalls.push({
        name: call.name,
        arguments_sha256: digestJson(call.arguments),
        is_error: result.isError === true,
        error_text: result.isError ? textFromResult(result) : null,
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
        inspection: serializableInspection(inspection),
        poppler: { ...poppler, render_count: popplerRenders.length },
      };
    } catch (error) {
      outputInspections[outputPath] = { exists: false, error: error.message, inspection: null, poppler: { opened: false, page_count: null, render_count: 0 } };
    }
  }

  const visualComparisons = [];
  const visualPairs = [];
  for (const lineage of caseDefinition.page_lineage) {
    const regions = caseDefinition.intended_regions
      .filter(region => region.output_path === lineage.output_path && region.page === lineage.output_page)
      .map(region => region.region);
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
        visualComparisons.push({ engine, output_path: lineage.output_path, output_page: lineage.output_page, metrics: null });
        continue;
      }
      const pageWidthPoints = outputInspections[lineage.output_path]?.inspection?.pages?.[lineage.output_page - 1]?.crop_box?.[2] ?? 612;
      source.page_width_points = pageWidthPoints;
      output.page_width_points = pageWidthPoints;
      visualComparisons.push({
        engine,
        output_path: lineage.output_path,
        output_page: lineage.output_page,
        source_path: lineage.source_path,
        source_page: lineage.source_page,
        rotation_delta: lineage.rotation_delta,
        metrics: diffFidelityRgba(source, output, regions, manifest.measurement_policy.renderer),
      });
      visualPairs.push({ engine, lineage, before: source, after: output });
    }
  }

  const backupEntries = finalSnapshot.filter(entry => /^profiles\/backups\/.*\.pdf$/.test(entry.path));
  const firstLogical = toLogical(workspace, firstBackupPath);
  const finalBackup = firstLogical ? finalSnapshot.find(entry => entry.path === firstLogical) : null;
  const cell = {
    case_id: caseDefinition.id,
    repetition,
    tool_calls: toolCalls,
    engines: { poppler: engineFingerprint },
    sources: Object.fromEntries(Object.entries(sourceInspections).map(([key, value]) => [key, serializableInspection(value)])),
    outputs: outputInspections,
    visual_comparisons: visualComparisons,
    filesystem: { before: initialSnapshot, after: finalSnapshot, diff: filesystemDiff },
    lifecycle: { active },
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
for (const reserved of ["runs", "fidelity-report.v1.json", "fidelity-score.v1.json", "run-index.v1.json"]) {
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
const cells = [];
for (const caseDefinition of manifest.cases) {
  for (let repetition = 1; repetition <= manifest.measurement_policy.repetitions; repetition += 1) {
    process.stderr.write(`fidelity ${caseDefinition.id} repeat ${repetition}\n`);
    cells.push(await runCell(manifest, caseDefinition, repetition, engineFingerprint));
  }
}
const report = {
  schema_version: 1,
  benchmark_id: manifest.benchmark_id,
  benchmark_version: manifest.benchmark_version,
  claim_boundary: "Linux source-server evidence with PDF.js 5.4.624 and installed Poppler at 144 DPI; not packed MCPB or native Claude Desktop evidence.",
  generated_at: new Date().toISOString(),
  manifest_sha256: sha256(await fs.readFile(MANIFEST_PATH)),
  runner_sha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
  source_revision: sourceRevision,
  fixture_bindings: fixtureBindings,
  engine_fingerprints: { pdfjs_canvas_runtime_sha256: productRendererFingerprint, poppler: engineFingerprint },
  failure_evidence_integrity: await verifyFailureEvidence(cells),
  cells,
};
const score = scoreFidelityReport(manifest, report);
const reportPath = path.join(OUTPUT_ROOT, "fidelity-report.v1.json");
const scorePath = path.join(OUTPUT_ROOT, "fidelity-score.v1.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`);
const index = {
  schema_version: 1,
  benchmark_id: manifest.benchmark_id,
  generated_at: report.generated_at,
  benchmark_claim_ready: score.passed,
  claim_boundary: report.claim_boundary,
  denominator: score.denominator,
  result: { valid: score.valid, passed: score.passed, failures: score.required_failures.length },
  artifacts: [
    { path: path.basename(reportPath), sha256: sha256(await fs.readFile(reportPath)) },
    { path: path.basename(scorePath), sha256: sha256(await fs.readFile(scorePath)) },
  ],
  run_sha256: digestJson({ manifest_sha256: report.manifest_sha256, cells: cells.map(cell => [cell.case_id, cell.repetition]) }),
};
await fs.writeFile(path.join(OUTPUT_ROOT, "run-index.v1.json"), `${JSON.stringify(index, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
