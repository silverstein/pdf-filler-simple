import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  rowRunnerV4Internals,
} from "./helpers/deep-malformed-row-runner-v4.js";

function limits(overrides = {}) {
  return {
    inventory_entries: 64,
    per_file_bytes: 1024 * 1024,
    aggregate_inventory_bytes: 2 * 1024 * 1024,
    response_nodes: 10_000,
    response_bytes: 1024 * 1024,
    scanner_string_bytes: 1024 * 1024,
    ...overrides,
  };
}

async function withTemporaryRoot(label, callback) {
  const canonicalTemporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(canonicalTemporary, `${label}-`));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("portable canonical JSON remains ordered and byte bounded", () => {
  const bytes = rowRunnerV4Internals.boundedCanonicalJsonBytes(
    { z: [true, null], a: "value" },
    64,
  );
  assert.equal(bytes.toString("utf8"), '{"a":"value","z":[true,null]}');
  assert.throws(
    () => rowRunnerV4Internals.boundedCanonicalJsonBytes(
      { z: [true, null], a: "value" },
      bytes.length - 1,
    ),
    /byte ceiling/,
  );

  let deeplyNested = 0;
  for (let depth = 0; depth < 20_000; depth += 1) {
    deeplyNested = [deeplyNested];
  }
  const nestedBytes = rowRunnerV4Internals.boundedCanonicalJsonBytes(
    deeplyNested,
    50_000,
  );
  assert.equal(nestedBytes.length, 40_001);
});

test("portable scanner substitutes exact Windows arguments and rejects leaks", () => {
  const inputPath = "C:\\Users\\example\\Documents\\input.pdf";
  const safe = rowRunnerV4Internals.scanStringLeaves(
    {
      content: [{
        type: "text",
        text: `Input: ${inputPath}.`,
      }],
      structuredContent: {
        pdf_path: inputPath,
      },
    },
    [{ label: "input-argument", path: inputPath }],
    limits(),
  );
  assert.equal(safe.pass, true);
  assert.equal(safe.raw_internal_matches, 0);
  assert.deepEqual(
    safe.allowed_path_substitutions.map(row => ({
      label: row.label,
      uses: row.uses,
    })),
    [{ label: "input-argument", uses: 2 }],
  );

  const leaked = rowRunnerV4Internals.scanStringLeaves(
    {
      content: [{
        type: "text",
        text: "Internal source: C:\\private\\secret.pdf",
      }],
    },
    [],
    limits(),
  );
  assert.equal(leaked.pass, false);
  assert.equal(leaked.raw_internal_matches, 1);
});

test("portable scanner rejects descendants, suffixes, stack paths, and path keys", () => {
  const directory = "C:\\Users\\example\\Campaign\\split";
  const input = "C:\\Users\\example\\Campaign\\input.pdf";
  const paths = [
    { label: "input-argument", path: input },
    { label: "split-output-argument", path: directory },
  ];
  const rejectedValues = [
    { structuredContent: { descendant: `${directory}\\nested.pdf` } },
    { structuredContent: { suffix: `${input}.bak` } },
    { structuredContent: { stack: `${input}:12:4` } },
    { structuredContent: { [input]: "path-bearing keys are forbidden" } },
    { content: [{ type: "text", text: "at parse (node:internal/modules/esm:1:2)" }] },
  ];
  for (const value of rejectedValues) {
    const rejected = rowRunnerV4Internals.scanStringLeaves(
      value,
      paths,
      limits(),
    );
    assert.equal(rejected.pass, false);
    assert.ok(rejected.raw_internal_matches >= 1);
  }
});

