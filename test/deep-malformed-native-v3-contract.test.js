import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEEP_FIXTURE_CATALOG,
  DEEP_FULL_SCALE_BASE_FIXTURE_NAMES,
} from "./helpers/deep-malformed-fixtures.js";
import { canonicalJson } from "./eval/docling-macos-supervisor.js";
import { campaignV3Internals } from "./eval/deep-malformed-macos-campaign-v3.js";
import {
  QPDF_BUDGET_COMMAND_CLAIM_BOUNDARY,
} from "./eval/qpdf-macos-budget-exec.js";
import {
  campaignComparisonV3Internals,
} from "./eval/compare-deep-malformed-macos-campaign-v3.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const CONTROL_SHA =
  "289a4cf752399fad51e42c1ba9c06dc1e6b8d471dfbc8403f2045b8ea2f8ecef";
const HEAD = "d".repeat(40);
const TREE = "e".repeat(40);
const nativeTestPath = value => path.resolve(value);
const WORK_ROOT = nativeTestPath(
  "/private/tmp/pdf-tools-v2-test/row/work",
);
const FIXTURE_PATH = nativeTestPath(
  "/private/tmp/pdf-tools-v2-test/corpus/deep-nested-arrays.pdf",
);
const ROOT_LABELS = [
  "input",
  "rotate_output",
  "split_output",
  "profiles",
  "downloads",
  "home",
  "tmp",
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const QPDF_POLICY = Object.freeze({
  address_space_headroom_bytes: 1536 * 1024 * 1024,
  file_size_bytes: 256 * 1024 * 1024,
  cpu_soft_seconds: 8,
  cpu_hard_seconds: 9,
  nofile: 64,
  core_bytes: 0,
  wall_timeout_ms: 10_000,
  calibration_required: true,
});
const QPDF_ADDRESS_SPACE_BASELINE_BYTES = 445_746_020_352;

function budgetedQpdf(stdoutText = "", {
  retainText = true,
  inputIdentity = {
    path: path.join(WORK_ROOT, "outputs", "rotate", "rotated.pdf"),
    bytes: 100,
    sha256: SHA_B,
    mode: 0o600,
    links: 1,
    device: "2",
    inode: "30",
  },
} = {}) {
  const retainedInput = {
    ...inputIdentity,
    owner: 501,
    group: 20,
  };
  const stdout = {
    bytes: Buffer.byteLength(stdoutText),
    sha256: sha256(stdoutText),
    ...(retainText ? { text: stdoutText } : {}),
  };
  return {
    protocol: "pdf-tools.budgeted-qpdf-command.v3",
    claim_boundary: QPDF_BUDGET_COMMAND_CLAIM_BOUNDARY,
    containment: {
      budget_enforced: true,
      expected_parent_pid: 1233,
      expected_pgid: 1233,
      ready: {
        type: 1,
        sequence: 0,
        stage: 10,
        error_number: 0,
        pid: 1235,
        pgid: 1233,
        sid: 1000,
        input: {
          device: retainedInput.device,
          inode: retainedInput.inode,
          bytes: retainedInput.bytes,
          mode: retainedInput.mode,
          links: retainedInput.links,
          owner: retainedInput.owner,
          group: retainedInput.group,
        },
        address_space_baseline_bytes:
          QPDF_ADDRESS_SPACE_BASELINE_BYTES,
        address_space_headroom_bytes:
          QPDF_POLICY.address_space_headroom_bytes,
        address_space_observed_bytes:
          QPDF_ADDRESS_SPACE_BASELINE_BYTES,
        limits: {
          address_space: {
            current: QPDF_ADDRESS_SPACE_BASELINE_BYTES
              + QPDF_POLICY.address_space_headroom_bytes,
            maximum: QPDF_ADDRESS_SPACE_BASELINE_BYTES
              + QPDF_POLICY.address_space_headroom_bytes,
          },
          file_size: {
            current: QPDF_POLICY.file_size_bytes,
            maximum: QPDF_POLICY.file_size_bytes,
          },
          cpu: {
            current: QPDF_POLICY.cpu_soft_seconds,
            maximum: QPDF_POLICY.cpu_hard_seconds,
          },
          nofile: {
            current: QPDF_POLICY.nofile,
            maximum: QPDF_POLICY.nofile,
          },
          core: { current: 0, maximum: 0 },
        },
      },
      error: null,
      control_eof_after_ready: true,
      same_process_group: true,
      same_session: true,
      spawned_pid: 1235,
      launcher_sha256: SHA_C,
      executables_stable: true,
      input: retainedInput,
      input_stable: true,
      input_error_sha256: null,
      control_error_sha256: null,
    },
    policy: QPDF_POLICY,
    command: {
      outcome: "close",
      code: 0,
      signal: null,
      timed_out: false,
      output_overflow: false,
      stdout,
      stderr: { bytes: 0, sha256: sha256("") },
    },
    classification: "passed",
    pass: true,
  };
}

function evidenceIdentity(filename, {
  bytes = 100,
  hash = SHA_A,
  mode = 0o644,
} = {}) {
  return {
    path: nativeTestPath(filename),
    bytes,
    sha256: hash,
    mode,
    links: 1,
  };
}

function rowIdentity(filename, {
  bytes = 100,
  hash = SHA_A,
  mode = 0o400,
  device = "1",
  inode = "1",
} = {}) {
  return {
    path: nativeTestPath(filename),
    bytes,
    sha256: hash,
    mode,
    links: 1,
    device,
    inode,
  };
}

function scannerPaths() {
  return [
    {
      label: "control-argument",
      path: path.join(WORK_ROOT, "input", "control.pdf"),
      uses: 1,
    },
    {
      label: "input-argument",
      path: path.join(WORK_ROOT, "input", "candidate.pdf"),
      uses: 0,
    },
    {
      label: "rotate-output-argument",
      path: path.join(
        WORK_ROOT,
        "outputs",
        "rotate",
        "rotated.pdf",
      ),
      uses: 0,
    },
    {
      label: "split-output-argument",
      path: path.join(WORK_ROOT, "outputs", "split"),
      uses: 0,
    },
    {
      label: "split-output-child",
      path: path.join(
        WORK_ROOT,
        "outputs",
        "split",
        "candidate_pages_1-1.pdf",
      ),
      uses: 0,
    },
  ];
}

function response({
  isError = false,
  structuredError = null,
} = {}) {
  return {
    outcome: "response",
    response: {
      canonical_bytes: 100,
      content_items: 1,
      is_error: isError,
      scanner: {
        allowed_path_substitutions: scannerPaths(),
        pass: true,
        protocol: "pdf-tools.deep-malformed-response-leak-scan.v3",
        raw_internal_matches: 0,
        normalized_response: {
          canonical_bytes: 100,
          sha256: SHA_A,
        },
        normalized_scanned_bytes: 10,
        scanned_bytes: 10,
        scanned_nodes: 5,
        scanned_strings: 1,
      },
      sha256: SHA_A,
      structured_error: structuredError,
      valid_call_tool_result: true,
    },
  };
}

function semanticFingerprint({
  normalizedHash = SHA_A,
  rawHash = SHA_B,
} = {}) {
  const sourceInput = rowIdentity(
    path.join(WORK_ROOT, "outputs", "rotate", "rotated.pdf"),
    {
      hash: SHA_B,
      mode: 0o600,
      device: "2",
      inode: "30",
    },
  );
  const projection = rowIdentity(
    path.join(
      WORK_ROOT,
      "outputs",
      "rotate",
      ".qpdf-semantic-projection-contract",
      "projection.pdf",
    ),
    {
      bytes: 900,
      hash: rawHash,
      mode: 0o600,
      device: "2",
      inode: "31",
    },
  );
  return {
    protocol:
      "pdf-tools.qpdf-semantic-object-graph-fingerprint.v1",
    canonicalization: {
      protocol:
        "pdf-tools.qpdf-object-stream-disabled-projection.v1",
      command: budgetedQpdf("", {
        retainText: false,
        inputIdentity: sourceInput,
      }),
      output: projection,
      pass: true,
    },
    command: budgetedQpdf("x", {
      retainText: false,
      inputIdentity: projection,
    }),
    normalization: {
      clock_tolerance_ms: 600_000,
      excluded_fields: [
        "trailer.value./ID",
        "trailer.value./Info.value./CreationDate",
        "trailer.value./Info.value./ModDate",
      ],
      excluded_occurrences: {
        "trailer.value./ID": 1,
        "trailer.value./Info.value./CreationDate": 1,
        "trailer.value./Info.value./ModDate": 1,
      },
      excluded_value_classes: {
        "trailer.value./ID": "binary-id-array:2x128-bit",
        "trailer.value./Info.value./CreationDate":
          "unicode-pdf-date:utc-second:near-fingerprint",
        "trailer.value./Info.value./ModDate":
          "unicode-pdf-date:utc-second:near-fingerprint",
      },
      observed_nodes: 20,
      retained_nonvolatile_occurrences: {
        "trailer.value./ID": 0,
        "trailer.value./Info.value./CreationDate": 0,
        "trailer.value./Info.value./ModDate": 0,
      },
    },
    normalized: {
      canonical_bytes: 100,
      sha256: normalizedHash,
    },
    pass: true,
  };
}

function inventory({
  rotateEntries = [],
  splitEntries = [],
} = {}) {
  const inputEntries = [
    {
      path: "candidate.pdf",
      kind: "file",
      mode: 0o400,
      bytes: 100,
      sha256: SHA_A,
      links: 1,
    },
    {
      path: "control.pdf",
      kind: "file",
      mode: 0o400,
      bytes: 728,
      sha256: CONTROL_SHA,
      links: 1,
    },
  ];
  const entriesByLabel = new Map([
    ["input", inputEntries],
    ["rotate_output", rotateEntries],
    ["split_output", splitEntries],
  ]);
  const roots = ROOT_LABELS.map(label => {
    const entries = entriesByLabel.get(label) ?? [];
    return {
      label,
      mode: 0o700,
      entries,
      aggregate_bytes: entries
        .filter(entry => entry.kind === "file")
        .reduce((sum, entry) => sum + entry.bytes, 0),
    };
  });
  return {
    aggregate_bytes: roots.reduce(
      (sum, root) => sum + root.aggregate_bytes,
      0,
    ),
    roots,
    total_entries: roots.reduce(
      (sum, root) => sum + root.entries.length,
      0,
    ),
  };
}

function request(tool = "rotate_pdf_pages") {
  return {
    protocol: "pdf-tools.deep-malformed-row-request.v3",
    fixture: {
      name: "deep-nested-arrays",
      klass: "deep",
      note_sha256: SHA_B,
      path: FIXTURE_PATH,
      bytes: 100,
      sha256: SHA_A,
    },
    tool,
    call_timeout_ms: 45_000,
    canary_timeout_ms: 10_000,
    evidence_limits: {
      inventory_entries: 512,
      per_file_bytes: 250 << 20,
      aggregate_inventory_bytes: 500 << 20,
      response_bytes: 4 << 20,
      response_nodes: 100_000,
      scanner_string_bytes: 4 << 20,
      semantic_fingerprint_bytes: 64 << 20,
      qpdf_timeout_ms: 10_000,
      qpdf_output_bytes: 1024 * 1024,
      row_result_bytes: 1024 * 1024,
    },
    qpdf: {
      path: nativeTestPath("/opt/homebrew/bin/qpdf"),
      bytes: 100,
      sha256: SHA_A,
      mode: 0o755,
      links: 1,
      version: "qpdf version 12.2.0",
    },
    qpdf_budget_exec: {
      binary: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/qpdf-budget-exec",
        { mode: 0o700, hash: SHA_C },
      ),
      policy: QPDF_POLICY,
    },
  };
}

