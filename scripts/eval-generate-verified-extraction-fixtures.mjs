#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "test", "fixtures", "eval", "verified-extraction");
const FIXED_DATE = new Date("2026-08-20T00:00:00.000Z");
const PAGE_SIZE = [612, 792];
const LICENSE = "MIT";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function configureMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic long-document verified extraction benchmark; contains no personal data");
  pdf.setCreator("scripts/eval-generate-verified-extraction-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
}

function drawPage(page, fonts, pageNumber, totalPages, title, lines) {
  page.drawText(title, { x: 54, y: 742, size: 16, font: fonts.bold, color: rgb(0.08, 0.08, 0.08) });
  page.drawText(`SYNTHETIC BENCHMARK | PAGE ${pageNumber} OF ${totalPages}`, {
    x: 54, y: 718, size: 8, font: fonts.regular, color: rgb(0.35, 0.35, 0.35),
  });
  let y = 682;
  for (const line of lines) {
    page.drawText(line, { x: 54, y, size: 10.5, font: fonts.regular, color: rgb(0.08, 0.08, 0.08) });
    y -= 20;
  }
  page.drawText("ODA-SYNTHETIC-VERIFIED-EXTRACTION", {
    x: 54, y: 32, size: 7, font: fonts.regular, color: rgb(0.45, 0.45, 0.45),
  });
}

async function createLongPdf(title, pageCount, pageLines) {
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, title);
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = pdf.addPage(PAGE_SIZE);
    drawPage(page, fonts, pageNumber, pageCount, title, pageLines(pageNumber));
  }
  return pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
  });
}

function quote(page, text) {
  return { page, quote: text };
}