test("portable normalized digest ignores only exact path relocation", () => {
  function plannedPaths(run) {
    const root = `C:\\Users\\example\\${run}`;
    return [
      { label: "input-argument", path: `${root}\\input.pdf` },
      { label: "output-argument", path: `${root}\\output.pdf` },
    ];
  }
  function response(paths, message = "Completed") {
    return {
      content: [{ type: "text", text: `${message}: ${paths[0].path}.` }],
      structuredContent: {
        input: paths[0].path,
        output: paths[1].path,
      },
      isError: false,
    };
  }
  const pathsA = plannedPaths("RunAlpha");
  const pathsB = plannedPaths("RunBravo");
  const summaryA = rowRunnerV4Internals.responseSummary(
    response(pathsA),
    pathsA,
    limits(),
  );
  const summaryB = rowRunnerV4Internals.responseSummary(
    response(pathsB),
    pathsB,
    limits(),
  );
  assert.notEqual(summaryA.sha256, summaryB.sha256);
  assert.deepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );
  const changed = rowRunnerV4Internals.responseSummary(
    response(pathsB, "Materially different"),
    pathsB,
    limits(),
  );
  assert.notDeepEqual(
    summaryA.scanner.normalized_response,
    changed.scanner.normalized_response,
  );
});

test("portable normalization excludes only a fresh exact-path view UUID", () => {
  function response(viewUUID, extra = {}) {
    return {
      content: [{ type: "text", text: "PDF has 0 form fields" }],
      structuredContent: { fieldCount: 0, ...extra },
      _meta: { viewUUID },
    };
  }
  const epochA = 1_785_349_626_000;
  const epochB = 1_785_349_627_000;
  const clock = epoch => ({ start_ms: epoch - 100, end_ms: epoch + 100 });
  const summaryA = rowRunnerV4Internals.responseSummary(
    response("pdf-1785349626000-abc123"),
    [],
    limits(),
    "read_pdf_fields",
    clock(epochA),
  );
  const summaryB = rowRunnerV4Internals.responseSummary(
    response("pdf-1785349627000-def456"),
    [],
    limits(),
    "read_pdf_fields",
    clock(epochB),
  );
  assert.deepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );
  assert.deepEqual(
    summaryA.scanner.response_normalization.excluded_fields,
    ["/_meta/viewUUID"],
  );
  const retainedA = rowRunnerV4Internals.responseSummary(
    response("pdf-1785349626000-abc123", { viewUUID: "literal-a" }),
    [],
    limits(),
    "read_pdf_fields",
    clock(epochA),
  );
  const retainedB = rowRunnerV4Internals.responseSummary(
    response("pdf-1785349626000-abc123", { viewUUID: "literal-b" }),
    [],
    limits(),
    "read_pdf_fields",
    clock(epochA),
  );
  assert.notDeepEqual(
    retainedA.scanner.normalized_response,
    retainedB.scanner.normalized_response,
  );
  assert.throws(
    () => rowRunnerV4Internals.responseSummary(
      response("pdf-invalid"),
      [],
      limits(),
      "read_pdf_fields",
      clock(epochA),
    ),
    /absent or invalid/,
  );
  assert.throws(
    () => rowRunnerV4Internals.responseSummary(
      response("pdf-1785349626000-abc123"),
      [],
      limits(),
      "read_pdf_fields",
      clock(epochA + 10_000),
    ),
    /not fresh/,
  );
});

test("portable normalization binds equal fresh rotate timestamps", () => {
  function response(timestamp) {
    return {
      content: [{ type: "text", text: "Rotated 1 page" }],
      structuredContent: { last_mutation_at: timestamp },
      _meta: { last_mutation_at: timestamp },
    };
  }
  const timestampA = "2026-07-29T18:00:00.123Z";
  const timestampB = "2026-07-29T18:00:01.456Z";
  const clock = (start, end = start) => ({
    start_ms: start - 100,
    end_ms: end + 100,
  });
  const summaryA = rowRunnerV4Internals.responseSummary(
    response(timestampA),
    [],
    limits(),
    "rotate_pdf_pages",
    clock(Date.parse(timestampA)),
  );
  const summaryB = rowRunnerV4Internals.responseSummary(
    response(timestampB),
    [],
    limits(),
    "rotate_pdf_pages",
    clock(Date.parse(timestampB)),
  );
  assert.deepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );
  const mismatched = response(timestampA);
  mismatched._meta.last_mutation_at = timestampB;
  assert.throws(
    () => rowRunnerV4Internals.responseSummary(
      mismatched,
      [],
      limits(),
      "rotate_pdf_pages",
      clock(Date.parse(timestampA), Date.parse(timestampB)),
    ),
    /byte-identical/,
  );
});