function greenErrorRecord(tool = "rotate_pdf_pages") {
  const rowRequest = request(tool);
  const baseline = inventory();
  const serverValue = "Wed Jul 29 00:00:00 2026 1234";
  const product = response({
    isError: true,
    structuredError: {
      status: "failed",
      error_schema_version: 1,
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
    },
  });
  const fixture = {
    source: rowIdentity(FIXTURE_PATH, {
      device: "1",
      inode: "10",
    }),
    input: rowIdentity(
      path.join(WORK_ROOT, "input", "candidate.pdf"),
      { device: "2", inode: "20" },
    ),
    control: rowIdentity(
      path.join(WORK_ROOT, "input", "control.pdf"),
      {
        bytes: 728,
        hash: CONTROL_SHA,
        device: "2",
        inode: "21",
      },
    ),
  };
  return {
    protocol: "pdf-tools.deep-malformed-row-result.v3",
    request: rowRequest,
    fixture,
    identity_observations: {
      baseline: structuredClone(fixture),
      final: structuredClone(fixture),
      unchanged: true,
    },
    execution: {
      runner_pid: 1233,
      inherited_containment: { pid: 1233, pgid: 1233 },
      server: {
        pid: 1234,
        value: serverValue,
        sha256: sha256(serverValue),
      },
      post_server: {
        pid: 1234,
        value: serverValue,
        sha256: sha256(serverValue),
      },
      server_closed_unexpectedly: false,
      total_elapsed_ns: 1_000_000,
      product_elapsed_ns: 500_000,
    },
    baseline_canary: response(),
    baseline_pdfjs_canary: null,
    baseline_inventory: baseline,
    product,
    immediate_inventory: structuredClone(baseline),
    same_server_canary: response(),
    same_server_pdfjs_canary: null,
    final_inventory: structuredClone(baseline),
    inventory_policy: campaignV3Internals.rederiveInventoryPolicy({
      request: rowRequest,
      baseline,
      immediate: baseline,
      final: baseline,
      product,
    }),
    output_validation: {
      required: false,
      pass: true,
      outputs: [],
    },
  };
}

