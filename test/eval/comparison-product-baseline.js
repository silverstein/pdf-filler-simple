import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COMPARISON_CHANNELS } from "./comparison-manifest.js";
import { registerControllerObservationRecords } from "./comparison-observation-registry.js";
import { rendererFingerprint } from "./comparison-observations.js";
import { buildComparisonPairFromInspections } from "./comparison-reference-baseline.js";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nullMetadata() {
  return Object.fromEntries([
    "Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate",
  ].map(key => [key, null]));
}

async function decodePng(content, page) {
  const imageContent = content.find(item => item.type === "image");
  if (!imageContent?.data) throw new Error(`render_pdf_page returned no image for page ${page}`);
  const png = Buffer.from(imageContent.data, "base64");
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return {
    page,
    width: image.width,
    height: image.height,
    scale: image.height / 792,
    rgba: Buffer.from(context.getImageData(0, 0, image.width, image.height).data),
    rgba_sha256: digest(Buffer.from(context.getImageData(0, 0, image.width, image.height).data)),
    retained_png_sha256: digest(png),
  };
}

function extractItems(text) {
  const items = [];
  for (const pattern of [
    /Monthly fee: (USD [\d,]+)/,
    /Termination notice: (\d+ days)/,
  ]) {
    const match = text.match(pattern);
    if (match) items.push({ text: match[0], region: [0, 0, 612, 792], retained_value: match[1] });
  }
  const marker = text.match(/PAGE-ID: [A-Z]+/)?.[0] ?? null;
  if (marker) items.push({ text: marker, region: [0, 0, 612, 792], retained_value: marker });
  return { items, marker };
}

function toolFailed(result, tool) {
  if (result.isError) {
    const message = result.content?.find(item => item.type === "text")?.text ?? "unknown tool error";
    throw new Error(`${tool} failed: ${message}`);
  }
  return result;
}

async function inspectWithPublishedTools(client, filePath) {
  const pagesResult = toolFailed(await client.callTool({
    name: "read_pdf_pages",
    arguments: { pdf_path: filePath, start_page: 1, end_page: 2, max_chars_per_page: 4000 },
  }), "read_pdf_pages");
  const fieldsResult = toolFailed(await client.callTool({
    name: "read_pdf_fields",
    arguments: { pdf_path: filePath },
  }), "read_pdf_fields");
  const renders = [];
  for (let page = 1; page <= pagesResult.structuredContent.total_pages; page += 1) {
    const result = toolFailed(await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: filePath, page, max_dimension_px: 1584 },
    }), "render_pdf_page");
    renders.push(await decodePng(result.content, page));
  }
  const bytes = await fs.readFile(filePath);
  const pages = pagesResult.structuredContent.pages.map(item => {
    const parsed = extractItems(item.text);
    return {
      page: item.page,
      width: 612,
      height: 792,
      text: item.text,
      text_sha256: digest(item.text),
      marker: parsed.marker,
      items: parsed.items,
      retained_result_sha256: digest(JSON.stringify(pagesResult.structuredContent)),
    };
  });
  const fields = fieldsResult.structuredContent.fields.map(field => ({
    name: field.name,
    type: field.type,
    value: field.currentValue ?? "",
    value_sha256: digest(String(field.currentValue ?? "")),
    page: fieldsResult.structuredContent.initialPage ?? 1,
    region: [0, 0, 612, 792],
    retained_result_sha256: digest(JSON.stringify(fieldsResult.structuredContent)),
  }));
  return {
    path: filePath,
    sha256: digest(bytes),
    size: bytes.length,
    pages,
    renders,
    fields,
    annotations: [],
    metadata: nullMetadata(),
  };
}

async function inspectProductPair(client, beforePath, afterPath) {
  const [before, after] = await Promise.all([
    inspectWithPublishedTools(client, beforePath),
    inspectWithPublishedTools(client, afterPath),
  ]);
  return { before, after };
}

export async function buildProductPrimitiveReport({
  benchmarkId,
  benchmarkVersion,
  renderer,
  pairs,
  repositoryRoot,
  allowedDirectory = path.dirname(pairs[0].beforePath),
}) {
  const client = new Client({ name: "pdf-tools-comparison-product-baseline", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repositoryRoot, "server", "index.js"), "--allowed-directories", allowedDirectory],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ALLOWED_DIRECTORIES: JSON.stringify([allowedDirectory]),
      DEFAULT_PDF_DIR: allowedDirectory,
      DEFAULT_DOWNLOAD_DIR: allowedDirectory,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const pairReports = [];
  const controllerRecords = [];
  try {
    for (const pair of pairs) {
      let inspected;
      const timingSamples = [];
      const iterationCosts = [];
      let warmupMs = 0;
      let warmupCost;
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const started = performance.now();
        const candidate = await inspectProductPair(client, pair.beforePath, pair.afterPath);
        const elapsed = performance.now() - started;
        const candidateCost = {
          tool_calls: 8,
          logical_input_bytes: candidate.before.size + candidate.after.size,
          rendered_pixels: [...candidate.before.renders, ...candidate.after.renders]
            .reduce((sum, render) => sum + render.width * render.height, 0),
          peak_rss_bytes: null,
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
      const sourceHashes = await Promise.all([
        fs.readFile(pair.beforePath).then(digest),
        fs.readFile(pair.afterPath).then(digest),
      ]);
      const built = buildComparisonPairFromInspections({
        pairId: pair.pairId,
        ...inspected,
        renderer,
        timingSamples,
        warmupMs,
        warmupCost,
        iterationCosts,
        peakRss: null,
        resourceMeasurementStatus: "unavailable",
        capture: "retained_tool_result",
        channelStatus: Object.fromEntries(COMPARISON_CHANNELS.map(channel => [
          channel,
          ["annotation", "metadata"].includes(channel) ? "unavailable" : "supported",
        ])),
      });
      const report = built.pairReport;
      controllerRecords.push(...built.controllerRecords);
      report.source_immutable = sourceHashes[0] === report.before_sha256
        && sourceHashes[1] === report.after_sha256;
      pairReports.push(report);
    }
  } finally {
    await transport.close();
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const report = {
    report_schema_version: 1,
    benchmark_id: benchmarkId,
    benchmark_version: benchmarkVersion,
    mode: "default_material",
    claim_boundary: "Deterministic inspection through the current published PDF Tools MCP read/field/render primitives on Linux; no model, metadata-value tool, annotation-enumeration tool, or native Claude Desktop host.",
    benchmark_claim_ready: false,
    engine: {
      id: "pdf-tools-current-published-primitives",
      kind: "pdf_tools_mcp",
      version: packageJson.version,
      license: packageJson.license ?? "MIT",
      provenance: "repository server/index.js; candidate MCPB SHA-256 b586221595cc3095d43f73daf3b66c6cc9695bddcd98365f46c445a597d9a1b4 not executed in this Linux lane",
      bundle_increment_bytes: 0,
      native_targets: [`${process.platform}-${process.arch}`],
      network_requests: 0,
      external_processes: 1,
      renderer_fingerprint_sha256: rendererFingerprint(renderer),
    },
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      host: "silvercloud-vm-stdio",
      model: "none",
      model_cost_usd: 0,
    },
    isolation: {
      truth_manifest_visible: true,
      shell_access: true,
      sut_network: "not_enforced",
      model_endpoint: null,
      allowed_directory_evidence_sha256: digest(pairs.flatMap(pair => [pair.beforeSha256, pair.afterSha256]).sort().join("|")),
    },
    pairs: pairReports,
  };
  return registerControllerObservationRecords(report, controllerRecords);
}
