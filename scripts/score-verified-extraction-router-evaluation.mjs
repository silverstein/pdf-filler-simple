import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { readSourceBoundDocumentChunk } from "../server/document-map.js";
import {
  buildSourceReplayScoringBindings,
  scoreSourceReplayResult,
} from "./verified-extraction-source-replay-scorer.mjs";

const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha256 = value => createHash("sha256").update(value).digest("hex");

function assertion(condition, message) {
  if (!condition) throw new Error(`Private evidence-router scoring failed: ${message}`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assertion(/^--[a-z-]+$/u.test(key ?? "") && typeof value === "string",
      "arguments must be --key value pairs");
    assertion(!values.has(key), `duplicate argument ${key}`);
    values.set(key, value);
  }
  const expected = ["--admission-root", "--contract-root", "--corpus-root", "--evaluation",
    "--oracles-root", "--output", "--state-root"];
  assertion(canonicalJson([...values.keys()].sort()) === canonicalJson(expected),
    `exactly ${expected.join(", ")} are required`);
  return Object.fromEntries([...values].map(([key, value]) => [key.slice(2).replaceAll("-", "_"),
    path.resolve(value)]));
}

async function readPhysicalFile(filePath) {
  const before = await fsp.lstat(filePath);
  assertion(before.isFile() && !before.isSymbolicLink(), `${filePath} must be a physical file`);
  const bytes = await fsp.readFile(filePath);
  const after = await fsp.lstat(filePath);
  assertion(before.dev === after.dev && before.ino === after.ino && before.size === after.size,
    `${filePath} changed while being read`);
  return bytes;
}

async function readJson(filePath) {
  return JSON.parse((await readPhysicalFile(filePath)).toString("utf8"));
}

async function readLayouts(documentDirectory) {
  const entries = await fsp.readdir(path.join(documentDirectory, "layouts"), {
    withFileTypes: true,
  });
  const names = entries.filter(entry => entry.isFile()
    && /^page-[0-9]{5}\.layout\.json$/u.test(entry.name)).map(entry => entry.name).sort();
  assertion(names.length > 0, `${documentDirectory} has no retained layouts`);
  return Promise.all(names.map(name => readJson(path.join(documentDirectory, "layouts", name))));
}