function assertions(record, outer = record.final_inventory) {
  return campaignV3Internals.validateRowRecord(
    record,
    record.request,
    {
      fixture: record.request.fixture.name,
      tool: record.request.tool,
    },
    WORK_ROOT,
    outer,
    true,
  );
}

function assertGreen(values) {
  assert.deepEqual(
    Object.entries(values).filter(([, value]) => value !== true),
    [],
  );
}

function plan() {
  const identity = (name, options = {}) =>
    evidenceIdentity(`/private/tmp/pdf-tools-v2-test/${name}`, options);
  const dependency = (key, name, version) => ({
    name,
    version,
    package_json: identity(`${key}-package.json`),
  });
  return {
    protocol: "pdf-tools.deep-malformed-macos-campaign-plan.v3",
    logical_run_label: "run-a",
    attempt_root: nativeTestPath("/private/tmp/pdf-tools-v2-test/run-a"),
    candidate: {
      path: nativeTestPath("/private/tmp/pdf-tools-v2-test/candidate"),
      head: HEAD,
      tree: TREE,
      controller: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/candidate/test/eval/"
          + "deep-malformed-macos-campaign-v3.js",
      ),
      runner: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/candidate/test/helpers/"
          + "deep-malformed-row-runner-v3.js",
      ),
      server_entry: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/candidate/server/index.js",
      ),
      fixture_module: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/candidate/test/helpers/"
          + "deep-malformed-fixtures.js",
      ),
      package_lock: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/candidate/package-lock.json",
      ),
      dependencies: {
        sdk: {
          name: "@modelcontextprotocol/sdk",
          version: "1.30.2",
          package_json: evidenceIdentity(
            "/private/tmp/pdf-tools-v2-test/candidate/node_modules/"
              + "@modelcontextprotocol/sdk/package.json",
          ),
        },
        pdf_lib: {
          name: "pdf-lib",
          version: "1.17.1",
          package_json: evidenceIdentity(
            "/private/tmp/pdf-tools-v2-test/candidate/node_modules/"
              + "pdf-lib/package.json",
          ),
        },
        pdfjs_dist: {
          name: "pdfjs-dist",
          version: "5.4.624",
          package_json: evidenceIdentity(
            "/private/tmp/pdf-tools-v2-test/candidate/node_modules/"
              + "pdfjs-dist/package.json",
          ),
        },
        canvas: {
          name: "@napi-rs/canvas",
          version: "0.1.80",
          package_json: evidenceIdentity(
            "/private/tmp/pdf-tools-v2-test/candidate/node_modules/"
              + "@napi-rs/canvas/package.json",
          ),
        },
      },
    },
    supervisor: {
      binary: identity("supervisor", { mode: 0o755 }),
      build_receipt: identity("supervisor-build.json", { mode: 0o600 }),
    },
    qpdf_budget_exec: {
      binary: identity("qpdf-budget-exec", {
        mode: 0o700,
        hash: SHA_C,
      }),
      build_receipt: identity("qpdf-budget-build.json", {
        mode: 0o600,
        hash: SHA_C,
      }),
      policy: QPDF_POLICY,
    },
    corpus: {
      comparison: identity("corpus-comparison.json", { mode: 0o600 }),
      manifest: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/generation-a/manifest.json",
        { mode: 0o600 },
      ),
      provision_controller: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/candidate/test/eval/"
          + "provision-deep-malformed-corpus-v2.js",
      ),
      provisioner: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/candidate/test/helpers/"
          + "deep-malformed-corpus-provisioner-v2.js",
      ),
      logical_fixture_digest: SHA_A,
    },
    qpdf: {
      path: nativeTestPath("/opt/homebrew/bin/qpdf"),
      bytes: 100,
      sha256: SHA_A,
      mode: 0o555,
      links: 1,
      version: "qpdf version 12.2.0",
    },
    runtime: {
      node: {
        version: "v26.3.1",
        executable: identity("node", { mode: 0o555 }),
      },
    },
    timeouts: {
      product_ms: 45_000,
      canary_ms: 10_000,
    },
    native_limits: {
      deadline_ms: 60_000,
      leader_exit_grace_ms: 1000,
      sample_interval_ms: 5,
      stdout_max_bytes: 1024 * 1024,
      stderr_max_bytes: 1024 * 1024,
      physical_footprint_max_bytes: 2 * 2 ** 30,
      address_space_bytes: 512 * 2 ** 30,
      cpu_seconds: 60,
      file_size_bytes: 1024 * 1024 * 1024,
      nofile: 512,
    },
    evidence_limits: {
      inventory_entries: 512,
      per_file_bytes: 250 << 20,
      aggregate_inventory_bytes: 500 << 20,
      response_bytes: 4 << 20,
      response_nodes: 100_000,
      scanner_string_bytes: 4 << 20,
      semantic_fingerprint_bytes: 64 << 20,
      qpdf_timeout_ms: 10_000,
      qpdf_output_bytes: 1024 * 1024,
      row_result_bytes: 1024 * 1024,
      campaign_result_bytes: 16 << 20,
    },
    matrix: campaignV3Internals.expectedMatrix(),
  };
}

