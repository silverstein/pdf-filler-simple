import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PDFDocument, degrees } from "pdf-lib";
import {
  campaignComparisonV3Internals,
} from "./eval/compare-deep-malformed-macos-campaign-v3.js";
import {
  rowRunnerV3Internals,
} from "./helpers/deep-malformed-row-runner-v3.js";
import {
  QPDF_ORACLE_POLICY,
  qpdfBudgetFileIdentity,
} from "./eval/qpdf-macos-budget-exec.js";
import { buildPdf } from "./helpers/deep-malformed-fixtures.js";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

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

async function containedSemanticFingerprint(qpdfPath, outputPath, options) {
  const launcherPath = process.env.PDF_TOOLS_QPDF_BUDGET_EXEC_PATH;
  if (!launcherPath) {
    throw new Error("PDF_TOOLS_QPDF_BUDGET_EXEC_PATH is required");
  }
  const identityResult = spawnSync(
    "/bin/ps",
    ["-o", "pgid=", "-p", String(process.pid)],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(identityResult.error, undefined);
  assert.equal(identityResult.status, 0);
  assert.equal(identityResult.signal, null);
  assert.equal(identityResult.stderr, "");
  const identity = identityResult.stdout.trim().split(/\s+/).map(Number);
  assert.equal(identity.length, 1);
  assert.ok(Number.isSafeInteger(identity[0]) && identity[0] >= 2);
  const outputIdentity = await rowRunnerV3Internals.stableFileIdentity(
    outputPath,
    { maximumBytes: options.canonicalPdfMaxBytes },
  );
  return rowRunnerV3Internals.semanticFingerprintPdf(
    {
      qpdf: await qpdfBudgetFileIdentity(qpdfPath, 64 << 20),
      qpdf_budget_exec: {
        binary: await qpdfBudgetFileIdentity(launcherPath),
        policy: QPDF_ORACLE_POLICY,
      },
    },
    { pid: process.pid, pgid: identity[0] },
    outputPath,
    outputIdentity,
    options,
  );
}

async function temporaryRoot(label) {
  const canonicalTemporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(canonicalTemporary, `${label}-`));
  await fs.chmod(root, 0o700);
  return root;
}

