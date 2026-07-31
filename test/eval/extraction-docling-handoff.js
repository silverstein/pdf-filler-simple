import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { computeDoclingHandoffId } from "./extraction-docling-handoff-verifier.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_HANDOFF_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FIXTURE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_BYTES = 128 * 1024 * 1024;
const TEST_CAPABILITY = Symbol("docling-handoff-test-capability");
const UV_VERSION = /^uv [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?(?: \([a-f0-9]{7,40} ([0-9]{4})-([0-9]{2})-([0-9]{2}) [a-z0-9_]+(?:-[a-z0-9_]+){2,4}\))?$(?![\s\S])/;
export const DOCLING_SUPERVISOR_POLICY_V1 = Object.freeze({
  protocol: "pdf-tools.docling-macos-supervisor-policy.v1",
  calibration_attestation_sha256: "8a532eea6c54ebbdc7d1509296efb763a6cda6ca0756b34970cbe8bad934f778",
  sample_interval_ms: 50,
  leader_exit_grace_ms: 2000,
  sampled_group_physical_footprint_max_bytes: 4 * 1024 * 1024 * 1024,
  address_space_bytes: 1024 * 1024 * 1024 * 1024,
  cpu_seconds: 120,
  file_size_bytes: 512 * 1024 * 1024,
  nofile: 1024,
});
export const DOCLING_BOOTSTRAP_V1 = [
  "set -eu",
  "umask 077",
  "node=$1; node_sha=$2; node_bytes=$3; node_mode=$4; node_links=$5",
  "cli=$6; cli_sha=$7; cli_bytes=$8; cli_mode=$9; shift 9",
  "cli_links=$1; verifier=$2; verifier_sha=$3; verifier_bytes=$4; verifier_mode=$5; verifier_links=$6",
  "seal_parent=$7; authority_home=$8; authority_tmp=$9; shift 9",
  "os=$(/usr/bin/uname -s)",
  "check_file() {",
  "  file=$1; expected_sha=$2; expected_bytes=$3; expected_mode=$4; expected_links=$5",
  "  if [ \"$os\" = Darwin ]; then metadata=$(/usr/bin/stat -f '%HT|%Lp|%l|%z' \"$file\"); else metadata=$(/usr/bin/stat -c '%F|%a|%h|%s' \"$file\"); fi",
  "  old_ifs=$IFS; IFS='|'; set -- $metadata; IFS=$old_ifs",
  "  { [ \"$1\" = 'Regular File' ] || [ \"$1\" = 'regular file' ]; } || return 70",
  "  [ \"$2\" = \"$expected_mode\" ] && [ \"$3\" = \"$expected_links\" ] && [ \"$4\" = \"$expected_bytes\" ] || return 71",
  "  digest=$(/usr/bin/shasum -a 256 \"$file\"); digest=${digest%% *}",
  "  [ \"$digest\" = \"$expected_sha\" ] || return 72",
  "}",
  "check_file \"$node\" \"$node_sha\" \"$node_bytes\" \"$node_mode\" \"$node_links\"",
  "check_file \"$cli\" \"$cli_sha\" \"$cli_bytes\" \"$cli_mode\" \"$cli_links\"",
  "check_file \"$verifier\" \"$verifier_sha\" \"$verifier_bytes\" \"$verifier_mode\" \"$verifier_links\"",
  "seal=$(/usr/bin/mktemp -d \"$seal_parent/.bootstrap-seal.XXXXXX\")",
  "trap '/bin/rm -rf \"$seal\"' EXIT HUP INT TERM",
  "/bin/chmod 700 \"$seal\"",
  "/bin/cp \"$cli\" \"$seal/eval-verify-docling-macos-handoff.mjs\"",
  "/bin/cp \"$verifier\" \"$seal/extraction-docling-handoff-verifier.js\"",
  "/bin/chmod 400 \"$seal/eval-verify-docling-macos-handoff.mjs\" \"$seal/extraction-docling-handoff-verifier.js\"",
  "check_file \"$seal/eval-verify-docling-macos-handoff.mjs\" \"$cli_sha\" \"$cli_bytes\" 400 1",
  "check_file \"$seal/extraction-docling-handoff-verifier.js\" \"$verifier_sha\" \"$verifier_bytes\" 400 1",
  "check_file \"$node\" \"$node_sha\" \"$node_bytes\" \"$node_mode\" \"$node_links\"",
  "set +e",
  "/usr/bin/env -i HOME=\"$authority_home\" TMPDIR=\"$authority_tmp\" PATH=/usr/bin:/bin LANG=C LC_ALL=C \"$node\" \"$seal/eval-verify-docling-macos-handoff.mjs\" \"$@\"",
  "status=$?",
  "set -e",
  "check_file \"$node\" \"$node_sha\" \"$node_bytes\" \"$node_mode\" \"$node_links\"",
  "check_file \"$cli\" \"$cli_sha\" \"$cli_bytes\" \"$cli_mode\" \"$cli_links\"",
  "check_file \"$verifier\" \"$verifier_sha\" \"$verifier_bytes\" \"$verifier_mode\" \"$verifier_links\"",
  "exit \"$status\"",
].join("\n");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isValidDoclingUvVersion(value) {
  if (typeof value !== "string") return false;
  const match = UV_VERSION.exec(value);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const [year, month, day] = match.slice(1, 4).map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function commandOutput(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error(`Unable to inspect ${executable}`);
  return result.stdout.trim();
}

async function observedHost(testOnlyHost, capability) {
  if (testOnlyHost !== null) {
    if (capability !== TEST_CAPABILITY) throw new Error("Docling host override requires the private test capability");
    return structuredClone(testOnlyHost);
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Docling handoff requires darwin/arm64");
  return {
    platform: process.platform,
    architecture: process.arch,
    os_build: commandOutput("/usr/bin/sw_vers", ["-buildVersion"]),
    kernel_release: os.release(),
    node_version: process.version,
  };
}

async function observedUv(testOnlyUv, capability) {
  if (testOnlyUv !== null && capability !== TEST_CAPABILITY) throw new Error("Docling uv override requires the private test capability");
  const requestedPath = testOnlyUv?.path ?? commandOutput("/usr/bin/which", ["uv"]);
  const uvPath = await fs.realpath(requestedPath);
  const metadata = await fs.lstat(uvPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("uv must resolve to a single-link regular binary");
  const bytes = await readStableRegularFile(uvPath, MAX_TOOL_BYTES);
  const version = testOnlyUv?.version ?? commandOutput(uvPath, ["--version"]);
  if (!isValidDoclingUvVersion(version)) throw new Error("uv version output is invalid");
  return { path: uvPath, version, bytes: bytes.length, sha256: sha256(bytes), mode: metadata.mode & 0o777, links: metadata.nlink };
}

async function observedNode() {
  const nodePath = await fs.realpath(process.execPath);
  const metadata = await fs.lstat(nodePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("Node must resolve to a single-link regular binary");
  const bytes = await readStableRegularFile(nodePath, MAX_TOOL_BYTES);
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(process.version)) throw new Error("Node version is invalid");
  return { path: nodePath, version: process.version, bytes: bytes.length, sha256: sha256(bytes), mode: metadata.mode & 0o777, links: metadata.nlink };
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function defaultDoclingMacRoots(home = os.homedir()) {
  return {
    cacheRoot: path.join(home, "Library", "Caches", "oda-pdf-tools-extraction"),
    sidecarRoot: path.join(home, "Sites", "pdf-tools-extraction-sidecars"),
    protectedRoots: [
      path.join(home, "Documents"),
      path.join(home, "Dropbox"),
      path.join(home, "Library", "Mobile Documents"),
      path.join(home, "Library", "CloudStorage"),
    ],
  };
}

async function assertNoSymlinkAncestors(filename) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const metadata = await fs.lstat(cursor);
      if (metadata.isSymbolicLink()) throw new Error(`Handoff path contains a symbolic link: ${cursor}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function secureDirectory(directory) {
  await assertNoSymlinkAncestors(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestors(directory);
  const [metadata, resolved] = await Promise.all([fs.lstat(directory), fs.realpath(directory)]);
  if (!metadata.isDirectory() || resolved !== path.resolve(directory) || (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`Handoff directory must be a real mode-0700 directory: ${directory}`);
  }
  return resolved;
}

async function readStableRegularFile(filename, maxBytes = MAX_HANDOFF_FILE_BYTES) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Docling handoff requires O_NOFOLLOW support");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`Handoff input must be a bounded, single-link regular file: ${filename}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const property of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (String(before[property]) !== String(after[property])) throw new Error(`Handoff input changed while read: ${filename}`);
    }
    if (BigInt(bytes.length) !== before.size) throw new Error(`Handoff input length changed while read: ${filename}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filename, bytes, mode = 0o600) {
  const handle = await fs.open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await fs.lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== mode) {
    throw new Error(`Handoff output did not retain its strict file contract: ${filename}`);
  }
}

function protectedRootDigest(protectedRoots) {
  return sha256(Buffer.from(`pdf-tools.docling-protected-roots.v1\0${canonicalJson([...protectedRoots].map(value => path.resolve(value)).sort())}`));
}

export async function phase0PdfPaths(repoRoot = REPO_ROOT) {
  const manifestPath = path.join(repoRoot, "test/fixtures/eval/extraction/manifest.v1.json");
  const manifest = JSON.parse(await readStableRegularFile(manifestPath, 1024 * 1024));
  if (manifest.suite_id !== "pdf-tools.extraction.phase0" || !Array.isArray(manifest.fixtures)) {
    throw new Error("Phase 0 manifest identity is invalid");
  }
  const fixturePaths = [];
  for (const fixture of manifest.fixtures) {
    const fixturePath = path.resolve(path.dirname(manifestPath), fixture.path);
    const bytes = await readStableRegularFile(fixturePath, MAX_FIXTURE_TOTAL_BYTES);
    if (sha256(bytes) !== fixture.sha256) throw new Error("Phase 0 fixture bytes do not match the accepted manifest");
    fixturePaths.push(fixturePath);
  }
  return fixturePaths;
}

async function prepareDoclingMacHandoffCore({
  repoRoot = REPO_ROOT,
  cacheRoot,
  sidecarRoot,
  protectedRoots,
  fixturePaths,
  testOnlyHost = null,
  testOnlyUv = null,
  testOnlyBootstrapRoot = null,
  testOnlySupervisorBuild = null,
  // Re-measuring the supervisor calibration requires a handoff, and the
  // attestation gate refuses a handoff until the calibration is fresh. That is
  // circular: the first calibration predates the gate, so the gate now blocks
  // its own renewal. This option breaks the deadlock for measurement only. The
  // resulting handoff is marked and must never be treated as qualifying
  // evidence.
  calibrationBootstrap = false,
  testCapability = null,
} = {}) {
  if (!cacheRoot || !sidecarRoot || !Array.isArray(protectedRoots) || protectedRoots.length < 1
    || !Array.isArray(fixturePaths) || fixturePaths.length < 1 || fixturePaths.length > 100) {
    throw new Error("Docling handoff requires explicit roots and at least one PDF fixture");
  }
  const [host, uv, node] = await Promise.all([observedHost(testOnlyHost, testCapability), observedUv(testOnlyUv, testCapability), observedNode()]);
  if (host.platform !== "darwin" || host.architecture !== "arm64") throw new Error("Docling handoff requires darwin/arm64");
  const resolvedCache = path.resolve(cacheRoot);
  const resolvedSidecar = path.resolve(sidecarRoot);
  for (const destination of [resolvedCache, resolvedSidecar]) {
    if (protectedRoots.some(root => within(root, destination))) {
      throw new Error("Docling handoff destinations must remain outside Documents, iCloud, Dropbox, and other protected roots");
    }
  }
  if (within(resolvedCache, resolvedSidecar) || within(resolvedSidecar, resolvedCache)) {
    throw new Error("Docling cache and sidecar roots must not contain one another");
  }
  await Promise.all([secureDirectory(resolvedCache), secureDirectory(resolvedSidecar)]);

  if (testOnlyBootstrapRoot !== null && testCapability !== TEST_CAPABILITY) throw new Error("Docling bootstrap root override requires the private test capability");
  if (testOnlySupervisorBuild !== null && testCapability !== TEST_CAPABILITY) throw new Error("Docling supervisor build override requires the private test capability");
  const bootstrapRoot = testOnlyBootstrapRoot === null ? repoRoot : path.resolve(testOnlyBootstrapRoot);
  const sourceSpecs = [
    ["adapter_entrypoint", "test/eval/candidates/docling/adapter.py"],
    ["model_setup_helper", "test/eval/candidates/docling/fetch_pinned_layout.py"],
    ["candidate_config", "test/fixtures/eval/extraction/phase1/docling-candidate-config.v1.json"],
    ["candidate_config_schema", "test/fixtures/eval/extraction/phase1/docling-candidate-config.schema.json"],
    ["candidate_request_schema", "test/fixtures/eval/extraction/phase1/candidate-request.schema.json"],
    ["candidate_response_schema", "test/fixtures/eval/extraction/phase1/candidate-response.schema.json"],
    ["handoff_schema", "test/fixtures/eval/extraction/phase1/docling-handoff.schema.json"],
    ["handoff_generator_source", "test/eval/extraction-docling-handoff.js"],
    ["handoff_verifier_source", "test/eval/extraction-docling-handoff-verifier.js", path.join(bootstrapRoot, "test/eval/extraction-docling-handoff-verifier.js")],
    ["runtime_evidence_source", "test/eval/extraction-docling-runtime-evidence.js"],
    ["handoff_authority", "scripts/eval-docling-authority.mjs"],
    ["handoff_verifier_cli", "scripts/eval-verify-docling-macos-handoff.mjs", path.join(bootstrapRoot, "scripts/eval-verify-docling-macos-handoff.mjs")],
    ["finalization_schema", "test/fixtures/eval/extraction/phase1/docling-finalization.schema.json"],
    ["supervisor_source", "test/eval/native/docling-macos-supervisor.c"],
    ["supervisor_controller", "test/eval/docling-macos-supervisor.js"],
    ["supervisor_evidence_schema", "test/fixtures/eval/extraction/phase1/docling-macos-supervisor-evidence.schema.json"],
    ["supervisor_calibration_attestation", "test/fixtures/eval/extraction/phase1/docling-supervisor-calibration-attestation.v1.json"],
    ["bakeoff_capture_source", "scripts/eval-capture-docling-bakeoff.mjs"],
  ];
  const sourceInputs = [];
  for (const [role, relativePath, overridePath] of sourceSpecs) {
    const sourcePath = overridePath ?? path.join(repoRoot, ...relativePath.split("/"));
    const bytes = await readStableRegularFile(sourcePath);
    const metadata = await fs.lstat(sourcePath);
    sourceInputs.push({ role, relativePath, sourcePath, sourceMode: metadata.mode & 0o777, sourceLinks: metadata.nlink, bytes, sha256: sha256(bytes) });
  }
  const config = JSON.parse(sourceInputs.find(item => item.role === "candidate_config").bytes);
  const configSchema = JSON.parse(sourceInputs.find(item => item.role === "candidate_config_schema").bytes);
  const configValidation = new AjvJsonSchemaValidator().getValidator(configSchema)(config);
  if (!configValidation.valid) throw new Error(`Pinned Docling configuration is invalid: ${configValidation.errorMessage}`);
  const requirementsBytes = Buffer.from(`${config.packages
    .map(item => `${item.name === "docling-slim" ? config.install_requirement : `${item.name}==${item.version}`} --hash=sha256:${item.wheel_sha256}`)
    .sort().join("\n")}\n`);
  sourceInputs.push({ role: "direct_requirements", relativePath: "direct-requirements.in", bytes: requirementsBytes, sha256: sha256(requirementsBytes) });

  const supervisorSource = sourceInputs.find(item => item.role === "supervisor_source");
  const supervisorController = sourceInputs.find(item => item.role === "supervisor_controller");
  const calibrationAttestationInput = sourceInputs.find(
    item => item.role === "supervisor_calibration_attestation",
  );
  const calibrationAttestation = JSON.parse(calibrationAttestationInput.bytes);
  const calibrationIdentity = { ...calibrationAttestation };
  delete calibrationIdentity.attestation_id;
  if (calibrationAttestation.protocol !== "pdf-tools.docling-macos-supervisor-calibration-attestation.v1"
    || calibrationAttestation.attestation_id
      !== sha256(Buffer.from(`${calibrationAttestation.protocol}\0${canonicalJson(calibrationIdentity)}`))
    || calibrationAttestationInput.sha256 !== DOCLING_SUPERVISOR_POLICY_V1.calibration_attestation_sha256
    || canonicalJson(calibrationAttestation.confirmed_policy)
      !== canonicalJson(Object.fromEntries(
        Object.entries(DOCLING_SUPERVISOR_POLICY_V1)
          .filter(([key]) => key !== "calibration_attestation_sha256"),
      ))
    || !/^[a-f0-9]{64}$/.test(calibrationAttestation.calibration_source?.sha256 ?? "")
    || !Number.isInteger(calibrationAttestation.calibration_source?.bytes)
    || calibrationAttestation.calibration_source.bytes < 1) {
    throw new Error("Docling supervisor policy lacks its exact reviewed calibration attestation");
  }
  // Source drift is a distinct state from a malformed or absent attestation.
  // The supervisor is actively developed, so its reviewed calibration goes
  // stale whenever the source legitimately moves. Reporting that as an
  // ordinary failure is what buries real defects: it turned four suites red
  // with a message that reads like corruption. Type it instead, so callers can
  // report "needs re-approval" and a red test still means a real defect.
  const attestationDrift = [
    ["supervisor source", calibrationAttestation.supervisor?.source, supervisorSource],
    ["supervisor controller", calibrationAttestation.supervisor?.controller, supervisorController],
  ].filter(([, recorded, actual]) => recorded?.sha256 !== actual.sha256
    || recorded?.bytes !== actual.bytes.length);
  if (attestationDrift.length > 0) {
    const detail = attestationDrift
      .map(([label, recorded, actual]) => `${label} recorded ${recorded?.bytes ?? "none"} bytes `
        + `${String(recorded?.sha256 ?? "none").slice(0, 12)}, actual ${actual.bytes.length} bytes `
        + `${actual.sha256.slice(0, 12)}`)
      .join("; ");
    if (!calibrationBootstrap) {
      const stale = new Error(
        "Docling supervisor calibration attestation is stale and needs review: "
        + `${detail}. This is a re-approval requirement, not a product defect.`,
      );
      stale.code = "EVAL_ATTESTATION_STALE";
      throw stale;
    }
  }
  let observedSupervisorBuild;
  let supervisorBinaryBytes;
  if (testOnlySupervisorBuild !== null) {
    supervisorBinaryBytes = Buffer.from(testOnlySupervisorBuild.binaryBytes);
    if (supervisorBinaryBytes.length < 1 || supervisorBinaryBytes.length > 4 * 1024 * 1024) {
      throw new Error("Test supervisor binary bytes are invalid");
    }
    const compilerBytes = Buffer.from("test-only-apple-clang");
    observedSupervisorBuild = {
      protocol: "pdf-tools.macos-eval-supervisor-build.v1",
      platform: {
        operating_system: "macos", architecture: "arm64",
        os_build: host.os_build, kernel_release: host.kernel_release,
      },
      source: {
        path: "/private/test/docling-macos-supervisor.c",
        bytes: supervisorSource.bytes.length, sha256: supervisorSource.sha256,
        mode: 0o600, links: 1,
      },
      compiler: {
        path: "/usr/bin/clang", bytes: compilerBytes.length, sha256: sha256(compilerBytes),
        mode: 0o755, links: 1, version: "Apple clang version 21.0.0 (test-only)",
      },
      sdk: { path: "/Applications/Xcode.app/SDKs/MacOSX.sdk", version: "26.5" },
      command: ["/usr/bin/clang", "-std=c17", "-arch", "arm64", "-isysroot", "$SDKROOT", "-o", "$OUTPUT", "$SOURCE"],
      testing: false,
      binary: {
        path: "/private/test/docling-macos-supervisor",
        bytes: supervisorBinaryBytes.length, sha256: sha256(supervisorBinaryBytes),
        mode: 0o700, links: 1,
      },
    };
  } else {
    const presealRoot = await fs.mkdtemp(path.join(resolvedCache, ".docling-supervisor-preseal-"));
    await fs.chmod(presealRoot, 0o700);
    try {
      const sourcePath = path.join(presealRoot, "docling-macos-supervisor.c");
      const binaryPath = path.join(presealRoot, "docling-macos-supervisor");
      await writeExclusive(sourcePath, supervisorSource.bytes);
      const controllerModule = await import(
        `data:text/javascript;base64,${supervisorController.bytes.toString("base64")}`,
      );
      if (typeof controllerModule.compileDoclingMacosSupervisor !== "function") {
        throw new Error("Retained supervisor controller lacks its build export");
      }
      observedSupervisorBuild = await controllerModule.compileDoclingMacosSupervisor({
        sourcePath,
        outputPath: binaryPath,
        architecture: "arm64",
      });
      supervisorBinaryBytes = await readStableRegularFile(binaryPath, 4 * 1024 * 1024);
      if (observedSupervisorBuild.source.sha256 !== supervisorSource.sha256
        || observedSupervisorBuild.source.bytes !== supervisorSource.bytes.length
        || observedSupervisorBuild.source.mode !== 0o600
        || observedSupervisorBuild.binary.sha256 !== sha256(supervisorBinaryBytes)
        || observedSupervisorBuild.binary.bytes !== supervisorBinaryBytes.length
        || observedSupervisorBuild.testing !== false) {
        throw new Error("Pre-seal supervisor build differs from retained source or binary bytes");
      }
    } finally {
      await fs.rm(presealRoot, { recursive: true, force: false });
    }
  }
  const normalizedSupervisorBuild = {
    ...observedSupervisorBuild,
    source: { ...observedSupervisorBuild.source, path: "$SUPERVISOR_SOURCE" },
    sdk: { ...observedSupervisorBuild.sdk, path: "$SDKROOT" },
    binary: { ...observedSupervisorBuild.binary, path: "$SUPERVISOR_BINARY" },
  };

  const normalizedBootstrapPrefix = [
    "/bin/sh", "-c", DOCLING_BOOTSTRAP_V1, "pdf-tools-docling-bootstrap.v1",
    "$NODE", "$NODE_SHA256", "$NODE_BYTES", "$NODE_MODE", "$NODE_LINKS",
    "$LAUNCHER", "$LAUNCHER_SHA256", "$LAUNCHER_BYTES", "$LAUNCHER_MODE", "$LAUNCHER_LINKS",
    "$VERIFIER", "$VERIFIER_SHA256", "$VERIFIER_BYTES", "$VERIFIER_MODE", "$VERIFIER_LINKS",
    "$RUN_ROOT", "$AUTHORITY_HOME", "$AUTHORITY_TMP",
  ];

  const normalizedRecipe = {
    setup: {
      network_required: true,
      environment: {
        HOME: "$AUTHORITY_HOME", TMPDIR: "$AUTHORITY_TMP", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
        HF_HOME: "$HF_CACHE_ROOT", UV_CACHE_DIR: "$UV_CACHE_ROOT", UV_PYTHON_INSTALL_DIR: "$UV_PYTHON_INSTALL_ROOT", PYTHONDONTWRITEBYTECODE: "1",
      },
      authority_command: [...normalizedBootstrapPrefix, "--action", "setup", "--receipt", "$RECEIPT", "--expected-receipt-sha256", "$OUT_OF_BAND_RECEIPT_SHA256", "--protected-roots-json", "$OUT_OF_BAND_PROTECTED_ROOTS_JSON"],
      commands: [
        ["$UV", "python", "install", "--no-bin", "3.12.13"],
        ["$UV", "venv", "--python", "3.12.13", "$VENV_ROOT"],
        ["$UV", "pip", "compile", "$DIRECT_REQUIREMENTS", "--python", "$PYTHON", "--generate-hashes", "--output-file", "$LOCK"],
        ["$UV", "pip", "sync", "$LOCK", "--python", "$PYTHON", "--require-hashes"],
        ["$PYTHON", "-I", "-B", "$MODEL_SETUP_HELPER", "--config", "$CONFIG", "--expected-config-sha256", "$CONFIG_SHA256", "--models-path", "$MODELS_ROOT", "--hf-cache-path", "$HF_CACHE_ROOT"],
      ],
      finalization: { protocol: "pdf-tools.docling-finalization.v1", out_of_band_sha256_required: true },
    },
    execution: {
      offline_intent: true,
      network_isolation_enforced: false,
      environment: {
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1",
        HOME: "$AUTHORITY_HOME", TMPDIR: "$AUTHORITY_TMP", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
        HF_HOME: "$HF_CACHE_ROOT", UV_CACHE_DIR: "$UV_CACHE_ROOT", UV_PYTHON_INSTALL_DIR: "$UV_PYTHON_INSTALL_ROOT", PYTHONDONTWRITEBYTECODE: "1",
      },
      candidate_execution: "retained_bakeoff_capture_only",
      adapter_command: ["$PYTHON", "-I", "-B", "$ADAPTER", "--config", "$CONFIG", "--artifacts-path", "$MODELS_ROOT", "--receipt", "$RECEIPT", "--expected-receipt-sha256", "$OUT_OF_BAND_RECEIPT_SHA256"],
      supervisor: {
        policy: DOCLING_SUPERVISOR_POLICY_V1,
        build: normalizedSupervisorBuild,
      },
    },
  };

  let fixtureTotalBytes = 0;
  const fixtureInputs = [];
  const fixtureDigests = new Set();
  for (const [index, fixturePath] of fixturePaths.entries()) {
    if (path.extname(fixturePath).toLowerCase() !== ".pdf") throw new Error("Docling handoff accepts only PDF fixtures");
    const bytes = await readStableRegularFile(fixturePath, MAX_FIXTURE_TOTAL_BYTES);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Docling handoff fixture is not a PDF byte stream");
    fixtureTotalBytes += bytes.length;
    if (fixtureTotalBytes > MAX_FIXTURE_TOTAL_BYTES) throw new Error("Docling handoff fixture set exceeds the 8 MiB aggregate ceiling");
    const digest = sha256(bytes);
    if (fixtureDigests.has(digest)) throw new Error("Docling handoff fixture set contains duplicate bytes");
    fixtureDigests.add(digest);
    fixtureInputs.push({ ordinal: index + 1, bytes, sha256: digest, filename: `source-${String(index + 1).padStart(3, "0")}-${digest.slice(0, 12)}.pdf` });
  }
  const retainedIdentityInputs = sourceInputs.map(({ role, relativePath, sourcePath, sourceMode, sourceLinks, bytes, ...identity }) => ({ role, filename: role === "direct_requirements" ? "direct-requirements.in" : path.basename(relativePath), bytes: bytes.length, ...identity }));
  const retainedIdentityFixtures = fixtureInputs.map(({ bytes, ...identity }) => ({ ...identity, bytes: bytes.length }));
  const handoffIdentity = {
    protocol: "pdf-tools.docling-macos-handoff.v1",
    platform_contract: { platform: "darwin", architecture: "arm64", interpreter: "cpython-3.12.13-macos-aarch64-none" },
    inputs: retainedIdentityInputs,
    fixtures: retainedIdentityFixtures,
    recipe: normalizedRecipe,
  };
  const handoffId = computeDoclingHandoffId(handoffIdentity);

  const uvRoot = await secureDirectory(path.join(resolvedCache, "uv"));
  const uvPythonInstallRoot = await secureDirectory(path.join(uvRoot, `python-${sha256(Buffer.from("cpython-3.12.13-macos-aarch64-none")).slice(0, 16)}`));
  const modelsParent = await secureDirectory(path.join(resolvedCache, "models"));
  const modelsRoot = path.join(modelsParent, `handoff-${handoffId.slice(0, 16)}-heron-${config.layout_model.revision.slice(0, 12)}`);
  try {
    await fs.lstat(modelsRoot);
    throw new Error(`Fresh Docling model target already exists: ${modelsRoot}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const runsRoot = await secureDirectory(path.join(resolvedCache, "runs"));
  const snapshotRoot = path.join(resolvedSidecar, `docling-${handoffId.slice(0, 16)}`);
  const runRoot = path.join(runsRoot, `handoff-${handoffId.slice(0, 16)}`);
  for (const destination of [snapshotRoot, runRoot]) {
    try {
      await fs.lstat(destination);
      throw new Error(`Refusing to overwrite an existing Docling handoff: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await Promise.all([secureDirectory(snapshotRoot), secureDirectory(runRoot)]);
  const fixtureRoot = await secureDirectory(path.join(runRoot, "fixtures"));
  const authorityHome = await secureDirectory(path.join(runRoot, "home"));
  const authorityTmp = await secureDirectory(path.join(runRoot, "tmp"));
  const hfCacheRoot = await secureDirectory(path.join(runRoot, "hf-cache"));

  const retainedInputs = [];
  for (const input of sourceInputs) {
    const filename = input.role === "direct_requirements" ? "direct-requirements.in" : path.basename(input.relativePath);
    const destination = path.join(snapshotRoot, filename);
    await writeExclusive(destination, input.bytes);
    retainedInputs.push({ role: input.role, filename, bytes: input.bytes.length, sha256: input.sha256 });
  }
  const retainedFixtures = [];
  for (const fixture of fixtureInputs) {
    await writeExclusive(path.join(fixtureRoot, fixture.filename), fixture.bytes);
    retainedFixtures.push({ ordinal: fixture.ordinal, filename: fixture.filename, bytes: fixture.bytes.length, sha256: fixture.sha256 });
  }

  const venvRoot = path.join(snapshotRoot, "venv");
  const lockPath = path.join(snapshotRoot, "requirements.lock");
  const inputPath = path.join(snapshotRoot, "direct-requirements.in");
  const adapterPath = path.join(snapshotRoot, "adapter.py");
  const setupHelperPath = path.join(snapshotRoot, "fetch_pinned_layout.py");
  const configPath = path.join(snapshotRoot, "docling-candidate-config.v1.json");
  const launcherSource = sourceInputs.find(item => item.role === "handoff_verifier_cli");
  const verifierSource = sourceInputs.find(item => item.role === "handoff_verifier_source");
  const launcherPath = launcherSource.sourcePath;
  const verifierPath = verifierSource.sourcePath;
  const configSha256 = retainedInputs.find(item => item.role === "candidate_config").sha256;
  const receiptPath = path.join(runRoot, "docling-handoff.v1.json");
  const finalizationPath = path.join(runRoot, "docling-finalization.v1.json");
  const supervisorBinaryPath = path.join(runRoot, "docling-macos-supervisor");
  await writeExclusive(supervisorBinaryPath, supervisorBinaryBytes, 0o700);
  const retainedSupervisorSourcePath = path.join(
    snapshotRoot,
    retainedInputs.find(item => item.role === "supervisor_source").filename,
  );
  const receiptShaPlaceholder = "$OUT_OF_BAND_RECEIPT_SHA256";
  const protectedRootsPlaceholder = "$OUT_OF_BAND_PROTECTED_ROOTS_JSON";
  const bootstrapPrefix = [
    "/bin/sh", "-c", DOCLING_BOOTSTRAP_V1, "pdf-tools-docling-bootstrap.v1",
    node.path, node.sha256, String(node.bytes), node.mode.toString(8), String(node.links),
    launcherPath, launcherSource.sha256, String(launcherSource.bytes.length), launcherSource.sourceMode.toString(8), String(launcherSource.sourceLinks),
    verifierPath, verifierSource.sha256, String(verifierSource.bytes.length), verifierSource.sourceMode.toString(8), String(verifierSource.sourceLinks),
    runRoot, authorityHome, authorityTmp,
  ];
  const setupAuthorityCommand = [...bootstrapPrefix, "--action", "setup", "--receipt", receiptPath, "--expected-receipt-sha256", receiptShaPlaceholder, "--protected-roots-json", protectedRootsPlaceholder];
  const pythonPath = path.join(venvRoot, "bin", "python");
  const baseEnvironment = {
    HOME: authorityHome, TMPDIR: authorityTmp, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
    HF_HOME: hfCacheRoot, UV_CACHE_DIR: uvRoot, UV_PYTHON_INSTALL_DIR: uvPythonInstallRoot, PYTHONDONTWRITEBYTECODE: "1",
  };
  const receipt = {
    protocol: "pdf-tools.docling-macos-handoff.v1",
    handoff_id: handoffId,
    execution_state: "not_run",
    identity: handoffIdentity,
    platform: {
      interpreter: "cpython-3.12.13-macos-aarch64-none",
      operating_system: "macos",
      architecture: "arm64",
      os_build: host.os_build,
      kernel_release: host.kernel_release,
      node_version: host.node_version,
    },
    toolchain: {
      uv: { path: uv.path, version: uv.version, bytes: uv.bytes, sha256: uv.sha256, mode: uv.mode, links: uv.links },
      node: { path: node.path, version: node.version, bytes: node.bytes, sha256: node.sha256, mode: node.mode, links: node.links },
    },
    roots: {
      uv: uvRoot,
      uv_python_install: uvPythonInstallRoot,
      models: modelsRoot,
      runs: runsRoot,
      sidecar_snapshot: snapshotRoot,
      authority_home: authorityHome,
      authority_tmp: authorityTmp,
      hf_cache: hfCacheRoot,
      protected_roots_sha256: protectedRootDigest(protectedRoots),
    },
    inputs: retainedInputs,
    fixtures: retainedFixtures,
    setup: {
      network_required: true,
      environment: baseEnvironment,
      authority_command: setupAuthorityCommand,
      commands: [
        [uv.path, "python", "install", "--no-bin", "3.12.13"],
        [uv.path, "venv", "--python", "3.12.13", venvRoot],
        [uv.path, "pip", "compile", inputPath, "--python", pythonPath, "--generate-hashes", "--output-file", lockPath],
        [uv.path, "pip", "sync", lockPath, "--python", pythonPath, "--require-hashes"],
        [pythonPath, "-I", "-B", setupHelperPath, "--config", configPath, "--expected-config-sha256", configSha256, "--models-path", modelsRoot, "--hf-cache-path", hfCacheRoot],
      ],
      finalization: { protocol: "pdf-tools.docling-finalization.v1", path: finalizationPath, out_of_band_sha256_required: true },
    },
    execution: {
      offline_intent: true,
      network_isolation_enforced: false,
      environment: {
        ...baseEnvironment,
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1",
      },
      candidate_execution: "retained_bakeoff_capture_only",
      adapter_command: [pythonPath, "-I", "-B", adapterPath, "--config", configPath, "--artifacts-path", modelsRoot, "--receipt", receiptPath, "--expected-receipt-sha256", receiptShaPlaceholder],
      supervisor: {
        policy: DOCLING_SUPERVISOR_POLICY_V1,
        build: {
          ...observedSupervisorBuild,
          source: { ...observedSupervisorBuild.source, path: retainedSupervisorSourcePath },
          binary: { ...observedSupervisorBuild.binary, path: supervisorBinaryPath },
        },
      },
      fixture_presentation: "Runner stages each retained PDF as source.pdf and does not expose this receipt or Phase 0 truth to the candidate request.",
    },
    claim_boundary: "Unexecuted private evaluation handoff only. No benchmark, package, product, redistribution, or release claim is authorized.",
  };
  // The bootstrap marker must survive in the durable receipt bytes, not only
  // on the in-memory result, or a bootstrap handoff's receipt is
  // byte-indistinguishable from a qualifying one. Present only when true, so
  // ordinary receipts keep their exact current shape, and archived receipts
  // without the field remain valid non-bootstrap receipts.
  if (calibrationBootstrap === true) receipt.calibration_bootstrap = true;
  const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  const trustedSchema = JSON.parse(sourceInputs.find(item => item.role === "handoff_schema").bytes);
  const validation = new AjvJsonSchemaValidator().getValidator(trustedSchema)(receipt);
  if (!validation.valid) throw new Error(`Generated Docling handoff is invalid: ${validation.errorMessage}`);
  await writeExclusive(receiptPath, receiptBytes);
  return {
    receipt,
    receiptPath,
    receipt_sha256: sha256(receiptBytes),
    bootstrap_sha256: sha256(Buffer.from(DOCLING_BOOTSTRAP_V1)),
    protected_roots_json: canonicalJson([...protectedRoots].map(value => path.resolve(value)).sort()),
    // Present and true only when the attestation gate was bypassed to re-measure
    // the calibration. Consumers that produce qualifying or scored evidence must
    // refuse a handoff carrying this marker.
    calibration_bootstrap: calibrationBootstrap === true,
  };
}

/**
 * Whether the reviewed Docling supervisor calibration attestation still matches
 * the sources it attests to. Pure and cheap, so suites can gate themselves at
 * module load instead of failing deep inside a fixture build. A stale result is
 * a re-approval requirement, not a product defect.
 */
export function doclingCalibrationStatus(repoRoot = REPO_ROOT) {
  // The attestation and both supervisor sources are committed fixtures. If any
  // of them is missing or unparseable, that is repository or evidence-store
  // corruption, not staleness, so this throws and the gated suites fail red.
  // Only a successfully computed comparison may report drift as a skip.
  const attestationPath = path.join(
    repoRoot,
    "test/fixtures/eval/extraction/phase1/docling-supervisor-calibration-attestation.v1.json",
  );
  const attestationBytes = readFileSync(attestationPath);
  const attestation = JSON.parse(attestationBytes);
  // A maintainer-authorized retirement record supersedes the staleness
  // comparison entirely: the retired measurement is permanently
  // unreproducible, so the gated suites skip on the retirement itself. The
  // record must bind the exact attestation bytes it retires; a mismatch or a
  // dangling record is evidence-store corruption and stays red.
  let retirementBytes = null;
  try {
    retirementBytes = readFileSync(path.join(
      repoRoot,
      "test/fixtures/eval/extraction/phase1/docling-supervisor-calibration-retirement.v1.json",
    ));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (retirementBytes !== null) {
    const retirement = JSON.parse(retirementBytes);
    if (retirement.protocol !== "pdf-tools.docling-supervisor-calibration-retirement.v1"
      || retirement.retired !== true
      || typeof retirement.reason !== "string" || retirement.reason.length < 1) {
      throw new Error("Docling calibration retirement record is malformed");
    }
    if (retirement.retires_attestation?.sha256 !== sha256(attestationBytes)
      || retirement.retires_attestation?.bytes !== attestationBytes.length) {
      throw new Error(
        "Docling calibration retirement record does not bind the exact attestation it claims to retire",
      );
    }
    return {
      current: false,
      retired: true,
      reason: `Docling supervisor calibration was retired on ${retirement.retired_on}: `
        + "its measurement is permanently unreproducible and the suites gate on the "
        + "retirement. This is a recorded maintainer decision, not a product defect.",
    };
  }
  const bindings = [
    ["supervisor source", attestation.supervisor?.source, "test/eval/native/docling-macos-supervisor.c"],
    ["supervisor controller", attestation.supervisor?.controller, "test/eval/docling-macos-supervisor.js"],
  ];
  for (const [label, recorded] of bindings) {
    // A structurally hollow attestation is corruption, not drift. Mirror the
    // core handoff's structural checks so it cannot masquerade as staleness.
    if (!/^[a-f0-9]{64}$/.test(recorded?.sha256 ?? "")
      || !Number.isInteger(recorded?.bytes) || recorded.bytes < 1) {
      throw new Error(`Docling calibration attestation is malformed: ${label} binding is missing or invalid`);
    }
  }
  const drift = bindings.filter(([, recorded, relativePath]) => {
    const bytes = readFileSync(path.join(repoRoot, relativePath));
    return recorded.sha256 !== sha256(bytes) || recorded.bytes !== bytes.length;
  }).map(([label]) => label);
  return drift.length === 0
    ? { current: true, reason: null }
    : {
      current: false,
      reason: `Docling supervisor calibration attestation is stale for ${drift.join(" and ")}; `
        + "sealed evidence needs human re-approval, this is not a product defect.",
    };
}

export async function prepareDoclingMacHandoff(options = {}) {
  if ("testOnlyHost" in options || "testOnlyUv" in options || "testOnlyBootstrapRoot" in options
    || "testOnlySupervisorBuild" in options || "testCapability" in options) {
    throw new Error("Production handoff API does not accept injected host or toolchain facts");
  }
  return prepareDoclingMacHandoffCore(options);
}

export async function prepareDoclingMacHandoffForTest(options = {}) {
  return prepareDoclingMacHandoffCore({ ...options, testCapability: TEST_CAPABILITY });
}