function candidateOwnedPaths(validPlan) {
  return [
    validPlan.candidate.controller,
    validPlan.candidate.runner,
    validPlan.candidate.server_entry,
    validPlan.candidate.fixture_module,
    validPlan.candidate.package_lock,
    validPlan.candidate.dependencies.sdk.package_json,
    validPlan.candidate.dependencies.pdf_lib.package_json,
    validPlan.candidate.dependencies.pdfjs_dist.package_json,
    validPlan.candidate.dependencies.canvas.package_json,
    validPlan.corpus.provision_controller,
    validPlan.corpus.provisioner,
  ];
}

function corpusComparison(validPlan) {
  const logicalFixtures = DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.map(
    (name, index) => ({
      name,
      klass: DEEP_FIXTURE_CATALOG.find(row => row.name === name).klass,
      note_sha256: index % 2 === 0 ? SHA_A : SHA_B,
      bytes: 100 + index,
      sha256: index % 2 === 0 ? SHA_A : SHA_B,
      generator_sha256: validPlan.candidate.fixture_module.sha256,
      node_version: validPlan.runtime.node.version,
      node_sha256: validPlan.runtime.node.executable.sha256,
      zlib_version: process.versions.zlib,
    }),
  );
  validPlan.corpus.logical_fixture_digest = sha256(
    canonicalJson(logicalFixtures),
  );
  return {
    protocol: "pdf-tools.deep-malformed-corpus-reproducibility.v2",
    candidate: {
      path: validPlan.candidate.path,
      head: validPlan.candidate.head,
      tree: validPlan.candidate.tree,
    },
    controller: validPlan.corpus.provision_controller,
    fixture_generator: validPlan.candidate.fixture_module,
    provisioner: validPlan.corpus.provisioner,
    supervisor: {
      binary: validPlan.supervisor.binary,
      build_receipt: validPlan.supervisor.build_receipt,
    },
    manifests: {
      generation_a: validPlan.corpus.manifest,
      generation_b: evidenceIdentity(
        "/private/tmp/pdf-tools-v2-test/generation-b/manifest.json",
        { mode: 0o600 },
      ),
    },
    logical_fixtures: logicalFixtures,
    logical_fixture_digest: validPlan.corpus.logical_fixture_digest,
    result: {
      planned_generations: 2,
      accepted_generations: 2,
      fixtures_per_generation: 13,
      all_provisioning_rows_product_owned: true,
      byte_reproducible: true,
      status: "pass",
    },
  };
}