async function loadDocumentScoringContext({ args, documentId, register, schemaBytes }) {
  const admitted = register.documents.find(item => item.id === documentId);
  assertion(admitted, `${documentId} is absent from the admission register`);
  const documentDirectory = path.join(args.state_root, documentId);
  const [documentMap, sourceBytes, layouts] = await Promise.all([
    readJson(path.join(documentDirectory, "document-map.v1.json")),
    readPhysicalFile(admitted.artifacts.pdf.path),
    readLayouts(documentDirectory),
  ]);
  assertion(sha256(sourceBytes) === admitted.artifacts.pdf.sha256,
    `${documentId} PDF bytes drifted`);
  const documentChunks = documentMap.chunks.descriptors.map((descriptor, index) => {
    const chunk = readSourceBoundDocumentChunk({
      documentMap,
      chunkId: descriptor.chunk_id,
      sourceBytes,
      schemaBytes,
      layouts,
    });
    return {
      document_id: documentId,
      chunk_id: chunk.chunk_id,
      page_range: chunk.page_range,
      starts_at_heading: descriptor.starts_at_heading,
      content: chunk.content,
      content_sha256: chunk.content_sha256,
    };
  });
  return { documentMap, documentChunks };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const [evaluationBytes, semantics, corpusManifest, oracleManifest, register, schemaBytes] = await Promise.all([
    readPhysicalFile(args.evaluation),
    readJson(path.join(args.contract_root, "task-semantics.v2.json")),
    readJson(path.join(args.corpus_root, "corpus-source-bundle-manifest.v1.json")),
    readJson(path.join(args.oracles_root, "source-replay-oracle-manifest.v2.json")),
    readJson(path.join(args.admission_root, "admission-register.v1.json")),
    readPhysicalFile(path.join(args.admission_root, "schema.v1.json")),
  ]);
  const evaluation = JSON.parse(evaluationBytes.toString("utf8"));
  assertion(evaluation.mode === "project-completed"
    && evaluation.oracle_accessed === false && evaluation.model_or_provider_calls_made === 0,
    "input evaluation must be a frozen zero-inference, no-oracle projection");
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const corpusById = new Map(corpusManifest.documents.map(item => [item.document_id, item]));
  const oracleById = new Map(oracleManifest.documents.map(item => [item.document_id, item]));
  const rows = [];
  for (const evaluated of evaluation.documents.filter(item => item.canonical_projection !== null)) {
    const corpusArtifact = corpusById.get(evaluated.document_id);
    const oracleArtifact = oracleById.get(evaluated.document_id);
    assertion(corpusArtifact && oracleArtifact, `${evaluated.document_id} is absent from a sealed input`);
    const [sourceBytes, oracleBytes] = await Promise.all([
      readPhysicalFile(path.join(args.corpus_root, corpusArtifact.path)),
      readPhysicalFile(path.join(args.oracles_root, oracleArtifact.path)),
    ]);
    assertion(sha256(sourceBytes) === corpusArtifact.sha256,
      `${evaluated.document_id} source bundle drifted`);
    assertion(sha256(oracleBytes) === oracleArtifact.sha256,
      `${evaluated.document_id} truth oracle drifted`);
    const sourceBundle = JSON.parse(sourceBytes.toString("utf8"));
    const { documentMap, documentChunks } = await loadDocumentScoringContext({
      args,
      documentId: evaluated.document_id,
      register,
      schemaBytes,
    });
    const bindings = buildSourceReplayScoringBindings({
      documentId: evaluated.document_id,
      documentMapSha256: documentMap.document_map_sha256,
      schemaBytes,
      sourceBundle,
      documentChunks,
    });
    const score = scoreSourceReplayResult({
      bindings,
      schema,
      schemaBytes,
      semantics,
      sourceBundle,
      documentChunks,
      truthOracle: JSON.parse(oracleBytes.toString("utf8")),
      result: evaluated.canonical_projection.result,
      citations: evaluated.canonical_projection.citations,
    });
    rows.push({
      document_id: evaluated.document_id,
      projection_sha256: evaluated.canonical_projection.projection_sha256,
      score,
    });
  }
  const exactWindowNumerator = rows.reduce((sum, row) => (
    sum + row.score.exact_oracle_window_secondary_diagnostic.numerator
  ), 0);
  const exactWindowDenominator = rows.reduce((sum, row) => (
    sum + row.score.exact_oracle_window_secondary_diagnostic.denominator
  ), 0);
  const body = {
    version: 1,
    qualification: "private_offline_source_replay_router_projection_score",
    inputs: {
      evaluation_file_sha256: sha256(evaluationBytes),
      evaluation_report_sha256: evaluation.report_sha256,
      source_replay_contract_seal_sha256: (await readJson(path.join(args.contract_root,
        "contract-seal.v1.json"))).contract_seal_sha256,
      source_replay_scorer_sha256: sha256(await readPhysicalFile(new URL(
        "./verified-extraction-source-replay-scorer.mjs", import.meta.url))),
      schema_sha256: sha256(schemaBytes),
      corpus_manifest_sha256: corpusManifest.corpus_source_bundle_manifest_sha256,
      oracle_manifest_sha256: oracleManifest.source_replay_oracle_manifest_sha256,
    },
    aggregate: {
      scored_documents: rows.length,
      semantic_result_valid_documents: rows.filter(row => row.score.semantic_result_valid).length,
      deterministic_failures: rows.filter(row => row.score.deterministic_failure).length,
      source_replay_citations: rows.reduce((sum, row) => (
        sum + row.score.source_replay_citations.numerator
      ), 0),
      source_replay_citation_obligations: rows.reduce((sum, row) => (
        sum + row.score.source_replay_citations.denominator
      ), 0),
      exact_oracle_window_secondary_diagnostic: {
        numerator: exactWindowNumerator,
        denominator: exactWindowDenominator,
        rate: exactWindowDenominator === 0 ? null : exactWindowNumerator / exactWindowDenominator,
      },
    },
    documents: rows,
    oracle_accessed: true,
    model_or_provider_calls_made: 0,
    public_claim_authorized: false,
    benchmark_claim_ready: false,
  };
  const report = { ...body, report_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")) };
  const handle = await fsp.open(args.output, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, report_sha256: report.report_sha256,
    aggregate: report.aggregate })}\n`);
}

await main();