async function withTemporaryRoot(label, callback) {
  const root = await temporaryRoot(label);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("streaming inventory rejects real links, special entries, and evidence overflow", async () => {
  await withTemporaryRoot("pdf-v2-regular", async root => {
    await fs.writeFile(path.join(root, "regular"), "safe", { mode: 0o600 });
    const observed = await rowRunnerV3Internals.inventoryOneRoot(
      "input",
      root,
      limits(),
    );
    assert.equal(observed.entries.length, 1);
    assert.equal(observed.entries[0].kind, "file");
    assert.equal(observed.entries[0].links, 1);
  });

  await withTemporaryRoot("pdf-v2-symlink", async root => {
    const target = path.join(root, "target");
    await fs.writeFile(target, "safe", { mode: 0o600 });
    await fs.symlink(target, path.join(root, "link"));
    await assert.rejects(
      rowRunnerV3Internals.inventoryOneRoot("input", root, limits()),
      /symbolic link/,
    );
  });

  await withTemporaryRoot("pdf-v2-hardlink", async root => {
    const target = path.join(root, "target");
    await fs.writeFile(target, "safe", { mode: 0o600 });
    await fs.link(target, path.join(root, "second-name"));
    await assert.rejects(
      rowRunnerV3Internals.inventoryOneRoot("input", root, limits()),
      /hardlink|non-regular/,
    );
  });

  await withTemporaryRoot("pdf-v2-fifo", async root => {
    const result = spawnSync("/usr/bin/mkfifo", [path.join(root, "pipe")], {
      stdio: "pipe",
    });
    assert.equal(result.status, 0);
    await assert.rejects(
      rowRunnerV3Internals.inventoryOneRoot("input", root, limits()),
      /hardlink|non-regular/,
    );
  });

  await withTemporaryRoot("pdf-v2-file-overflow", async root => {
    await fs.writeFile(path.join(root, "large"), "123456789", {
      mode: 0o600,
    });
    await assert.rejects(
      rowRunnerV3Internals.inventoryOneRoot(
        "input",
        root,
        limits({ per_file_bytes: 8 }),
      ),
      /regular-file contract|byte ceiling/,
    );
  });

  await withTemporaryRoot("pdf-v2-aggregate-overflow", async root => {
    await fs.writeFile(path.join(root, "a"), "123456", { mode: 0o600 });
    await fs.writeFile(path.join(root, "b"), "123456", { mode: 0o600 });
    await assert.rejects(
      rowRunnerV3Internals.inventoryOneRoot(
        "input",
        root,
        limits({ aggregate_inventory_bytes: 10 }),
      ),
      /aggregate byte ceiling/,
    );
  });

  await withTemporaryRoot("pdf-v2-entry-overflow", async root => {
    await fs.writeFile(path.join(root, "a"), "1", { mode: 0o600 });
    await fs.writeFile(path.join(root, "b"), "2", { mode: 0o600 });
    await assert.rejects(
      rowRunnerV3Internals.inventoryOneRoot(
        "input",
        root,
        limits({ inventory_entries: 1 }),
      ),
      /entry ceiling/,
    );
  });
});

test("whole-response scanner permits exact argument echoes but not descendants or internals", () => {
  const paths = [
    {
      label: "input-argument",
      path: "/Users/silverbook/Campaign/input/candidate.pdf",
    },
    {
      label: "control-argument",
      path: "/Users/silverbook/Campaign/input/control.pdf",
    },
    {
      label: "rotate-output-argument",
      path: "/Users/silverbook/Campaign/outputs/rotate/rotated.pdf",
    },
    {
      label: "split-output-argument",
      path: "/Users/silverbook/Campaign/outputs/split",
    },
    {
      label: "split-output-child",
      path:
        "/Users/silverbook/Campaign/outputs/split/candidate_pages_1-1.pdf",
    },
  ];
  const safe = {
    content: [{
      type: "text",
      text: `Input: ${paths[0].path}.`,
    }],
    structuredContent: {
      destination: paths[3].path,
    },
    _meta: {
      output: paths[2].path,
      control: paths[1].path,
      split_child: paths[4].path,
    },
  };
  const accepted = rowRunnerV3Internals.scanStringLeaves(
    safe,
    paths,
    limits(),
  );
  assert.equal(accepted.pass, true);
  assert.equal(accepted.raw_internal_matches, 0);
  assert.equal(
    accepted.allowed_path_substitutions.reduce(
      (sum, row) => sum + row.uses,
      0,
    ),
    5,
  );

  const rejectedValues = [
    {
      structuredContent: {
        leaked:
          `${paths[3].path}/internal-temporary-file.pdf`,
      },
    },
    {
      structuredContent: {
        sibling:
          "/Users/silverbook/Campaign/outputs/split/sibling.pdf",
      },
    },
    {
      structuredContent: {
        child_descendant:
          `${paths[4].path}/nested`,
      },
    },
    {
      structuredContent: {
        arbitrary_descendant:
          `${paths[3].path}/arbitrary/nested.pdf`,
      },
    },
    {
      structuredContent: {
        stack_location: `${paths[0].path}:12:4`,
      },
    },
    {
      structuredContent: {
        query_suffix: `${paths[1].path}?internal=true`,
      },
    },
    {
      structuredContent: {
        comma_suffix: `${paths[2].path},internal`,
      },
    },
    {
      structuredContent: {
        extension_suffix: `${paths[4].path}.bak`,
      },
    },
    {
      _meta: {
        exception: "RangeError: Maximum call stack size exceeded",
      },
    },
    {
      content: [{
        type: "text",
        text: "at parse (node:internal/modules/esm:123:4)",
      }],
    },
    {
      _meta: {
        unix: "file:///Users/silverbook/private/module.js",
        windows: String.raw`C:\Users\Mat\private\module.js`,
      },
    },
    {
      _meta: {
        "/home/operator/private-source": "stable value",
      },
    },
    {
      structuredContent: {
        [`${paths[0].path}`]: "planned paths are forbidden as keys",
      },
    },
  ];
  for (const value of rejectedValues) {
    const rejected = rowRunnerV3Internals.scanStringLeaves(
      value,
      paths,
      limits(),
    );
    assert.equal(rejected.pass, false);
    assert.ok(rejected.raw_internal_matches >= 1);
  }
});

test("normalized response digest ignores only exact planned-path relocation", () => {
  function pathsFor(run) {
    const root = `/Users/silverbook/${run}`;
    return [
      {
        label: "input-argument",
        path: `${root}/input/candidate.pdf`,
      },
      {
        label: "control-argument",
        path: `${root}/input/control.pdf`,
      },
      {
        label: "rotate-output-argument",
        path: `${root}/outputs/rotate/rotated.pdf`,
      },
      {
        label: "split-output-argument",
        path: `${root}/outputs/split`,
      },
      {
        label: "split-output-child",
        path: `${root}/outputs/split/candidate_pages_1-1.pdf`,
      },
    ];
  }
  function toolResponse(paths, message = "Completed") {
    return {
      content: [{
        type: "text",
        text: `${message}: ${paths[0].path}.`,
      }],
      structuredContent: {
        input: paths[0].path,
        output: paths[2].path,
      },
      _meta: {
        control: paths[1].path,
        split: paths[3].path,
        split_child: paths[4].path,
      },
      isError: false,
    };
  }
  const pathsA = pathsFor("RunAlpha");
  const pathsB = pathsFor("RunBravo");
  const summaryA = rowRunnerV3Internals.responseSummary(
    toolResponse(pathsA),
    pathsA,
    limits(),
  );
  const summaryB = rowRunnerV3Internals.responseSummary(
    toolResponse(pathsB),
    pathsB,
    limits(),
  );
  assert.notEqual(summaryA.sha256, summaryB.sha256);
  assert.deepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );
  assert.equal(
    summaryA.scanner.normalized_scanned_bytes,
    summaryB.scanner.normalized_scanned_bytes,
  );

  const changedText = rowRunnerV3Internals.responseSummary(
    toolResponse(pathsB, "Materially different"),
    pathsB,
    limits(),
  );
  assert.notDeepEqual(
    summaryA.scanner.normalized_response,
    changedText.scanner.normalized_response,
  );
});