test("v1 campaign sources remain frozen byte-for-byte", async () => {
  const authorities = [
    [
      "test/helpers/deep-malformed-row-runner.js",
      "f68369badeda3b30df03131775f7b7a64996d6ea6eeccb4906f96855de4f7e6e",
    ],
    [
      "test/eval/deep-malformed-macos-campaign.js",
      "b65fa16e2992d20fcea5d22d6c21f2dfd59076514a2793e153b432707cdda01c",
    ],
  ];
  for (const [relative, expected] of authorities) {
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(path.join(REPO_ROOT, relative)))
        .digest("hex"),
      expected,
    );
  }
});

test("v2 plan freezes one exact, duplicate-free 13 x 6 matrix", () => {
  const valid = plan();
  assert.doesNotThrow(() => campaignV3Internals.validatePlan(valid));
  assert.equal(valid.matrix.length, 78);
  assert.equal(
    new Set(valid.matrix.map(row => `${row.fixture}\0${row.tool}`)).size,
    78,
  );
  const omitted = structuredClone(valid);
  omitted.matrix.pop();
  assert.throws(() => campaignV3Internals.validatePlan(omitted));
  const duplicate = structuredClone(valid);
  duplicate.matrix[77] = structuredClone(duplicate.matrix[0]);
  assert.throws(() => campaignV3Internals.validatePlan(duplicate));
  const unknown = structuredClone(valid);
  unknown.matrix[0].fixture = "later-attribution-fixture";
  assert.throws(() => campaignV3Internals.validatePlan(unknown));

  for (const owned of candidateOwnedPaths(valid)) {
    const relocated = structuredClone(valid);
    const target = candidateOwnedPaths(relocated).find(
      value => value.path === owned.path,
    );
    target.path = `/private/tmp/external/${path.basename(target.path)}`;
    assert.throws(() => campaignV3Internals.validatePlan(relocated));
  }
});

test("corpus comparison is rederived instead of trusting its pass label", () => {
  const validPlan = plan();
  const comparison = corpusComparison(validPlan);
  assert.doesNotThrow(() =>
    campaignV3Internals.validateCorpusComparison(
      comparison,
      validPlan.candidate,
      validPlan.corpus,
    ));

  const digestDrift = structuredClone(comparison);
  digestDrift.logical_fixtures[0].bytes += 1;
  assert.throws(() =>
    campaignV3Internals.validateCorpusComparison(
      digestDrift,
      validPlan.candidate,
      validPlan.corpus,
    ));

  const sourceDrift = structuredClone(comparison);
  sourceDrift.controller.path =
    "/private/tmp/pdf-tools-v2-test/external/controller.js";
  assert.throws(() =>
    campaignV3Internals.validateCorpusComparison(
      sourceDrift,
      validPlan.candidate,
      validPlan.corpus,
    ));

  const resultDrift = structuredClone(comparison);
  resultDrift.result.accepted_generations = 1;
  assert.throws(() =>
    campaignV3Internals.validateCorpusComparison(
      resultDrift,
      validPlan.candidate,
      validPlan.corpus,
    ));
});

test("green typed-error row is accepted only with independently matching final state", () => {
  const record = greenErrorRecord();
  assertGreen(assertions(record));
  const mismatchedOuter = structuredClone(record.final_inventory);
  mismatchedOuter.roots[0].entries[0].sha256 = SHA_B;
  assert.equal(
    assertions(record, mismatchedOuter).outer_final_inventory,
    false,
  );
  assert.equal(
    campaignV3Internals.validateRowRecord(
      record,
      record.request,
      {
        fixture: record.request.fixture.name,
        tool: record.request.tool,
      },
      WORK_ROOT,
      record.final_inventory,
      false,
    ).outer_qpdf_stable,
    false,
  );
});