test("portable normalized digest preserves own __proto__ evidence", () => {
  const responseA = JSON.parse(
    '{"content":[{"type":"text","text":"ok"}],"isError":false,'
      + '"_meta":{"__proto__":"AAAA"}}',
  );
  const responseB = JSON.parse(
    '{"content":[{"type":"text","text":"ok"}],"isError":false,'
      + '"_meta":{"__proto__":"BBBB"}}',
  );
  assert.equal(Object.hasOwn(responseA._meta, "__proto__"), true);
  const summaryA = rowRunnerV4Internals.responseSummary(
    responseA,
    [],
    limits(),
  );
  const summaryB = rowRunnerV4Internals.responseSummary(
    responseB,
    [],
    limits(),
  );
  assert.notDeepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );
});

test("portable read-content errors receive only truthful typed classification", () => {
  const inputPath = "C:\\Users\\example\\Campaign\\candidate.pdf";
  const response = {
    content: [{ type: "text", text: "No extractable content was available." }],
    structuredContent: {
      pdf_path: inputPath,
      file_name: "candidate.pdf",
      total_pages: 0,
      pages_read: 0,
      text_length: 0,
      text_truncated: false,
      text_found: false,
      content_available: false,
      extraction_status: "failed",
      page_previews: [],
      preview_truncated: false,
      extraction_mode: "none",
      error_codes: ["NO_EXTRACTABLE_TEXT"],
      retry_guidance: "Check access and renderer availability, then retry.",
    },
    isError: true,
  };
  const paths = [{ label: "input-argument", path: inputPath }];
  assert.deepEqual(
    rowRunnerV4Internals.responseSummary(
      response,
      paths,
      limits(),
      "read_pdf_content",
    ).structured_error,
    {
      status: "failed",
      error_schema_version: null,
      code: "content_extraction_failed",
    },
  );
  assert.equal(
    rowRunnerV4Internals.responseSummary(
      response,
      paths,
      limits(),
      "get_pdf_info",
    ).structured_error,
    null,
  );
});

test("portable planned-path tokens cannot collide with literal text", () => {
  const plannedA = [{
    label: "input-argument",
    path: "C:\\Users\\example\\RunA\\input.pdf",
  }];
  const plannedB = [{
    label: "input-argument",
    path: "C:\\Users\\example\\RunB\\input.pdf",
  }];
  const response = values => ({
    content: [{ type: "text", text: "ok" }],
    isError: false,
    _meta: { values },
  });
  const summaryA = rowRunnerV4Internals.responseSummary(
    response([plannedA[0].path, "<input-argument>"]),
    plannedA,
    limits(),
  );
  const summaryB = rowRunnerV4Internals.responseSummary(
    response(["<input-argument>", plannedB[0].path]),
    plannedB,
    limits(),
  );
  assert.equal(summaryA.scanner.allowed_path_substitutions[0].uses, 1);
  assert.equal(summaryB.scanner.allowed_path_substitutions[0].uses, 1);
  assert.notDeepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );
});

test("portable frozen control remains byte reproducible across a clock gap", async () => {
  await withTemporaryRoot("pdf-win-clock", async root => {
    const controlA = path.join(root, "control-a.pdf");
    const controlB = path.join(root, "control-b.pdf");
    await rowRunnerV4Internals.writeControlPdf(controlA);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await rowRunnerV4Internals.writeControlPdf(controlB);
    const identityA = await rowRunnerV4Internals.stableFileIdentity(
      controlA,
      { maximumBytes: 1024 * 1024 },
    );
    const identityB = await rowRunnerV4Internals.stableFileIdentity(
      controlB,
      { maximumBytes: 1024 * 1024 },
    );
    assert.equal(identityA.bytes, 728);
    assert.equal(
      identityA.sha256,
      "289a4cf752399fad51e42c1ba9c06dc1e6b8d471dfbc8403f2045b8ea2f8ecef",
    );
    assert.equal(identityA.sha256, identityB.sha256);
  });
});