const FIXTURES = [
  {
    id: "nested-ledger-120",
    filename: "nested-ledger-120.pdf",
    pages: 120,
    split: "development",
    description: "Nested account ledger with sparse authoritative values and superseded decoys.",
    schema: {
      type: "object",
      required: ["account", "reporting", "limits", "contacts"],
      properties: {
        account: { type: "object", required: ["id", "name", "status"], properties: {
          id: { type: "string" }, name: { type: "string" }, status: { type: "string", enum: ["active", "inactive"] },
        } },
        reporting: { type: "object", required: ["period_start", "period_end", "currency"], properties: {
          period_start: { type: "string", format: "date" }, period_end: { type: "string", format: "date" }, currency: { type: "string" },
        } },
        limits: { type: "object", required: ["annual", "per_event", "deductible"], properties: {
          annual: { type: "number" }, per_event: { type: "number" }, deductible: { type: "number" },
        } },
        contacts: { type: "object", required: ["primary", "billing"], properties: {
          primary: { type: "object", required: ["name", "role"], properties: { name: { type: "string" }, role: { type: "string" } } },
          billing: { type: "object", required: ["name", "role"], properties: { name: { type: "string" }, role: { type: "string" } } },
        } },
      },
    },
    truth: {
      account: { id: "ACCT-8042", name: "Northstar Fabrication", status: "active" },
      reporting: { period_start: "2026-01-01", period_end: "2026-12-31", currency: "USD" },
      limits: { annual: 2750000, per_event: 625000, deductible: 18000 },
      contacts: { primary: { name: "Avery Stone", role: "Operations" }, billing: { name: "Jordan Vale", role: "Finance" } },
    },
    citations: {
      "account.id": quote(2, "Account ID: ACCT-8042"),
      "account.name": quote(2, "Legal name: Northstar Fabrication"),
      "account.status": quote(119, "FINAL ACCOUNT STATUS: active"),
      "reporting.period_start": quote(17, "Reporting period start: 2026-01-01"),
      "reporting.period_end": quote(17, "Reporting period end: 2026-12-31"),
      "reporting.currency": quote(17, "Reporting currency: USD"),
      "limits.annual": quote(74, "AMENDED annual limit: USD 2750000"),
      "limits.per_event": quote(74, "AMENDED per-event limit: USD 625000"),
      "limits.deductible": quote(41, "Current deductible: USD 18000"),
      "contacts.primary.name": quote(53, "Primary contact: Avery Stone"),
      "contacts.primary.role": quote(53, "Primary role: Operations"),
      "contacts.billing.name": quote(91, "Billing contact: Jordan Vale"),
      "contacts.billing.role": quote(91, "Billing role: Finance"),
    },
  },
  {
    id: "keyed-register-96",
    filename: "keyed-register-96.pdf",
    pages: 96,
    split: "development",
    description: "Keyed array register with 24 final rows and draft-row decoys.",
    schema: {
      type: "object",
      required: ["register_id", "items"],
      properties: {
        register_id: { type: "string" },
        items: {
          type: "array",
          minItems: 24,
          maxItems: 24,
          "x-key": "item_id",
          items: {
            type: "object",
            required: ["item_id", "category", "quantity"],
            properties: {
              item_id: { type: "string" },
              category: { type: "string", enum: ["alpha", "beta", "gamma"] },
              quantity: { type: "integer" },
            },
          },
        },
      },
    },
    truth: {
      register_id: "REG-2026-024",
      items: Array.from({ length: 24 }, (_, index) => ({
        item_id: `ITEM-${String(index + 1).padStart(3, "0")}`,
        category: ["alpha", "beta", "gamma"][index % 3],
        quantity: (index + 1) * 7,
      })),
    },
    citations: Object.fromEntries([
      ["register_id", quote(3, "Register ID: REG-2026-024")],
      ...Array.from({ length: 24 }, (_, index) => {
        const item = index + 1;
        const page = 61 + index;
        const category = ["alpha", "beta", "gamma"][index % 3];
        return [`items[item_id=ITEM-${String(item).padStart(3, "0")}]`, quote(page,
          `FINAL ITEM-${String(item).padStart(3, "0")} | category=${category} | quantity=${item * 7}`)];
      }),
    ]),
  },
  {
    id: "citation-calculation-72",
    filename: "citation-calculation-72.pdf",
    pages: 72,
    split: "held_out_calibration",
    description: "Sparse regional values with replayable citations and a deterministic calculation.",
    schema: {
      type: "object",
      required: ["report_id", "regions", "grand_total"],
      properties: {
        report_id: { type: "string" },
        regions: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          "x-key": "code",
          items: {
            type: "object",
            required: ["code", "units", "adjustment"],
            properties: {
              code: { type: "string" }, units: { type: "integer" }, adjustment: { type: "number" },
            },
          },
        },
        grand_total: { type: "number" },
      },
    },
    truth: {
      report_id: "RPT-SUM-903",
      regions: [
        { code: "NORTH", units: 128, adjustment: 2.5 },
        { code: "CENTRAL", units: 244, adjustment: -1.5 },
        { code: "SOUTH", units: 319, adjustment: 4 },
      ],
      grand_total: 696,
    },
    citations: {
      report_id: quote(1, "Report ID: RPT-SUM-903"),
      "regions[code=NORTH]": quote(13, "REGION NORTH | units=128 | adjustment=2.5"),
      "regions[code=CENTRAL]": quote(37, "REGION CENTRAL | units=244 | adjustment=-1.5"),
      "regions[code=SOUTH]": quote(64, "REGION SOUTH | units=319 | adjustment=4"),
      grand_total: quote(71, "VERIFIED GRAND TOTAL: 696"),
    },
    calculations: [{
      output_path: "grand_total",
      operation: "sum",
      operands: [
        "regions[code=NORTH].units", "regions[code=NORTH].adjustment",
        "regions[code=CENTRAL].units", "regions[code=CENTRAL].adjustment",
        "regions[code=SOUTH].units", "regions[code=SOUTH].adjustment",
      ],
      expected: 696,
    }],
  },
];