test("normalized response digest preserves own __proto__ evidence", () => {
  const responseA = JSON.parse(
    '{"content":[{"type":"text","text":"ok"}],'
      + '"isError":false,"_meta":{"__proto__":"AAAA"}}',
  );
  const responseB = JSON.parse(
    '{"content":[{"type":"text","text":"ok"}],'
      + '"isError":false,"_meta":{"__proto__":"BBBB"}}',
  );
  assert.equal(Object.hasOwn(responseA._meta, "__proto__"), true);
  assert.equal(Object.hasOwn(responseB._meta, "__proto__"), true);
  const summaryA = rowRunnerV3Internals.responseSummary(
    responseA,
    [],
    limits(),
  );
  const summaryB = rowRunnerV3Internals.responseSummary(
    responseB,
    [],
    limits(),
  );
  assert.equal(summaryA.scanner.pass, true);
  assert.equal(summaryB.scanner.pass, true);
  assert.equal(
    summaryA.scanner.scanned_nodes,
    summaryB.scanner.scanned_nodes,
  );
  assert.equal(
    summaryA.scanner.scanned_bytes,
    summaryB.scanner.scanned_bytes,
  );
  assert.notDeepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );

  const objectA = JSON.parse(
    '{"content":[{"type":"text","text":"ok"}],"isError":false,'
      + '"structuredContent":{"__proto__":{"value":"AAAA"},'
      + '"constructor":"stable","prototype":"stable","":"stable",'
      + '"é":"stable"}}',
  );
  const objectB = JSON.parse(
    '{"content":[{"type":"text","text":"ok"}],"isError":false,'
      + '"structuredContent":{"__proto__":{"value":"BBBB"},'
      + '"constructor":"stable","prototype":"stable","":"stable",'
      + '"é":"stable"}}',
  );
  const objectSummaryA = rowRunnerV3Internals.responseSummary(
    objectA,
    [],
    limits(),
  );
  const objectSummaryB = rowRunnerV3Internals.responseSummary(
    objectB,
    [],
    limits(),
  );
  assert.equal(
    Object.hasOwn(
      objectSummaryA.scanner.normalized_response,
      "sha256",
    ),
    true,
  );
  assert.notDeepEqual(
    objectSummaryA.scanner.normalized_response,
    objectSummaryB.scanner.normalized_response,
  );

  const unicodeA = rowRunnerV3Internals.responseSummary(
    JSON.parse(
      '{"content":[{"type":"text","text":"ok"}],"isError":false,'
        + '"_meta":{"é":"stable"}}',
    ),
    [],
    limits(),
  );
  const unicodeB = rowRunnerV3Internals.responseSummary(
    JSON.parse(
      '{"content":[{"type":"text","text":"ok"}],"isError":false,'
        + '"_meta":{"é":"stable"}}',
    ),
    [],
    limits(),
  );
  assert.notDeepEqual(
    unicodeA.scanner.normalized_response,
    unicodeB.scanner.normalized_response,
  );
});

