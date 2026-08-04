import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COMPARISON_CHANNELS } from "./comparison-manifest.js";
import { registerControllerObservationRecords } from "./comparison-observation-registry.js";
import { inspectComparisonDocument, rendererFingerprint } from "./comparison-observations.js";
import { buildComparisonPairFromInspections } from "./comparison-reference-baseline.js";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toolFailed(result, tool) {
  if (result.isError) {
    const message = result.content?.find(item => item.type === "text")?.text ?? "unknown tool error";
    throw new Error(`${tool} failed: ${message}`);
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

export function assertProductMatchesCanonicalAdapter(product, canonicalPair) {
  if (product.status !== "complete"
    || product.before_source.sha256 !== canonicalPair.before_sha256
    || product.after_source.sha256 !== canonicalPair.after_sha256
    || !product.source_immutability.before.unchanged
    || !product.source_immutability.after.unchanged) {
    throw new Error("compare_pdfs did not complete against immutable canonical pair bytes");
  }
  const productAlignments = product.page_alignments.map(item => ({
    before_page: item.before_page,
    after_page: item.after_page,
    relation: item.relation,
  }));
  const canonicalAlignments = canonicalPair.alignments.map(item => ({
    before_page: item.before_page,
    after_page: item.after_page,
    relation: item.relation,
  }));
  if (canonical(productAlignments) !== canonical(canonicalAlignments)) {
    throw new Error("compare_pdfs page relations do not match the canonical adapter");
  }
  for (const channel of COMPARISON_CHANNELS) {
    if (product.coverage[channel].status !== "supported") {
      throw new Error(`compare_pdfs ${channel} coverage is not complete in the seven-pair slice`);
    }
  }
  const productObservations = new Map(product.observations.map(item => [item.id, item]));
  const canonicalObservations = new Map(canonicalPair.observations.map(item => [item.id, item]));
  const unusedChanges = new Set(product.changes);
  for (const referenceEvent of canonicalPair.detected_events) {
    const referenceDecision = canonicalPair.presentation_decisions.find(item => item.event_id === referenceEvent.id);
    const match = [...unusedChanges].find(change => {
      if (change.salience !== referenceEvent.salience
        || change.facets.length !== referenceEvent.facets.length
        || change.presentation.disposition !== referenceDecision?.disposition) return false;
      return referenceEvent.facets.every(referenceFacet => {
        const productFacet = change.facets.find(item => item.channel === referenceFacet.channel
          && item.operation === referenceFacet.operation);
        if (!productFacet) return false;
        return [["before_evidence_id", "before"], ["after_evidence_id", "after"]]
          .every(([key]) => {
            const referenceId = referenceFacet[key];
            const productId = productFacet[key];
            if (referenceId === null || productId === null) return referenceId === productId;
            const referenceEvidence = canonicalObservations.get(referenceId);
            const productEvidence = productObservations.get(productId);
            if (!referenceEvidence || !productEvidence
              || referenceEvidence.channel !== productEvidence.channel
              || referenceEvidence.document_sha256 !== productEvidence.document_sha256
              || referenceEvidence.page !== productEvidence.page
              || referenceEvidence.rotation !== productEvidence.rotation
              || canonical(referenceEvidence.page_box) !== canonical(productEvidence.page_box)
              || intersectionOverUnion(referenceEvidence.region, productEvidence.display_region) < 0.5) return false;
            return referenceFacet.channel === "visual"
              || referenceFacet.channel === "metadata"
              || referenceEvidence.value_sha256 === productEvidence.value_sha256;
          });
      });
    });
    if (!match) throw new Error(`compare_pdfs did not support canonical event ${referenceEvent.id}`);
    unusedChanges.delete(match);
  }
  if (unusedChanges.size > 0) throw new Error("compare_pdfs produced unsupported extra events");
}

export async function buildProductPrimitiveReport({
  benchmarkId,
  benchmarkVersion,
  renderer,
  pairs,
  repositoryRoot,
  allowedDirectory = path.dirname(pairs[0].beforePath),
  host,
}) {
  if (typeof host !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(host)) {
    throw new Error("Product report requires an explicit public-safe host label");
  }
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
      let product;
      const timingSamples = [];
      const iterationCosts = [];
      let warmupMs = 0;
      let warmupCost;
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const started = performance.now();
        const candidate = toolFailed(await client.callTool({
          name: "compare_pdfs",
          arguments: {
            before_pdf_path: pair.beforePath,
            after_pdf_path: pair.afterPath,
            mode: "default_material",
            max_pages: 20,
            include_visual: true,
            max_output_characters: 200_000,
          },
        }), "compare_pdfs").structuredContent;
        const elapsed = performance.now() - started;
        const candidateCost = {
          tool_calls: 1,
          logical_input_bytes: candidate.resource_usage.source_bytes,
          rendered_pixels: candidate.resource_usage.rendered_pixels,
          peak_rss_bytes: null,
        };
        if (iteration === 0) {
          product = candidate;
          warmupMs = elapsed;
          warmupCost = candidateCost;
        } else {
          if (candidate.comparison_sha256 !== product.comparison_sha256) {
            throw new Error(`compare_pdfs was nondeterministic for ${pair.pairId}`);
          }
          timingSamples.push(elapsed);
          iterationCosts.push(candidateCost);
        }
      }
      const [before, after] = await Promise.all([
        inspectComparisonDocument(pair.beforePath, renderer),
        inspectComparisonDocument(pair.afterPath, renderer),
      ]);
      const sourceHashes = await Promise.all([
        fs.readFile(pair.beforePath).then(digest),
        fs.readFile(pair.afterPath).then(digest),
      ]);
      const built = buildComparisonPairFromInspections({
        pairId: pair.pairId,
        before,
        after,
        renderer,
        timingSamples,
        warmupMs,
        warmupCost,
        iterationCosts,
        peakRss: null,
        resourceMeasurementStatus: "unavailable",
        capture: "oracle_calibration",
        channelStatus: Object.fromEntries(COMPARISON_CHANNELS.map(channel => [
          channel,
          product.coverage[channel].status === "supported" ? "supported" : "unavailable",
        ])),
      });
      const report = built.pairReport;
      assertProductMatchesCanonicalAdapter(product, report);
      controllerRecords.push(...built.controllerRecords);
      report.source_immutable = sourceHashes[0] === report.before_sha256
        && sourceHashes[1] === report.after_sha256
        && product.source_immutability.before.unchanged
        && product.source_immutability.after.unchanged;
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
    claim_boundary: "Synthetic seven-pair calibration of compare_pdfs event, facet, alignment, presentation, immutability, and direct evidence-region output. The frozen v1 scorer requires its scale-2 canonical renderer, so visual and metadata evidence are evaluator-normalized only after the product output passes source, page, region-IoU, operation, salience, disposition, and nonvisual-value gates. This is not direct product evidence completeness, a packed MCPB test, a native Claude Desktop test, or a benchmark/general-accuracy claim.",
    benchmark_claim_ready: false,
    engine: {
      id: "pdf-tools-compare-pdfs-v1-adapter",
      kind: "pdf_tools_mcp",
      version: packageJson.version,
      license: packageJson.license ?? "MIT",
      provenance: "repository server/index.js compare_pdfs output gated before frozen-v1 evaluator normalization; repository source runtime, not a packed MCPB",
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
      host,
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