test("portable QPDF normalization excludes only exact volatile metadata", () => {
  function graph() {
    return {
      qpdf: [{
        jsonversion: 2,
        pdfversion: "1.7",
      }, {
        "obj:3 0 R": {
          value: {
            "/CreationDate": "u:D:20260729010101Z",
            "/ModDate": "u:D:20260729010102Z",
            "/Nested": { "/ModDate": "u:material-nested-value" },
            "/Title": "u:material-title",
          },
        },
        "obj:4 0 R": {
          value: { "/CreationDate": "u:material-non-info-value" },
        },
        trailer: {
          value: {
            "/ID": [
              "b:0123456789abcdef0123456789abcdef",
              "b:fedcba9876543210fedcba9876543210",
            ],
            "/Info": "3 0 R",
            "/Root": "4 0 R",
          },
        },
      }],
    };
  }
  const normalized = graph();
  const referenceTimeMs = Date.UTC(2026, 6, 29, 1, 1, 30);
  const report = rowRunnerV4Internals.normalizeQpdfSemanticJson(
    normalized,
    { referenceTimeMs },
  );
  assert.deepEqual(report.excluded_fields, [
    "trailer.value./ID",
    "trailer.value./Info.value./CreationDate",
    "trailer.value./Info.value./ModDate",
  ]);
  assert.deepEqual(report.excluded_occurrences, {
    "trailer.value./ID": 1,
    "trailer.value./Info.value./CreationDate": 1,
    "trailer.value./Info.value./ModDate": 1,
  });
  const body = normalized.qpdf[1];
  assert.equal(Object.hasOwn(body.trailer.value, "/ID"), false);
  assert.equal(Object.hasOwn(body["obj:3 0 R"].value, "/CreationDate"), false);
  assert.equal(Object.hasOwn(body["obj:3 0 R"].value, "/ModDate"), false);
  assert.equal(
    body["obj:3 0 R"].value["/Nested"]["/ModDate"],
    "u:material-nested-value",
  );
  assert.equal(
    body["obj:4 0 R"].value["/CreationDate"],
    "u:material-non-info-value",
  );

  const retained = graph();
  retained.qpdf[1].trailer.value["/ID"] = ["u:not-a-binary-id"];
  retained.qpdf[1]["obj:3 0 R"].value["/CreationDate"] =
    "u:D:20000101000000Z";
  retained.qpdf[1]["obj:3 0 R"].value["/ModDate"] = "u:not-a-pdf-date";
  const retainedReport = rowRunnerV4Internals.normalizeQpdfSemanticJson(
    retained,
    { referenceTimeMs },
  );
  assert.deepEqual(retainedReport.excluded_occurrences, {
    "trailer.value./ID": 0,
    "trailer.value./Info.value./CreationDate": 0,
    "trailer.value./Info.value./ModDate": 0,
  });
  assert.deepEqual(retainedReport.retained_nonvolatile_occurrences, {
    "trailer.value./ID": 1,
    "trailer.value./Info.value./CreationDate": 1,
    "trailer.value./Info.value./ModDate": 1,
  });
  assert.throws(
    () => rowRunnerV4Internals.normalizeQpdfSemanticJson({
      qpdf: [{ version: 2 }, { trailer: { value: {} } }],
    }),
    /schema/,
  );
});

test("portable scanner fails closed on cycles and evidence ceilings", () => {
  const cyclic = { content: [] };
  cyclic.content.push(cyclic);
  assert.throws(
    () => rowRunnerV4Internals.scanStringLeaves(cyclic, [], limits()),
    /cycle/,
  );
  assert.throws(
    () => rowRunnerV4Internals.scanStringLeaves(
      { content: [{ type: "text", text: "123456789" }] },
      [],
      limits({ scanner_string_bytes: 8 }),
    ),
    /string-byte ceiling/,
  );
});