test("rich read-content failures receive a truthful structured-error classification", () => {
  const root = "/Users/silverbook/Campaign/TypedFailure";
  const paths = [
    {
      label: "input-argument",
      path: `${root}/input/candidate.pdf`,
    },
    {
      label: "control-argument",
      path: `${root}/input/control.pdf`,
    },
    {
      label: "rotate-output-argument",
      path: `${root}/outputs/rotate/rotated.pdf`,
    },
    {
      label: "split-output-argument",
      path: `${root}/outputs/split`,
    },
    {
      label: "split-output-child",
      path: `${root}/outputs/split/candidate_pages_1-1.pdf`,
    },
  ];
  const response = {
    content: [{ type: "text", text: "No extractable content was available." }],
    structuredContent: {
      pdf_path: paths[0].path,
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
      error_codes: ["NO_EXTRACTABLE_TEXT", "IMAGE_FALLBACK_FAILED"],
      retry_guidance: "Check access and renderer availability, then retry.",
    },
    isError: true,
  };
  const summary = rowRunnerV3Internals.responseSummary(
    response,
    paths,
    limits(),
    "read_pdf_content",
  );
  assert.deepEqual(summary.structured_error, {
    status: "failed",
    error_schema_version: null,
    code: "content_extraction_failed",
  });
  assert.equal(
    rowRunnerV3Internals.responseSummary(
      response,
      paths,
      limits(),
      "get_pdf_info",
    ).structured_error,
    null,
  );
});

test("planned-path tokens cannot collide with literal response text", () => {
  const plannedA = [{
    label: "input-argument",
    path: "/Users/silverbook/RunA/input.pdf",
  }];
  const plannedB = [{
    label: "input-argument",
    path: "/Users/silverbook/RunB/input.pdf",
  }];
  function response(values) {
    return {
      content: [{
        type: "text",
        text: "ok",
      }],
      isError: false,
      _meta: { values },
    };
  }
  const summaryA = rowRunnerV3Internals.responseSummary(
    response([plannedA[0].path, "<input-argument>"]),
    plannedA,
    limits(),
  );
  const summaryB = rowRunnerV3Internals.responseSummary(
    response(["<input-argument>", plannedB[0].path]),
    plannedB,
    limits(),
  );
  assert.equal(
    summaryA.scanner.allowed_path_substitutions[0].uses,
    1,
  );
  assert.equal(
    summaryB.scanner.allowed_path_substitutions[0].uses,
    1,
  );
  assert.equal(summaryA.scanner.scanned_bytes, summaryB.scanner.scanned_bytes);
  assert.notDeepEqual(
    summaryA.scanner.normalized_response,
    summaryB.scanner.normalized_response,
  );
});