function pageLinesFor(fixture, pageNumber) {
  const filler = [
    `Section ${String(Math.ceil(pageNumber / 8)).padStart(2, "0")} supporting narrative.`,
    `Record locator: ${fixture.id}/page-${String(pageNumber).padStart(3, "0")}.`,
    "This page is synthetic and intentionally contains no personal data.",
  ];
  if (fixture.id === "nested-ledger-120") {
    const special = {
      2: ["Account ID: ACCT-8042", "Legal name: Northstar Fabrication"],
      17: ["Reporting period start: 2026-01-01", "Reporting period end: 2026-12-31", "Reporting currency: USD"],
      41: ["Current deductible: USD 18000"],
      53: ["Primary contact: Avery Stone", "Primary role: Operations"],
      74: ["AMENDED annual limit: USD 2750000", "AMENDED per-event limit: USD 625000"],
      91: ["Billing contact: Jordan Vale", "Billing role: Finance"],
      119: ["FINAL ACCOUNT STATUS: active"],
    };
    if (pageNumber === 22) filler.push("SUPERSEDED DRAFT annual limit: USD 2500000");
    if (pageNumber === 23) filler.push("SUPERSEDED DRAFT account status: inactive");
    return [...(special[pageNumber] || []), ...filler];
  }
  if (fixture.id === "keyed-register-96") {
    if (pageNumber === 3) return ["Register ID: REG-2026-024", ...filler];
    if (pageNumber >= 61 && pageNumber <= 84) {
      const item = pageNumber - 60;
      const category = ["alpha", "beta", "gamma"][(item - 1) % 3];
      return [`FINAL ITEM-${String(item).padStart(3, "0")} | category=${category} | quantity=${item * 7}`, ...filler];
    }
    if (pageNumber >= 20 && pageNumber <= 43) {
      const item = pageNumber - 19;
      return [`DRAFT ITEM-${String(item).padStart(3, "0")} | quantity=${item * 5} | NOT AUTHORITATIVE`, ...filler];
    }
    return filler;
  }
  const special = {
    1: ["Report ID: RPT-SUM-903"],
    13: ["REGION NORTH | units=128 | adjustment=2.5"],
    37: ["REGION CENTRAL | units=244 | adjustment=-1.5"],
    64: ["REGION SOUTH | units=319 | adjustment=4"],
    71: ["VERIFIED GRAND TOTAL: 696", "Calculation: 128 + 2.5 + 244 - 1.5 + 319 + 4 = 696"],
  };
  return [...(special[pageNumber] || []), ...filler];
}

function schemaLeafCount(schema, value) {
  if (schema.type === "object") {
    return Object.entries(schema.properties || {}).reduce(
      (sum, [key, child]) => sum + schemaLeafCount(child, value?.[key]), 0,
    );
  }
  if (schema.type === "array") {
    return Array.isArray(value)
      ? value.reduce((sum, item) => sum + schemaLeafCount(schema.items, item), 0)
      : 0;
  }
  return 1;
}

const BASELINE_PROTOCOL = Object.freeze({
  id: "current-tools-agent-workflow.v1",
  product_ref: "exact_baseline_identity_frozen_before_baseline_with_external_preflight_required",
  allowed_product_tools: [
    "read_pdf_content", "read_pdf_layout", "convert_pdf_to_markdown", "display_pdf", "get_pdf_resource_uri",
  ],
  orchestration: "Host agent may maintain bounded scratch state and merge partial results; no hidden retrieval or extraction service is allowed.",
  requirements: [
    "Use the same admitted PDF bytes and schema bytes as the paired candidate run.",
    "Record model, host, settings, tool calls, token accounting, latency, retry count, and cost basis.",
    "Bind baseline execution and results to the immutable comparison authority, including its exact baseline Git/tree or package identity.",
    "Freeze the full campaign denominator and shared execution dimensions before baseline while candidate product identity remains pending implementation.",
    "Return one final JSON value plus source citations; do not consult truth or citation oracle files.",
  ],
});

const CANDIDATE_PROTOCOL = Object.freeze({
  id: "verified-extraction-workspace.v1-preregistered",
  implementation_state: "not_implemented_at_freeze",
  allowed_capabilities: [
    "source-bound document map", "stable bounded chunks", "persistent local intermediate state",
    "paginated results", "typed uncertainty", "deterministic citation and calculation replay",
  ],
  forbidden_capabilities: [
    "model inside MCP server", "numeric confidence", "truth-oracle access", "unreported provider egress", "silent truncation",
  ],
  pairing: "After implementation but before candidate execution, add a subordinate candidate execution authority with exact product identity. It binds the unchanged pre-baseline comparison digest and inherits all shared dimensions, protocols, scorer, retry policy, and denominator without rewriting baseline evidence.",
});