test("rich read-content error classification is accepted only for that tool", () => {
  const record = greenErrorRecord("read_pdf_content");
  record.baseline_pdfjs_canary = response();
  record.same_server_pdfjs_canary = response();
  record.product.response.structured_error = {
    status: "failed",
    error_schema_version: null,
    code: "content_extraction_failed",
  };
  assertGreen(assertions(record));

  record.request.tool = "rotate_pdf_pages";
  assert.equal(assertions(record).product_error_contract, false);
});

test("row cannot self-certify output-on-error or extra split output", () => {
  const outputOnError = greenErrorRecord();
  const rotateFile = {
    path: "rotated.pdf",
    kind: "file",
    mode: 0o600,
    bytes: 100,
    sha256: SHA_B,
    links: 1,
  };
  outputOnError.immediate_inventory = inventory({
    rotateEntries: [rotateFile],
  });
  outputOnError.final_inventory =
    structuredClone(outputOnError.immediate_inventory);
  outputOnError.inventory_policy = {
    output_kind: "rotate",
    product_succeeded: false,
    non_outputs_unchanged: true,
    expected_output_delta: true,
    final_matches_immediate: true,
    pass: true,
  };
  assert.equal(
    assertions(
      outputOnError,
      outputOnError.final_inventory,
    ).inventories,
    false,
  );

  const splitExtra = greenErrorRecord("split_pdf");
  splitExtra.product = response();
  const splitFiles = ["candidate_pages_1-1.pdf", "unexpected.pdf"].map(
    (filename, index) => ({
      path: filename,
      kind: "file",
      mode: 0o600,
      bytes: 100 + index,
      sha256: index === 0 ? SHA_A : SHA_B,
      links: 1,
    }),
  );
  splitExtra.immediate_inventory = inventory({
    splitEntries: splitFiles,
  });
  splitExtra.final_inventory = structuredClone(splitExtra.immediate_inventory);
  splitExtra.inventory_policy = {
    output_kind: "split",
    product_succeeded: true,
    non_outputs_unchanged: true,
    expected_output_delta: true,
    final_matches_immediate: true,
    pass: true,
  };
  assert.equal(
    assertions(splitExtra, splitExtra.final_inventory).inventories,
    false,
  );
});