test("frozen control is byte-reproducible across a clock gap", async () => {
  await withTemporaryRoot("pdf-v2-clock", async root => {
    const controlA = path.join(root, "control-a.pdf");
    const controlB = path.join(root, "control-b.pdf");
    await rowRunnerV3Internals.writeControlPdf(controlA);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await rowRunnerV3Internals.writeControlPdf(controlB);
    const identityA = await rowRunnerV3Internals.stableFileIdentity(
      controlA,
      { maximumBytes: 1024 * 1024 },
    );
    const identityB = await rowRunnerV3Internals.stableFileIdentity(
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

test("QPDF normalization excludes only trailer ID and direct Info clock fields", () => {
  function qpdfGraph() {
    return {
      qpdf: [{
        jsonversion: 2,
        pdfversion: "1.7",
      }, {
        "obj:3 0 R": {
          value: {
            "/CreationDate": "u:D:20260729010101Z",
            "/ModDate": "u:D:20260729010102Z",
            "/Nested": {
              "/ModDate": "u:material-nested-value",
            },
            "/ID": "u:material-info-value",
            "/Title": "u:material-title",
          },
        },
        "obj:4 0 R": {
          value: {
            "/CreationDate": "u:material-non-info-value",
          },
        },
        "obj:5 0 R": {
          stream: {
            data: "volatile-serialized-object-container",
            dict: {
              "/N": 2,
              "/Type": "/ObjStm",
            },
          },
        },
        "obj:6 0 R": {
          stream: {
            data: "volatile-cross-reference-offsets",
            dict: {
              "/Type": "/XRef",
              "/W": [1, 2, 2],
            },
          },
        },
        "obj:7 0 R": {
          stream: {
            data: "material-page-content",
            dict: {},
          },
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
  const normalized = qpdfGraph();
  const referenceTimeMs = Date.UTC(2026, 6, 29, 1, 1, 30);
  const report = rowRunnerV3Internals.normalizeQpdfSemanticJson(
    normalized,
    { referenceTimeMs },
  );
  assert.equal(report.clock_tolerance_ms, 600_000);
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
  assert.deepEqual(report.excluded_value_classes, {
    "trailer.value./ID": "binary-id-array:2x128-bit",
    "trailer.value./Info.value./CreationDate":
      "unicode-pdf-date:utc-second:near-fingerprint",
    "trailer.value./Info.value./ModDate":
      "unicode-pdf-date:utc-second:near-fingerprint",
  });
  assert.deepEqual(report.retained_nonvolatile_occurrences, {
    "trailer.value./ID": 0,
    "trailer.value./Info.value./CreationDate": 0,
    "trailer.value./Info.value./ModDate": 0,
  });
  const body = normalized.qpdf[1];
  assert.equal(Object.hasOwn(body.trailer.value, "/ID"), false);
  assert.equal(
    Object.hasOwn(body["obj:3 0 R"].value, "/CreationDate"),
    false,
  );
  assert.equal(
    Object.hasOwn(body["obj:3 0 R"].value, "/ModDate"),
    false,
  );
  assert.equal(
    body["obj:3 0 R"].value["/Nested"]["/ModDate"],
    "u:material-nested-value",
  );
  assert.equal(
    body["obj:3 0 R"].value["/ID"],
    "u:material-info-value",
  );
  assert.equal(
    body["obj:4 0 R"].value["/CreationDate"],
    "u:material-non-info-value",
  );
  assert.equal(
    body["obj:5 0 R"].stream.data,
    "volatile-serialized-object-container",
  );
  assert.equal(
    body["obj:6 0 R"].stream.data,
    "volatile-cross-reference-offsets",
  );
  assert.equal(
    body["obj:7 0 R"].stream.data,
    "material-page-content",
  );

  const bytesA =
    rowRunnerV3Internals.boundedCanonicalJsonBytes(normalized, 1 << 20);
  const second = qpdfGraph();
  rowRunnerV3Internals.normalizeQpdfSemanticJson(
    second,
    { referenceTimeMs },
  );
  const bytesB =
    rowRunnerV3Internals.boundedCanonicalJsonBytes(second, 1 << 20);
  assert.deepEqual(bytesA, bytesB);
  assert.throws(
    () => rowRunnerV3Internals.boundedCanonicalJsonBytes(
      normalized,
      bytesA.length - 1,
    ),
    /byte ceiling/,
  );
  assert.throws(
    () => rowRunnerV3Internals.normalizeQpdfSemanticJson({
      qpdf: [{ version: 2 }, { trailer: { value: {} } }],
    }),
    /schema/,
  );

  const retained = qpdfGraph();
  retained.qpdf[1].trailer.value["/ID"] = ["u:not-a-binary-id"];
  retained.qpdf[1]["obj:3 0 R"].value["/CreationDate"] =
    "u:D:20000101000000Z";
  retained.qpdf[1]["obj:3 0 R"].value["/ModDate"] = "u:not-a-pdf-date";
  const retainedReport = rowRunnerV3Internals.normalizeQpdfSemanticJson(
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
  assert.deepEqual(retained.qpdf[1].trailer.value["/ID"], [
    "u:not-a-binary-id",
  ]);
  assert.equal(
    retained.qpdf[1]["obj:3 0 R"].value["/CreationDate"],
    "u:D:20000101000000Z",
  );
  assert.equal(
    retained.qpdf[1]["obj:3 0 R"].value["/ModDate"],
    "u:not-a-pdf-date",
  );
});

test("QPDF semantic traversal and canonicalization are stack-safe", () => {
  let nested = "leaf";
  for (let depth = 0; depth < 20_000; depth += 1) {
    nested = { next: nested };
  }
  const graph = {
    qpdf: [{
      jsonversion: 2,
    }, {
      "obj:1 0 R": {
        value: nested,
      },
      trailer: {
        value: {
          "/Root": "1 0 R",
        },
      },
    }],
  };
  const report = rowRunnerV3Internals.normalizeQpdfSemanticJson(graph);
  assert.ok(report.observed_nodes > 20_000);
  const bytes =
    rowRunnerV3Internals.boundedCanonicalJsonBytes(graph, 2 << 20);
  assert.ok(bytes.length > 150_000);
  assert.equal(bytes[0], "{".charCodeAt(0));
  assert.equal(bytes[bytes.length - 1], "}".charCodeAt(0));
});

test("output fingerprint ignores clock metadata but detects page-content drift", {
  skip: process.platform !== "darwin"
    || typeof process.env.PDF_TOOLS_QPDF_PATH !== "string"
    || typeof process.env.PDF_TOOLS_QPDF_BUDGET_EXEC_PATH !== "string",
}, async () => {
  await withTemporaryRoot("pdf-v2-fingerprint", async root => {
    const qpdfPath = process.env.PDF_TOOLS_QPDF_PATH;
    const base = await PDFDocument.create({ updateMetadata: false });
    base.addPage([200, 200]);
    const baseBytes = await base.save();
    async function saveRotated({ materiallyDifferent = false } = {}) {
      const document = await PDFDocument.load(baseBytes);
      const page = document.getPage(0);
      page.setRotation(degrees(90));
      if (materiallyDifferent) {
        page.drawRectangle({
          x: 20,
          y: 20,
          width: 40,
          height: 40,
        });
      }
      return Buffer.from(await document.save());
    }
    const outputA = await saveRotated();
    await new Promise(resolve => setTimeout(resolve, 1100));
    const outputB = await saveRotated();
    const outputDifferent = await saveRotated({
      materiallyDifferent: true,
    });
    assert.notEqual(hash(outputA), hash(outputB));
    const pathA = path.join(root, "a.pdf");
    const pathB = path.join(root, "b.pdf");
    const pathDifferent = path.join(root, "different.pdf");
    await fs.writeFile(pathA, outputA, { mode: 0o600 });
    await fs.writeFile(pathB, outputB, { mode: 0o600 });
    await fs.writeFile(pathDifferent, outputDifferent, { mode: 0o600 });
    const fingerprintOptions = {
      canonicalPdfMaxBytes: 64 << 20,
      timeoutMs: 10_000,
      outputMaxBytes: 64 << 20,
    };
    const fingerprintA =
      await containedSemanticFingerprint(
        qpdfPath,
        pathA,
        fingerprintOptions,
      );
    const fingerprintB =
      await containedSemanticFingerprint(
        qpdfPath,
        pathB,
        fingerprintOptions,
      );
    const fingerprintDifferent =
      await containedSemanticFingerprint(
        qpdfPath,
        pathDifferent,
        fingerprintOptions,
      );
    assert.equal(fingerprintA.pass, true);
    assert.equal(fingerprintB.pass, true);
    assert.equal(fingerprintDifferent.pass, true);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      "a.pdf",
      "b.pdf",
      "different.pdf",
    ]);
    assert.notEqual(
      fingerprintA.command.command.stdout.sha256,
      fingerprintB.command.command.stdout.sha256,
    );
    assert.deepEqual(
      fingerprintA.normalized,
      fingerprintB.normalized,
    );
    assert.notDeepEqual(
      fingerprintA.normalized,
      fingerprintDifferent.normalized,
    );

    function outputValidation(bytes, fingerprint) {
      return {
        required: true,
        pass: true,
        outputs: [{
          identity: {
            path: path.join(root, "rotated.pdf"),
            bytes: bytes.length,
            sha256: hash(bytes),
            mode: 0o600,
            links: 1,
            device: "1",
            inode: "1",
          },
          nonalias: true,
          qpdf_stable: true,
          qpdf_check: {
            pass: true,
            containment: {
              budget_enforced: true,
              control_eof_after_ready: true,
            },
          },
          qpdf_pages: {
            pass: true,
            containment: {
              budget_enforced: true,
              control_eof_after_ready: true,
            },
            command: { stdout: { text: "1\n" } },
          },
          semantic: {
            loadable: true,
            pages: 1,
            finite_geometry: true,
            first_page_rotation: 90,
          },
          semantic_fingerprint: fingerprint,
        }],
      };
    }
    assert.deepEqual(
      campaignComparisonV3Internals.outputSemantics(
        outputValidation(outputA, fingerprintA),
      ),
      campaignComparisonV3Internals.outputSemantics(
        outputValidation(outputB, fingerprintB),
      ),
    );
    assert.notDeepEqual(
      campaignComparisonV3Internals.outputSemantics(
        outputValidation(outputA, fingerprintA),
      ),
      campaignComparisonV3Internals.outputSemantics(
        outputValidation(outputDifferent, fingerprintDifferent),
      ),
    );

    function outputInventory(bytes) {
      return {
        aggregate_bytes: bytes.length,
        total_entries: 1,
        roots: [{
          label: "rotate_output",
          mode: 0o700,
          aggregate_bytes: bytes.length,
          entries: [{
            path: "rotated.pdf",
            kind: "file",
            mode: 0o600,
            bytes: bytes.length,
            sha256: hash(bytes),
            links: 1,
          }],
        }],
      };
    }
    assert.deepEqual(
      campaignComparisonV3Internals.inventorySemantics(
        outputInventory(outputA),
      ),
      campaignComparisonV3Internals.inventorySemantics(
        outputInventory(outputB),
      ),
    );
  });
});

test("QPDF projection preserves referenced streams mislabeled as infrastructure", {
  skip: process.platform !== "darwin"
    || typeof process.env.PDF_TOOLS_QPDF_PATH !== "string"
    || typeof process.env.PDF_TOOLS_QPDF_BUDGET_EXEC_PATH !== "string",
}, async () => {
  await withTemporaryRoot("pdf-v2-mislabeled-stream", async root => {
    const qpdfPath = process.env.PDF_TOOLS_QPDF_PATH;
    const options = {
      canonicalPdfMaxBytes: 64 << 20,
      timeoutMs: 10_000,
      outputMaxBytes: 64 << 20,
    };
    function fixture(type, content) {
      const typeFields = type === "ObjStm"
        ? "/Type /ObjStm /N 0 /First 0"
        : "/Type /XRef";
      const stream = `<< /Length ${Buffer.byteLength(content, "latin1")} `
        + `${typeFields} >>\nstream\n${content}\nendstream`;
      return buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R "
          + "/MediaBox [0 0 100 100] /Resources <<>> "
          + "/Contents 4 0 R >>"],
        [4, stream],
      ], 1);
    }
    for (const type of ["ObjStm", "XRef"]) {
      const pathA = path.join(root, `${type}-a.pdf`);
      const pathB = path.join(root, `${type}-b.pdf`);
      await fs.writeFile(
        pathA,
        fixture(type, "0 0 1 rg 10 10 50 50 re f"),
        { mode: 0o600 },
      );
      await fs.writeFile(
        pathB,
        fixture(type, "1 0 0 rg 10 10 50 50 re f"),
        { mode: 0o600 },
      );
      const fingerprintA =
        await containedSemanticFingerprint(
          qpdfPath,
          pathA,
          options,
        );
      const fingerprintB =
        await containedSemanticFingerprint(
          qpdfPath,
          pathB,
          options,
        );
      assert.equal(fingerprintA.pass, true);
      assert.equal(fingerprintB.pass, true);
      assert.notDeepEqual(fingerprintA.normalized, fingerprintB.normalized);
    }
  });
});

test("QPDF object graph detects each material successful-output class", {
  skip: process.platform !== "darwin"
    || typeof process.env.PDF_TOOLS_QPDF_PATH !== "string"
    || typeof process.env.PDF_TOOLS_QPDF_BUDGET_EXEC_PATH !== "string",
}, async () => {
  await withTemporaryRoot("pdf-v2-material-classes", async root => {
    const qpdfPath = process.env.PDF_TOOLS_QPDF_PATH;
    const options = {
      canonicalPdfMaxBytes: 64 << 20,
      timeoutMs: 10_000,
      outputMaxBytes: 64 << 20,
    };
    const stream = (dictionary, data) =>
      `<< /Length ${Buffer.byteLength(data, "latin1")} ${dictionary} >>`
      + `\nstream\n${data}\nendstream`;
    function fixture(overrides = {}) {
      const pageContent = overrides.page_content
        ?? "q /Fm1 Do Q q /Im1 Do Q";
      const formContent = overrides.form_content
        ?? "0 0 1 rg 10 10 20 20 re f";
      const imageData = overrides.image_data ?? "\x00\x00\xff";
      const metadata = overrides.metadata
        ?? "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">base</x:xmpmeta>";
      const procSet = overrides.proc_set ?? "[/PDF /ImageC]";
      const fieldValue = overrides.field_value ?? "base";
      const mediaBox = overrides.media_box ?? "[0 0 100 100]";
      const rotation = overrides.rotation ?? 0;
      return buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R "
          + "/Metadata 6 0 R /AcroForm 7 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R "
          + `/MediaBox ${mediaBox} /Rotate ${rotation} `
          + `/Resources << /ProcSet ${procSet} `
          + "/XObject << /Fm1 5 0 R /Im1 8 0 R >> >> "
          + "/Contents 4 0 R >>"],
        [4, stream("", pageContent)],
        [5, stream(
          "/Type /XObject /Subtype /Form /FormType 1 "
            + "/BBox [0 0 100 100] /Resources <<>>",
          formContent,
        )],
        [6, stream("/Type /Metadata /Subtype /XML", metadata)],
        [7, "<< /Fields [9 0 R] /NeedAppearances false >>"],
        [8, stream(
          "/Type /XObject /Subtype /Image /Width 1 /Height 1 "
            + "/ColorSpace /DeviceRGB /BitsPerComponent 8",
          imageData,
        )],
        [9, `<< /FT /Tx /T (field) /V (${fieldValue}) >>`],
      ], 1);
    }
    async function fingerprint(label, overrides = {}) {
      const filename = path.join(root, `${label}.pdf`);
      await fs.writeFile(filename, fixture(overrides), { mode: 0o600 });
      const result = await containedSemanticFingerprint(
        qpdfPath,
        filename,
        options,
      );
      assert.equal(result.pass, true, label);
      return result.normalized;
    }
    const baseline = await fingerprint("baseline");
    const variants = [
      ["page-content", { page_content: "q 1 0 0 rg /Fm1 Do Q" }],
      ["form", { form_content: "1 0 0 rg 10 10 20 20 re f" }],
      ["image", { image_data: "\xff\x00\x00" }],
      ["xmp", {
        metadata:
          "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">changed</x:xmpmeta>",
      }],
      ["resources", { proc_set: "[/PDF /ImageC /Text]" }],
      ["acroform", { field_value: "changed" }],
      ["geometry", { media_box: "[0 0 200 100]" }],
      ["rotation", { rotation: 90 }],
    ];
    for (const [label, overrides] of variants) {
      assert.notDeepEqual(
        baseline,
        await fingerprint(label, overrides),
        label,
      );
    }
  });
});