const SCORING_POLICY = Object.freeze({
  id: "verified-extraction-deterministic-primary.v1",
  primary_metrics: [
    "json_schema_valid", "leaf_precision", "leaf_recall", "keyed_array_precision", "keyed_array_recall",
    "citation_replay_rate", "calculation_replay_rate", "silent_omission_count", "truncation_count",
  ],
  exact_comparison: "Strings, booleans, nulls, array keys, and numbers compare exactly; no semantic equivalence or tolerance is inferred.",
  denominator_rule: "Per-document and campaign-wide denominators are computed from the frozen manifest, truth, and citation oracle files, never from candidate output; harness-only trials retain full obligations with zero numerators.",
  zero_denominator_rule: "A rate with denominator zero is null (not applicable) and must be excluded from macro averages, never treated as 100 percent.",
  model_judge: "Secondary qualitative analysis only. It cannot change, excuse, or override a deterministic failure.",
  harness_failures: [
    "source_binding_mismatch", "schema_binding_mismatch", "model_binding_missing", "host_binding_missing",
    "product_identity_mismatch", "campaign_binding_mismatch", "timeout", "tool_transport_error", "provider_error",
    "malformed_run_record", "scorer_error",
  ],
  product_failures: [
    "schema_invalid", "wrong_value", "missing_leaf", "extra_leaf", "array_key_missing", "array_key_duplicate",
    "citation_missing", "citation_not_replayable", "extra_citation", "calculation_mismatch", "silent_truncation",
  ],
});

const HOLDOUT_POLICY = Object.freeze({
  id: "verified-extraction-holdout.v1",
  development_documents: ["nested-ledger-120", "keyed-register-96"],
  held_out_calibration_documents: ["citation-calculation-72"],
  rule: "Truth and citation oracles are validator-only. Workflow authors may inspect development PDFs and schemas but must not inspect held-out truth before both protocols and scorer bindings are frozen.",
  comparison_rule: "A pre-baseline comparison authority freezes every admitted document, role, trial, attempt slot, protocol, scorer, shared execution dimension, and the exact baseline product identity while candidate identity remains pending. Report every slot and aggregate outcome; do not tune against held-out output, replace failed product runs, substitute attempts, or omit admitted documents or failures.",
});

const CLAIM_BOUNDARY = Object.freeze({
  benchmark_claim_ready: false,
  classification: "private_synthetic_calibration_only",
  allowed: [
    "Internal deterministic regression gating on the exact admitted bytes.",
    "A private paired baseline-versus-candidate report with all execution bindings and limitations.",
  ],
  prohibited: [
    "A public benchmark or state-of-the-art claim.",
    "A claim about real-world documents, providers, or model quality.",
    "Converting deterministic results into numeric confidence scores.",
  ],
});