test("invalid successful mutator output fails independent validation contract", () => {
  const record = greenErrorRecord();
  record.product = response();
  const rotateFile = {
    path: "rotated.pdf",
    kind: "file",
    mode: 0o600,
    bytes: 100,
    sha256: SHA_B,
    links: 1,
  };
  record.immediate_inventory = inventory({
    rotateEntries: [rotateFile],
  });
  record.final_inventory = structuredClone(record.immediate_inventory);
  record.inventory_policy = campaignV3Internals.rederiveInventoryPolicy({
    request: record.request,
    baseline: record.baseline_inventory,
    immediate: record.immediate_inventory,
    final: record.final_inventory,
    product: record.product,
  });
  record.output_validation = {
    required: true,
    pass: true,
    outputs: [{
      identity: rowIdentity(
        path.join(WORK_ROOT, "outputs", "rotate", "rotated.pdf"),
        {
          hash: SHA_B,
          mode: 0o600,
          device: "2",
          inode: "30",
        },
      ),
      nonalias: true,
      qpdf_stable: true,
      qpdf_check: budgetedQpdf(""),
      qpdf_pages: budgetedQpdf("1\n"),
      semantic: {
        loadable: true,
        pages: 1,
        finite_geometry: true,
        first_page_rotation: 90,
      },
      semantic_fingerprint: semanticFingerprint(),
    }],
  };
  assertGreen(assertions(record));
  assert.equal(
    campaignComparisonV3Internals.outputSemantics(record.output_validation)
      .outputs[0].semantic_fingerprint.canonicalization.command_pass,
    true,
  );

  const swappedCheckPath = structuredClone(record);
  swappedCheckPath.output_validation.outputs[0].qpdf_check
    .containment.input.path = "/private/tmp/replaced-check.pdf";
  assert.equal(assertions(swappedCheckPath).output, false);

  const swappedCheckHash = structuredClone(record);
  swappedCheckHash.output_validation.outputs[0].qpdf_check
    .containment.input.sha256 = SHA_A;
  assert.equal(assertions(swappedCheckHash).output, false);

  const swappedCheckKernelIdentity = structuredClone(record);
  swappedCheckKernelIdentity.output_validation.outputs[0].qpdf_check
    .containment.input.device = "99";
  swappedCheckKernelIdentity.output_validation.outputs[0].qpdf_check
    .containment.input.inode = "98";
  swappedCheckKernelIdentity.output_validation.outputs[0].qpdf_check
    .containment.ready.input.device = "99";
  swappedCheckKernelIdentity.output_validation.outputs[0].qpdf_check
    .containment.ready.input.inode = "98";
  assert.equal(assertions(swappedCheckKernelIdentity).output, false);

  const swappedProjectionSource = structuredClone(record);
  swappedProjectionSource.output_validation.outputs[0].semantic_fingerprint
    .canonicalization.command.containment.input.path =
      "/private/tmp/replaced-projection-source.pdf";
  assert.equal(assertions(swappedProjectionSource).output, false);

  const swappedProjectionJsonInput = structuredClone(record);
  swappedProjectionJsonInput.output_validation.outputs[0].semantic_fingerprint
    .command.containment.input.sha256 = SHA_A;
  assert.equal(assertions(swappedProjectionJsonInput).output, false);

  const swappedProjectionKernelIdentity = structuredClone(record);
  const swappedProjectionCommand =
    swappedProjectionKernelIdentity.output_validation.outputs[0]
      .semantic_fingerprint.command;
  swappedProjectionCommand.containment.input.inode = "97";
  swappedProjectionCommand.containment.ready.input.inode = "97";
  assert.equal(assertions(swappedProjectionKernelIdentity).output, false);

  const invalidQpdf = structuredClone(record);
  invalidQpdf.output_validation.outputs[0].qpdf_check.command.code = 1;
  assert.equal(assertions(invalidQpdf).output, false);

  const limitBypass = structuredClone(record);
  limitBypass.output_validation.outputs[0].qpdf_check
    .containment.ready.limits.address_space.maximum -= 1;
  assert.equal(assertions(limitBypass).output, false);

  const baselineBypass = structuredClone(record);
  baselineBypass.output_validation.outputs[0].qpdf_check
    .containment.ready.address_space_baseline_bytes = 0;
  assert.equal(assertions(baselineBypass).output, false);

  const headroomBypass = structuredClone(record);
  headroomBypass.output_validation.outputs[0].qpdf_check
    .containment.ready.address_space_headroom_bytes -= 1;
  assert.equal(assertions(headroomBypass).output, false);

  const observedSizeBypass = structuredClone(record);
  observedSizeBypass.output_validation.outputs[0].qpdf_check
    .containment.ready.address_space_observed_bytes =
      QPDF_ADDRESS_SPACE_BASELINE_BYTES
        + QPDF_POLICY.address_space_headroom_bytes + 1;
  assert.equal(assertions(observedSizeBypass).output, false);

  const groupBypass = structuredClone(record);
  groupBypass.output_validation.outputs[0].qpdf_pages
    .containment.expected_pgid += 1;
  groupBypass.output_validation.outputs[0].qpdf_pages
    .containment.ready.pgid += 1;
  assert.equal(assertions(groupBypass).output, false);

  const launcherBypass = structuredClone(record);
  launcherBypass.output_validation.outputs[0].qpdf_check
    .containment.launcher_sha256 = SHA_A;
  assert.equal(assertions(launcherBypass).output, false);

  const invalidFingerprint = structuredClone(record);
  invalidFingerprint.output_validation.outputs[0]
    .semantic_fingerprint.normalized.sha256 = "not-a-digest";
  assert.equal(assertions(invalidFingerprint).output, false);

  const inventoryMismatch = structuredClone(record);
  inventoryMismatch.output_validation.outputs[0].identity.sha256 = SHA_C;
  assert.equal(assertions(inventoryMismatch).output, false);
});

test("malformed inventories, server replacement, timeout, kill, and leaks fail closed", () => {
  const cases = [];

  const symlink = greenErrorRecord();
  symlink.final_inventory.roots[0].entries[0] = {
    path: "candidate.pdf",
    kind: "symlink",
    mode: 0o777,
  };
  cases.push([symlink, "inventories"]);

  const hardlink = greenErrorRecord();
  hardlink.final_inventory.roots[0].entries[0].links = 2;
  cases.push([hardlink, "inventories"]);

  const huge = greenErrorRecord();
  huge.final_inventory.roots[0].entries[0].bytes = (250 << 20) + 1;
  cases.push([huge, "inventories"]);

  const replacement = greenErrorRecord();
  replacement.execution.post_server.pid += 1;
  cases.push([replacement, "server_identity"]);

  const sameBytesNewInode = greenErrorRecord();
  sameBytesNewInode.identity_observations.final.input.inode = "999";
  cases.push([sameBytesNewInode, "input_identity_unchanged"]);

  const timeout = greenErrorRecord();
  timeout.product = {
    outcome: "transport_error",
    error: { timeout: true },
  };
  cases.push([timeout, "product_response"]);

  const killed = greenErrorRecord();
  delete killed.product;
  cases.push([killed, "top_level_schema"]);

  const leak = greenErrorRecord();
  leak.product.response.scanner.raw_internal_matches = 1;
  leak.product.response.scanner.pass = false;
  cases.push([leak, "product_response"]);

  const malformed = greenErrorRecord();
  malformed.unexpected = true;
  cases.push([malformed, "top_level_schema"]);

  for (const [record, failedAssertion] of cases) {
    assert.equal(assertions(record)[failedAssertion], false);
  }
});

