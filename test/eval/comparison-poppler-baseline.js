import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function parseInfo(output) {
  const info = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) info[match[1].trim()] = match[2].trim();
  }
  return info;
}

function selectDocumentMetadata(info) {
  return Object.fromEntries([
    "Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate",
  ].map(key => [key, info[key] ?? null]));
}

function pageMarkers(pages) {
  return pages.flatMap(page => page.match(/PAGE-ID:\s*([A-Z]+)/)?.[1] ?? []);
}

async function commandVersion(command) {
  const { stdout, stderr } = await execFileAsync(command, ["-v"], { encoding: "utf8" });
  return normalize(`${stdout}\n${stderr}`).split(" ").slice(0, 4).join(" ");
}

async function inspectPopplerDocument(filePath) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-poppler-"));
  try {
    const [{ stdout: text }, { stdout: infoText }] = await Promise.all([
      execFileAsync("pdftotext", ["-enc", "UTF-8", "-layout", filePath, "-"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
      execFileAsync("pdfinfo", [filePath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
    ]);
    const pages = text.split("\f").map(normalize).filter(Boolean);
    const prefix = path.join(temporary, "page");
    await execFileAsync("pdftoppm", [
      "-r", "144", "-f", "1", "-l", String(pages.length), filePath, prefix,
    ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
    const rasterFiles = (await fs.readdir(temporary)).filter(name => name.endsWith(".ppm")).sort((left, right) =>
      Number(left.match(/(\d+)\.ppm$/)?.[1]) - Number(right.match(/(\d+)\.ppm$/)?.[1]));
    const rasterSha256 = [];
    for (const filename of rasterFiles) rasterSha256.push(digest(await fs.readFile(path.join(temporary, filename))));
    const bytes = await fs.readFile(filePath);
    return {
      document_sha256: digest(bytes),
      bytes: bytes.length,
      normalized_text_sha256: digest(normalize(text)),
      page_text_sha256: pages.map(page => digest(page)),
      page_markers: pageMarkers(pages),
      metadata: selectDocumentMetadata(parseInfo(infoText)),
      raster_ppm_sha256_144_dpi: rasterSha256,
    };
  } finally {
    await fs.rm(temporary, { recursive: true });
  }
}

export async function buildPopplerComparisonSensor({ benchmarkId, benchmarkVersion, pairs }) {
  let versions;
  try {
    versions = Object.fromEntries(await Promise.all(["pdftotext", "pdfinfo", "pdftoppm"].map(async command =>
      [command, await commandVersion(command)])));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schema_version: 1,
      benchmark_id: benchmarkId,
      benchmark_version: benchmarkVersion,
      engine_status: "engine_unavailable",
      benchmark_claim_ready: false,
      error: "Poppler CLI was not installed; no fallback engine was substituted.",
      pairs: [],
    };
  }
  const results = [];
  for (const pair of pairs) {
    const [before, after] = await Promise.all([
      inspectPopplerDocument(pair.beforePath),
      inspectPopplerDocument(pair.afterPath),
    ]);
    results.push({
      pair_id: pair.pairId,
      before,
      after,
      observations: {
        normalized_text_equal: before.normalized_text_sha256 === after.normalized_text_sha256,
        page_marker_order_equal: JSON.stringify(before.page_markers) === JSON.stringify(after.page_markers),
        metadata_equal: JSON.stringify(before.metadata) === JSON.stringify(after.metadata),
        same_position_raster_equal: JSON.stringify(before.raster_ppm_sha256_144_dpi)
          === JSON.stringify(after.raster_ppm_sha256_144_dpi),
      },
    });
  }
  return {
    schema_version: 1,
    benchmark_id: benchmarkId,
    benchmark_version: benchmarkVersion,
    engine_status: "completed",
    benchmark_claim_ready: false,
    claim_boundary: "Independent Poppler CLI sensor output only; no event-level semantic oracle, region alignment, form-field extraction, or annotation enumeration.",
    engine: {
      id: "poppler-cli-system-baseline",
      kind: "external_cli",
      versions,
      license: "system package license not audited by this run",
      bundled: false,
      network_requests: 0,
    },
    pairs: results,
  };
}