async function writeArtifact(outputDir, relativePath, bytes) {
  const target = path.join(outputDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return {
    path: relativePath,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export async function generateVerifiedExtractionFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const documents = [];
  for (const fixture of FIXTURES) {
    const pdfBytes = await createLongPdf(
      `Verified extraction fixture: ${fixture.id}`,
      fixture.pages,
      pageNumber => pageLinesFor(fixture, pageNumber),
    );
    const schemaBytes = Buffer.from(stableJson({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:oda:verified-extraction:${fixture.id}:schema:v1`,
      ...fixture.schema,
      additionalProperties: false,
    }));
    const truthBytes = Buffer.from(stableJson(fixture.truth));
    const citationBytes = Buffer.from(stableJson({
      document_id: fixture.id,
      citations: fixture.citations,
      calculations: fixture.calculations || [],
    }));
    const artifacts = {
      pdf: await writeArtifact(outputDir, `documents/${fixture.filename}`, pdfBytes),
      schema: await writeArtifact(outputDir, `schemas/${fixture.id}.schema.json`, schemaBytes),
      truth: await writeArtifact(outputDir, `oracles/${fixture.id}.truth.json`, truthBytes),
      citations: await writeArtifact(outputDir, `oracles/${fixture.id}.citations.json`, citationBytes),
    };
    documents.push({
      id: fixture.id,
      split: fixture.split,
      description: fixture.description,
      page_count: fixture.pages,
      rights: {
        admitted: true,
        license: LICENSE,
        author: "Open Document Alliance PDF Tools maintainers",
        source: "Deterministically generated in this repository; no third-party source document bytes.",
        personal_data: false,
      },
      artifacts,
      deterministic_denominators: {
        leaf_values: schemaLeafCount(fixture.schema, fixture.truth),
        citation_obligations: Object.keys(fixture.citations).length,
        keyed_array_items: fixture.truth.items?.length || fixture.truth.regions?.length || 0,
        calculations: fixture.calculations?.length || 0,
      },
    });
  }

  const protocolBindings = Object.fromEntries([
    ["baseline", BASELINE_PROTOCOL], ["candidate", CANDIDATE_PROTOCOL], ["scoring", SCORING_POLICY], ["holdout", HOLDOUT_POLICY],
  ].map(([key, value]) => [key, { value, sha256: sha256(Buffer.from(stableJson(value))) }]));
  const totals = documents.reduce((result, document) => {
    result.documents += 1;
    result.pages += document.page_count;
    for (const key of ["leaf_values", "citation_obligations", "keyed_array_items", "calculations"]) {
      result[key] += document.deterministic_denominators[key];
    }
    return result;
  }, { documents: 0, pages: 0, leaf_values: 0, citation_obligations: 0, keyed_array_items: 0, calculations: 0 });
  const scriptBytes = await fs.readFile(fileURLToPath(import.meta.url));
  const scorerPath = "test/eval/verified-extraction-contract.js";
  const scorerBytes = await fs.readFile(path.join(REPO_ROOT, scorerPath));
  const manifest = {
    manifest_version: 1,
    benchmark_id: "oda-verified-extraction-synthetic-v1",
    frozen_at: FIXED_DATE.toISOString(),
    generator: { path: "scripts/eval-generate-verified-extraction-fixtures.mjs", sha256: sha256(scriptBytes) },
    scorer: { path: scorerPath, sha256: sha256(scorerBytes) },
    schema_subset: [
      "object", "array", "string", "number", "integer", "boolean", "null", "required", "properties",
      "additionalProperties", "enum", "format:date", "items", "minItems", "maxItems", "x-key",
    ],
    documents,
    deterministic_denominators: totals,
    protocols: protocolBindings,
    run_plan_admission: {
      comparison_contract_id: "verified-extraction-comparison-authority.v1",
      candidate_execution_contract_id: "verified-extraction-candidate-execution-authority.v1",
      measured_campaigns_authorized: 0,
      state: "no_measured_execution_authorized",
      rule: "This benchmark manifest authorizes no model or provider execution. Before baseline, one immutable comparison authority must bind the exact manifest, baseline product identity, both frozen protocols, scorer, shared model/host/settings/budgets, full admitted document set, every trial and attempt slot, retry budget, and no-product-replacement policy while candidate identity is pending. After candidate implementation but before candidate execution, a subordinate authority adds the exact candidate product identity without changing the comparison digest. Aggregate verification requires both role authorities and every planned slot.",
    },
    product_identity_qualification: {
      scheme: "pdf-tools-product-identity.v1",
      contract_validation: "syntactic_shape_and_immutable_binding_only",
      independent_observation_required: true,
      execution_gate: "e9e.2_real_git_or_package_preflight_required",
      source_preflight: "Independently verify the commit exists, its Git tree matches the recorded git_tree, and the observed clean execution tree is that tree.",
      package_preflight: "Independently verify the commit exists and observer-computed SHA-256 of the exact executed package bytes matches artifact_sha256.",
      limitation: "Contract validation alone does not prove that a Git object or package exists or that the bound identity was actually exercised.",
    },
    claim_boundary: CLAIM_BOUNDARY,
    external_candidates: [
      {
        name: "VAREX", url: "https://huggingface.co/datasets/ibm-research/VAREX", admitted: false,
        reason: "Permissively licensed, but the published form/image task is not the long-document paired workload frozen here.",
      },
      {
        name: "RealDoc-Bench", url: "https://huggingface.co/datasets/Extend-AI/RealDoc-Bench", admitted: false,
        reason: "Dataset annotations are CC-BY-4.0, while source-document licenses and takedown status require per-document admission review.",
      },
      {
        name: "LongExtractBench-50", url: "https://huggingface.co/datasets/micro1-inc/longextract-bench-50", admitted: false,
        reason: "Source PDFs retain their original rights; individual document terms have not been admitted or downloaded.",
      },
    ],
  };
  await fs.writeFile(path.join(outputDir, "manifest.v1.json"), stableJson(manifest));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.indexOf("--output-dir");
  const outputDir = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : DEFAULT_OUTPUT_DIR;
  const manifest = await generateVerifiedExtractionFixtures(outputDir);
  process.stdout.write(`${JSON.stringify({ output_dir: outputDir, ...manifest.deterministic_denominators })}\n`);
}