test("two-run logical comparison ignores only declared nondeterminism", () => {
  const recordA = greenErrorRecord();
  const rowA = {
    ordinal: 1,
    matrix: {
      fixture: recordA.request.fixture.name,
      tool: recordA.request.tool,
    },
    candidate_stdout: { record: recordA },
    assertions: assertions(recordA),
    outer_final_inventory: {
      canonical_bytes: 100,
      sha256: SHA_A,
      error: null,
    },
    supervisor_evidence_valid: true,
    product_boundary_owned: true,
    qualification_pass: true,
  };
  const rowB = structuredClone(rowA);
  rowB.candidate_stdout.record.execution.runner_pid = 9999;
  rowB.candidate_stdout.record.execution.server.pid = 9998;
  rowB.candidate_stdout.record.execution.post_server.pid = 9998;
  rowB.candidate_stdout.record.execution.product_elapsed_ns = 999_999;
  rowB.candidate_stdout.record.fixture.input.device = "999";
  rowB.candidate_stdout.record.fixture.input.inode = "999";
  rowB.candidate_stdout.record.product.response.canonical_bytes = 900;
  rowB.candidate_stdout.record.product.response.sha256 = SHA_B;
  assert.deepEqual(
    campaignComparisonV3Internals.logicalRow(rowA),
    campaignComparisonV3Internals.logicalRow(rowB),
  );

  rowB.candidate_stdout.record.product.response.scanner
    .normalized_response.sha256 = SHA_B;
  assert.notDeepEqual(
    campaignComparisonV3Internals.logicalRow(rowA),
    campaignComparisonV3Internals.logicalRow(rowB),
  );
  rowB.candidate_stdout.record.product.response.scanner
    .normalized_response.sha256 = SHA_A;

  rowB.candidate_stdout.record.product.response.structured_error.code =
    "tool_execution_failed";
  assert.notDeepEqual(
    campaignComparisonV3Internals.logicalRow(rowA),
    campaignComparisonV3Internals.logicalRow(rowB),
  );

  const planA = plan();
  const planB = structuredClone(planA);
  planB.logical_run_label = "run-b";
  planB.attempt_root = nativeTestPath(
    "/private/tmp/pdf-tools-v2-test/run-b",
  );
  assert.deepEqual(
    campaignComparisonV3Internals.normalizedPlan(planA),
    campaignComparisonV3Internals.normalizedPlan(planB),
  );
});

test("comparator rejects malformed embedded plans and authority drift", () => {
  const embeddedPlan = plan();
  const planIdentity = evidenceIdentity(
    "/private/tmp/pdf-tools-v2-test/plan-a.json",
    { mode: 0o600 },
  );
  const receipt = {
    protocol: "pdf-tools.deep-malformed-macos-campaign-result.v3",
    plan: {
      identity: planIdentity,
      value: embeddedPlan,
    },
    environment: {
      hostname: "silverbook",
      platform: "darwin",
      release: "26.6",
      architecture: "arm64",
      node: embeddedPlan.runtime.node,
    },
    candidate: embeddedPlan.candidate,
    supervisor: embeddedPlan.supervisor,
    qpdf_budget_exec: embeddedPlan.qpdf_budget_exec,
    corpus: {
      comparison: embeddedPlan.corpus.comparison,
      manifest: embeddedPlan.corpus.manifest,
      provision_controller: embeddedPlan.corpus.provision_controller,
      provisioner: embeddedPlan.corpus.provisioner,
      logical_fixture_digest: embeddedPlan.corpus.logical_fixture_digest,
    },
    rows: [],
    summary: {},
  };
  const authority = {
    identity: planIdentity,
    value: embeddedPlan,
  };
  assert.equal(
    campaignComparisonV3Internals.receiptAuthoritiesValid(
      receipt,
      "run-a",
      authority,
    ),
    true,
  );

  const candidateDrift = structuredClone(receipt);
  candidateDrift.candidate.head = HEAD.replace(/^./, "0");
  assert.equal(
    campaignComparisonV3Internals.receiptAuthoritiesValid(
      candidateDrift,
      "run-a",
      authority,
    ),
    false,
  );

  const malformedPlan = structuredClone(receipt);
  malformedPlan.plan.value.matrix[1] =
    structuredClone(malformedPlan.plan.value.matrix[0]);
  assert.equal(
    campaignComparisonV3Internals.receiptAuthoritiesValid(
      malformedPlan,
      "run-a",
      authority,
    ),
    false,
  );

  const identityDrift = structuredClone(receipt);
  identityDrift.plan.identity.sha256 = SHA_B;
  assert.equal(
    campaignComparisonV3Internals.receiptAuthoritiesValid(
      identityDrift,
      "run-a",
      authority,
    ),
    false,
  );

  const corpusDrift = structuredClone(receipt);
  corpusDrift.corpus.logical_fixture_digest = SHA_B;
  assert.equal(
    campaignComparisonV3Internals.receiptAuthoritiesValid(
      corpusDrift,
      "run-a",
      authority,
    ),
    false,
  );

  const externalAttempt = structuredClone(receipt);
  externalAttempt.plan.value.attempt_root =
    "/private/tmp/external/run-a";
  const externalAuthority = {
    identity: externalAttempt.plan.identity,
    value: externalAttempt.plan.value,
  };
  assert.equal(
    campaignComparisonV3Internals.receiptAuthoritiesValid(
      externalAttempt,
      "run-a",
      externalAuthority,
    ),
    false,
  );
});
