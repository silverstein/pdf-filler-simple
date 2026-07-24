import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const TEST_CAPABILITY = Symbol("docling-macos-supervisor-test-capability");
const MAX_METADATA_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_SUPERVISOR_STDERR_BYTES = 64 * 1024;
const MAX_CANDIDATE_INPUT_BYTES = 16 * 1024 * 1024;
const SUPERVISOR_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});
const CLAIM_BOUNDARY = "Sampled resource observations and inherited per-process limits only. No zero-overshoot, escaped-session containment, cgroup-equivalent isolation, filesystem isolation, network isolation, or hostile-code safety claim.";
const CLEANUP_CLAIM_BOUNDARY = "Crash recovery kills only a still-live leader whose PID, process group, and start-time identity match the parent-owned lease. A missing leader leaves containment unproven.";
const CONTROLLER_FAILURES = new Set([
  "none",
  "configuration",
  "child_setup",
  "exec",
  "deadline",
  "stdout_limit",
  "stderr_limit",
  "physical_footprint_limit",
  "enumeration",
  "pid_reuse",
  "escaped_session",
  "live_descendants",
  "leader_exit",
  "cleanup",
  "lease",
  "internal",
]);
const COMPILE_FLAGS = Object.freeze([
  "-std=c17",
  "-Os",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wconversion",
  "-Wsign-conversion",
  "-mmacosx-version-min=13.0",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

async function noLinkAncestors(filename) {
  let cursor = path.resolve(filename);
  for (;;) {
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`Supervisor path contains a symbolic link: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function privateDirectoryIdentity(filename) {
  const resolved = path.resolve(filename);
  if (resolved !== filename) throw new Error("Supervisor cwd must be a canonical absolute path");
  await noLinkAncestors(filename);
  const metadata = await fs.lstat(filename, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1n
    || Number(metadata.mode & 0o777n) !== 0o700
    || await fs.realpath(filename) !== filename) {
    throw new Error("Supervisor cwd must be a real mode-0700 directory");
  }
  return Object.freeze({
    path: filename,
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: Number(metadata.mode & 0o777n),
    links: Number(metadata.nlink),
  });
}

async function verifyPrivateDirectoryIdentity(expected) {
  const observed = await privateDirectoryIdentity(expected.path);
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error("Supervisor cwd identity changed during execution");
  }
  return observed;
}

async function stableRegularFile(filename, maximumBytes = MAX_METADATA_BYTES, allowedModes = null) {
  const resolved = path.resolve(filename);
  if (resolved !== filename) throw new Error("Supervisor file paths must be canonical absolute paths");
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error(`Supervisor input violates its regular-file contract: ${filename}`);
  }
  const mode = Number(before.mode & 0o777n);
  if (allowedModes !== null && !allowedModes.includes(mode)) {
    throw new Error(`Supervisor input mode is invalid: ${filename}`);
  }
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const descriptor = await handle.stat({ bigint: true });
    if (descriptor.dev !== before.dev || descriptor.ino !== before.ino || descriptor.size !== before.size
      || descriptor.mode !== before.mode || descriptor.nlink !== before.nlink) {
      throw new Error(`Supervisor input changed before read: ${filename}`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathnameAfter = await fs.lstat(filename, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mode !== before.mode || after.nlink !== before.nlink
      || pathnameAfter.dev !== before.dev || pathnameAfter.ino !== before.ino
      || pathnameAfter.size !== before.size || pathnameAfter.mode !== before.mode
      || pathnameAfter.nlink !== before.nlink
      || bytes.length !== Number(before.size)) {
      throw new Error(`Supervisor input changed during read: ${filename}`);
    }
  } finally {
    await handle.close();
  }
  if (await fs.realpath(filename) !== filename) throw new Error(`Supervisor input is not canonical: ${filename}`);
  return { bytes, mode, links: Number(before.nlink) };
}

async function fileIdentity(filename, maximumBytes = MAX_METADATA_BYTES, allowedModes = null) {
  const observed = await stableRegularFile(filename, maximumBytes, allowedModes);
  return {
    path: filename,
    bytes: observed.bytes.length,
    sha256: sha256(observed.bytes),
    mode: observed.mode,
    links: observed.links,
  };
}

function matchesBinaryIdentity(observed, expected) {
  return expected !== null && SHA256.test(expected?.sha256 ?? "")
    && integer(expected.bytes, 1, 4 * 1024 * 1024)
    && [0o700, 0o755].includes(expected.mode)
    && expected.links === 1
    && observed.sha256 === expected.sha256
    && observed.bytes === expected.bytes
    && observed.mode === expected.mode
    && observed.links === expected.links;
}

async function verifiedBinaryIdentity(filename, expected) {
  const observed = await fileIdentity(filename, 4 * 1024 * 1024, [0o700, 0o755]);
  if (!matchesBinaryIdentity(observed, expected)) {
    throw new Error("Supervisor binary differs from its required expected identity");
  }
  return observed;
}

function commandOutput(executable, args, environment = undefined) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal !== null || !result.stdout.trim()) {
    throw new Error(`Unable to inspect ${executable}`);
  }
  return result.stdout.trim();
}

function compileEnvironment(buildRoot) {
  return Object.freeze({
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: buildRoot,
  });
}

async function exclusiveCopy(source, destination, mode) {
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await fs.chmod(destination, mode);
  const handle = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function compileDoclingMacosSupervisor({
  sourcePath,
  outputPath,
  architecture = process.arch,
  testing = false,
} = {}) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)) {
    throw new Error("Native Docling supervisor compilation requires darwin arm64 or x64");
  }
  const source = await fileIdentity(path.resolve(sourcePath), 4 * 1024 * 1024, [0o600, 0o644]);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedOutput !== outputPath || path.extname(outputPath) !== "") {
    throw new Error("Supervisor output must be a canonical extensionless path");
  }
  try {
    await fs.lstat(outputPath);
    throw new Error("Refusing to overwrite an existing supervisor binary");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const outputParent = path.dirname(outputPath);
  await noLinkAncestors(outputParent);
  const parentMetadata = await fs.lstat(outputParent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("Supervisor output parent is invalid");
  }

  const xcrun = "/usr/bin/xcrun";
  const baseEnvironment = compileEnvironment(outputParent);
  const compilerPath = await fs.realpath(commandOutput(xcrun, ["--sdk", "macosx", "--find", "clang"], baseEnvironment));
  const sdkPath = await fs.realpath(commandOutput(xcrun, ["--sdk", "macosx", "--show-sdk-path"], baseEnvironment));
  const sdkVersion = commandOutput(xcrun, ["--sdk", "macosx", "--show-sdk-version"], baseEnvironment);
  const compilerVersion = commandOutput(compilerPath, ["--version"], baseEnvironment);
  const compiler = await fileIdentity(compilerPath, MAX_METADATA_BYTES, [0o755]);
  const buildRoot = await fs.mkdtemp(path.join(outputParent, ".docling-supervisor-build-"));
  await fs.chmod(buildRoot, 0o700);
  const artifact = path.join(buildRoot, "supervisor");
  const firstCopy = path.join(buildRoot, "supervisor-first-build");
  const archFlag = architecture === "x64" ? "x86_64" : architecture;
  const compile = destination => [
    ...COMPILE_FLAGS,
    "-arch", archFlag,
    "-isysroot", sdkPath,
    ...(testing ? ["-DPDF_TOOLS_SUPERVISOR_TESTING=1"] : []),
    "-o", destination,
    source.path,
  ];
  try {
    let firstIdentity;
    for (let buildNumber = 1; buildNumber <= 2; buildNumber += 1) {
      const result = spawnSync(compilerPath, compile(artifact), {
        cwd: buildRoot,
        env: compileEnvironment(buildRoot),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      });
      if (result.error || result.status !== 0 || result.signal !== null || result.stdout !== "") {
        throw new Error(`Supervisor compiler rejected the source: ${(result.stderr || result.error?.message || "unknown").slice(0, 1000)}`);
      }
      await fs.chmod(artifact, 0o700);
      if (buildNumber === 1) {
        await exclusiveCopy(artifact, firstCopy, 0o700);
        firstIdentity = await fileIdentity(firstCopy, 4 * 1024 * 1024, [0o700]);
      }
    }
    const secondIdentity = await fileIdentity(artifact, 4 * 1024 * 1024, [0o700]);
    if (firstIdentity.bytes !== secondIdentity.bytes || firstIdentity.sha256 !== secondIdentity.sha256) {
      throw new Error("Two same-path native supervisor builds are not byte-reproducible");
    }
    const [sourceAfter, compilerAfter] = await Promise.all([
      fileIdentity(source.path, 4 * 1024 * 1024, [0o600, 0o644]),
      fileIdentity(compiler.path, MAX_METADATA_BYTES, [0o755]),
    ]);
    if (canonicalJson(sourceAfter) !== canonicalJson(source)
      || canonicalJson(compilerAfter) !== canonicalJson(compiler)) {
      throw new Error("Supervisor source or compiler changed during the reproducibility build");
    }
    await exclusiveCopy(artifact, outputPath, 0o700);
    const binary = await fileIdentity(outputPath, 4 * 1024 * 1024, [0o700]);
    if (binary.bytes !== firstIdentity.bytes || binary.sha256 !== firstIdentity.sha256) {
      throw new Error("Published supervisor binary differs from its verified build");
    }
    const normalizedCommand = compile("$OUTPUT").map(value => {
      if (value === source.path) return "$SOURCE";
      if (value === sdkPath) return "$SDKROOT";
      return value;
    });
    const build = {
      protocol: "pdf-tools.macos-eval-supervisor-build.v1",
      platform: Object.freeze({
        operating_system: "macos",
        architecture,
        os_build: commandOutput("/usr/bin/sw_vers", ["-buildVersion"], baseEnvironment),
        kernel_release: os.release(),
      }),
      source: Object.freeze(source),
      compiler: Object.freeze({ ...compiler, version: compilerVersion }),
      sdk: Object.freeze({ path: sdkPath, version: sdkVersion }),
      command: Object.freeze([compilerPath, ...normalizedCommand]),
      testing,
      binary: Object.freeze(binary),
    };
    return verifyDoclingMacosSupervisorBuild(build, {
      sourcePath: source.path,
      binaryPath: outputPath,
      architecture,
      testing,
    });
  } finally {
    await fs.rm(buildRoot, { recursive: true, force: false });
  }
}

export async function verifyDoclingMacosSupervisorBuild(build, {
  sourcePath,
  binaryPath,
  architecture = process.arch,
  testing = false,
} = {}) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)
    || !exactKeys(build, [
      "binary", "command", "compiler", "platform", "protocol", "sdk", "source", "testing",
    ])
    || build.protocol !== "pdf-tools.macos-eval-supervisor-build.v1"
    || build.testing !== testing
    || !exactKeys(build.platform, [
      "architecture", "kernel_release", "operating_system", "os_build",
    ])
    || build.platform.operating_system !== "macos"
    || build.platform.architecture !== architecture
    || typeof build.platform.os_build !== "string" || !build.platform.os_build
    || typeof build.platform.kernel_release !== "string" || !build.platform.kernel_release
    || !exactKeys(build.source, ["bytes", "links", "mode", "path", "sha256"])
    || !exactKeys(build.compiler, ["bytes", "links", "mode", "path", "sha256", "version"])
    || !exactKeys(build.sdk, ["path", "version"])
    || !exactKeys(build.binary, ["bytes", "links", "mode", "path", "sha256"])
    || !Array.isArray(build.command) || build.command.length < 2
    || build.command.some(value => typeof value !== "string" || !value)) {
    throw new Error("Supervisor build receipt is invalid");
  }
  const resolvedSource = path.resolve(sourcePath);
  const resolvedBinary = path.resolve(binaryPath);
  if (build.source.path !== resolvedSource || build.binary.path !== resolvedBinary
    || ![0o600, 0o644].includes(build.source.mode) || build.source.links !== 1
    || build.binary.mode !== 0o700 || build.binary.links !== 1
    || build.compiler.mode !== 0o755 || build.compiler.links !== 1
    || !SHA256.test(build.source.sha256 ?? "")
    || !SHA256.test(build.compiler.sha256 ?? "")
    || !SHA256.test(build.binary.sha256 ?? "")) {
    throw new Error("Supervisor build receipt paths or identities are invalid");
  }
  const buildRoot = path.dirname(resolvedBinary);
  const environment = compileEnvironment(buildRoot);
  const compilerPath = await fs.realpath(
    commandOutput("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang"], environment),
  );
  const sdkPath = await fs.realpath(
    commandOutput("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], environment),
  );
  const compilerVersion = commandOutput(compilerPath, ["--version"], environment);
  const sdkVersion = commandOutput("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], environment);
  const expectedCommand = [
    compilerPath,
    ...COMPILE_FLAGS,
    "-arch", architecture === "x64" ? "x86_64" : architecture,
    "-isysroot", "$SDKROOT",
    ...(testing ? ["-DPDF_TOOLS_SUPERVISOR_TESTING=1"] : []),
    "-o", "$OUTPUT",
    "$SOURCE",
  ];
  if (build.compiler.path !== compilerPath
    || build.compiler.version !== compilerVersion
    || build.sdk.path !== sdkPath
    || build.sdk.version !== sdkVersion
    || canonicalJson(build.command) !== canonicalJson(expectedCommand)
    || build.platform.os_build !== commandOutput("/usr/bin/sw_vers", ["-buildVersion"], environment)
    || build.platform.kernel_release !== os.release()) {
    throw new Error("Supervisor build toolchain differs from its receipt");
  }
  const [source, compiler, binary] = await Promise.all([
    fileIdentity(resolvedSource, 4 * 1024 * 1024, [0o600, 0o644]),
    fileIdentity(compilerPath, MAX_METADATA_BYTES, [0o755]),
    fileIdentity(resolvedBinary, 4 * 1024 * 1024, [0o700]),
  ]);
  if (canonicalJson(source) !== canonicalJson(build.source)
    || canonicalJson({ ...compiler, version: compilerVersion }) !== canonicalJson(build.compiler)
    || canonicalJson(binary) !== canonicalJson(build.binary)) {
    throw new Error("Supervisor source, compiler, or binary differs from its build receipt");
  }
  return Object.freeze({
    ...build,
    platform: Object.freeze({ ...build.platform }),
    source: Object.freeze({ ...build.source }),
    compiler: Object.freeze({ ...build.compiler }),
    sdk: Object.freeze({ ...build.sdk }),
    command: Object.freeze([...build.command]),
    binary: Object.freeze({ ...build.binary }),
  });
}

function parseCanonicalRecord(bytes, label, maximumBytes = MAX_EVIDENCE_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > maximumBytes) {
    throw new Error(`${label} is missing or exceeds its byte ceiling`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

export function validateSupervisorLease(value) {
  if (!exactKeys(value, ["leader_pid", "leader_start_abstime", "process_group_id", "protocol"])
    || value.protocol !== "pdf-tools.macos-eval-supervisor-lease.v1"
    || !integer(value.leader_pid, 2, 2147483647)
    || value.process_group_id !== value.leader_pid
    || !integer(value.leader_start_abstime, 1)) {
    throw new Error("Supervisor lease is invalid");
  }
  return value;
}

function validateLeader(value, lease) {
  if (!exactKeys(value, ["exit_code", "pid", "process_group_id", "signal", "start_abstime"])
    || !integer(value.pid, 2, 2147483647)
    || !(value.process_group_id === -1 || integer(value.process_group_id, 2, 2147483647))
    || !integer(value.start_abstime)
    || !(value.exit_code === null || integer(value.exit_code, 0, 255))
    || !(value.signal === null || integer(value.signal, 1, 64))
    || (value.exit_code !== null && value.signal !== null)) {
    throw new Error("Supervisor leader evidence is invalid");
  }
  if (lease === null) {
    if (![value.pid, -1].includes(value.process_group_id)
      || (value.process_group_id === -1 && value.start_abstime !== 0)
      || (value.exit_code === null) === (value.signal === null)) {
      throw new Error("Pre-exec supervisor leader evidence is invalid");
    }
  } else if (value.pid !== lease.leader_pid || value.process_group_id !== lease.process_group_id
    || value.start_abstime !== lease.leader_start_abstime) {
    throw new Error("Supervisor leader evidence differs from its parent lease");
  }
}

function validateLimits(value, expected) {
  if (!exactKeys(value, [
    "address_space_bytes", "core_bytes", "cpu_seconds", "deadline_ms",
    "file_size_bytes", "leader_exit_grace_ms", "nofile", "sample_interval_ms",
    "sampled_group_physical_footprint_max_bytes", "stderr_max_bytes",
    "stdout_max_bytes",
  ]) || value.core_bytes !== 0
    || value.address_space_bytes !== expected.addressSpaceBytes
    || value.cpu_seconds !== expected.cpuSeconds
    || value.deadline_ms !== expected.deadlineMs
    || value.file_size_bytes !== expected.fileSizeBytes
    || value.leader_exit_grace_ms !== expected.leaderExitGraceMs
    || value.nofile !== expected.nofile
    || value.sample_interval_ms !== expected.sampleIntervalMs
    || value.sampled_group_physical_footprint_max_bytes !== expected.physicalFootprintMaxBytes
    || value.stderr_max_bytes !== expected.stderrMaxBytes
    || value.stdout_max_bytes !== expected.stdoutMaxBytes) {
    throw new Error("Supervisor limit evidence is invalid");
  }
}

export function validateSupervisorEvidence(value, lease, expected) {
  if (!exactKeys(value, [
    "capture", "child_setup_stage", "claim_boundary", "controller_accepted",
    "controller_errno", "controller_failure", "leader", "limits",
    "observations", "protocol",
  ]) || value.protocol !== "pdf-tools.macos-eval-supervisor.v1"
    || value.claim_boundary !== CLAIM_BOUNDARY
    || typeof value.controller_accepted !== "boolean"
    || !integer(value.controller_errno, 0, 2147483647)
    || !integer(value.child_setup_stage, 0, 10)
    || !CONTROLLER_FAILURES.has(value.controller_failure)) {
    throw new Error("Supervisor evidence envelope is invalid");
  }
  validateLeader(value.leader, lease);
  validateLimits(value.limits, expected);
  const capture = value.capture;
  if (!exactKeys(capture, [
    "stderr_limit_exceeded", "stderr_observed_bytes", "stderr_retained_bytes",
    "stdout_limit_exceeded", "stdout_observed_bytes", "stdout_retained_bytes",
  ]) || typeof capture.stderr_limit_exceeded !== "boolean"
    || typeof capture.stdout_limit_exceeded !== "boolean"
    || !integer(capture.stderr_observed_bytes) || !integer(capture.stderr_retained_bytes)
    || !integer(capture.stdout_observed_bytes) || !integer(capture.stdout_retained_bytes)
    || capture.stderr_retained_bytes !== Math.min(capture.stderr_observed_bytes, expected.stderrMaxBytes)
    || capture.stdout_retained_bytes !== Math.min(capture.stdout_observed_bytes, expected.stdoutMaxBytes)
    || capture.stderr_limit_exceeded !== (capture.stderr_observed_bytes > expected.stderrMaxBytes)
    || capture.stdout_limit_exceeded !== (capture.stdout_observed_bytes > expected.stdoutMaxBytes)) {
    throw new Error("Supervisor capture evidence is invalid");
  }
  const observations = value.observations;
  if (!exactKeys(observations, [
    "elapsed_continuous_ns", "escaped_session_detected", "max_group_members",
    "max_sampled_group_cpu_ns", "max_sampled_group_physical_footprint_bytes",
    "max_sampled_group_rss_bytes", "max_sampled_group_virtual_bytes",
    "observed_process_identity_count", "original_process_group_empty",
    "sample_count", "sample_race_count",
  ]) || !integer(observations.elapsed_continuous_ns)
    || typeof observations.escaped_session_detected !== "boolean"
    || typeof observations.original_process_group_empty !== "boolean"
    || !integer(observations.max_group_members, 0, 4096)
    || !integer(observations.observed_process_identity_count, 0, 8192)
    || ![
      "max_sampled_group_cpu_ns",
      "max_sampled_group_physical_footprint_bytes", "max_sampled_group_rss_bytes",
      "max_sampled_group_virtual_bytes", "sample_count", "sample_race_count",
    ].every(key => integer(observations[key]))) {
    throw new Error("Supervisor observation evidence is invalid");
  }
  if (value.controller_accepted !== (
    value.controller_failure === "none"
    && value.controller_errno === 0
    && value.child_setup_stage === 0
    && value.leader.exit_code === 0
    && value.leader.signal === null
    && !capture.stdout_limit_exceeded
    && !capture.stderr_limit_exceeded
    && !observations.escaped_session_detected
    && observations.original_process_group_empty
  )) {
    throw new Error("Supervisor acceptance evidence is self-inconsistent");
  }
  if (lease === null && (
    value.controller_accepted
    || !new Set(["child_setup", "enumeration", "lease"]).has(value.controller_failure)
    || !observations.original_process_group_empty
  )) {
    throw new Error("Lease-free evidence is not a bounded pre-exec setup failure");
  }
  return value;
}

export function validateSupervisorCleanupEvidence(value, lease) {
  if (!exactKeys(value, [
    "claim_boundary", "identity_matched", "leader_pid",
    "leader_start_abstime", "original_process_group_empty",
    "process_group_id", "protocol",
  ]) || value.protocol !== "pdf-tools.macos-eval-supervisor-cleanup.v1"
    || value.claim_boundary !== CLEANUP_CLAIM_BOUNDARY
    || value.leader_pid !== lease.leader_pid
    || value.leader_start_abstime !== lease.leader_start_abstime
    || value.process_group_id !== lease.process_group_id
    || typeof value.identity_matched !== "boolean"
    || typeof value.original_process_group_empty !== "boolean") {
    throw new Error("Supervisor cleanup evidence is invalid");
  }
  return value;
}

function collectStream(stream, maximumBytes, label, terminate) {
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  stream.on("data", chunk => {
    bytes += chunk.length;
    if (bytes <= maximumBytes) chunks.push(chunk);
    else if (!exceeded) {
      exceeded = true;
      terminate(new Error(`${label} exceeded its parent capture ceiling`));
    }
  });
  return () => ({ bytes, exceeded, buffer: Buffer.concat(chunks) });
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function validateRunOptions(options) {
  const expected = [
    ["deadlineMs", 1, 600000],
    ["leaderExitGraceMs", 0, 5000],
    ["sampleIntervalMs", 1, 1000],
    ["stdoutMaxBytes", 1, 16777216],
    ["stderrMaxBytes", 1, 16777216],
    ["physicalFootprintMaxBytes", 16777216, 549755813888],
    ["addressSpaceBytes", 1073741824, 1099511627776],
    ["cpuSeconds", 1, 3600],
    ["fileSizeBytes", 1048576, 1073741824],
    ["nofile", 32, 4096],
  ];
  for (const [key, minimum, maximum] of expected) {
    if (!integer(options[key], minimum, maximum)) throw new Error(`Invalid supervisor option: ${key}`);
  }
  if (typeof options.cwd !== "string" || path.resolve(options.cwd) !== options.cwd) {
    throw new Error("Supervisor cwd must be a canonical absolute path");
  }
  if (!Array.isArray(options.command) || options.command.length < 1
    || options.command.length > 512
    || options.command.some(value => typeof value !== "string" || !value || value.includes("\0"))
    || options.command.some(value => Buffer.byteLength(value) > 4096)
    || options.command.reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0) > 65536
    || !Buffer.isBuffer(options.stdin) || options.stdin.length > MAX_CANDIDATE_INPUT_BYTES
    || !options.environment || typeof options.environment !== "object" || Array.isArray(options.environment)
    || Object.keys(options.environment).length > 128
    || Object.entries(options.environment).some(([key, value]) => !key || key.includes("=") || key.includes("\0")
      || key === "PDF_TOOLS_SUPERVISOR_FAULT" || key.startsWith("DYLD_") || key.startsWith("LD_")
      || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(`${key}=${value}`) > 4096)
    || Object.entries(options.environment)
      .reduce((sum, [key, value]) => sum + Buffer.byteLength(`${key}=${value}`) + 1, 0) > 65536) {
    throw new Error("Invalid supervisor command, input, or environment");
  }
}

function runArguments(options) {
  return [
    "run",
    "--deadline-ms", String(options.deadlineMs),
    "--leader-exit-grace-ms", String(options.leaderExitGraceMs),
    "--sample-ms", String(options.sampleIntervalMs),
    "--stdout-max-bytes", String(options.stdoutMaxBytes),
    "--stderr-max-bytes", String(options.stderrMaxBytes),
    "--physical-footprint-max-bytes", String(options.physicalFootprintMaxBytes),
    "--rlimit-as-bytes", String(options.addressSpaceBytes),
    "--rlimit-cpu-seconds", String(options.cpuSeconds),
    "--rlimit-fsize-bytes", String(options.fileSizeBytes),
    "--rlimit-nofile", String(options.nofile),
    "--evidence-fd", "3",
    "--lease-fd", "4",
    ...Object.entries(options.environment)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--",
    ...options.command,
  ];
}

async function cleanupFromLease({
  binaryPath,
  expectedBinary,
  lease,
  testingFault = null,
}) {
  await verifiedBinaryIdentity(binaryPath, expectedBinary);
  const child = spawn(binaryPath, [
    "cleanup",
    "--pgid", String(lease.process_group_id),
    "--leader-pid", String(lease.leader_pid),
    "--leader-start-abstime", String(lease.leader_start_abstime),
    "--evidence-fd", "3",
  ], {
    env: testingFault === null
      ? SUPERVISOR_ENVIRONMENT
      : { ...SUPERVISOR_ENVIRONMENT, PDF_TOOLS_SUPERVISOR_FAULT: testingFault },
    shell: false,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let failure = null;
  const terminate = error => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  const stderr = collectStream(child.stderr, MAX_SUPERVISOR_STDERR_BYTES, "Cleanup stderr", terminate);
  const evidence = collectStream(child.stdio[3], MAX_EVIDENCE_BYTES, "Cleanup evidence", terminate);
  const exit = await waitForClose(child);
  const stderrResult = stderr();
  const evidenceResult = evidence();
  if (failure || stderrResult.exceeded || evidenceResult.exceeded) throw failure ?? new Error("Cleanup capture failed");
  const parsed = validateSupervisorCleanupEvidence(
    parseCanonicalRecord(evidenceResult.buffer, "Supervisor cleanup evidence"),
    lease,
  );
  if (exit.code !== 0 || exit.signal !== null || !parsed.identity_matched || !parsed.original_process_group_empty) {
    throw new Error("Supervisor crash cleanup did not prove the original group empty");
  }
  return Object.freeze(parsed);
}

async function runSupervisedCandidateCore({
  binaryPath,
  expectedBinary = null,
  cwd,
  command,
  stdin,
  environment,
  deadlineMs,
  leaderExitGraceMs,
  sampleIntervalMs,
  stdoutMaxBytes,
  stderrMaxBytes,
  physicalFootprintMaxBytes,
  addressSpaceBytes,
  cpuSeconds,
  fileSizeBytes,
  nofile,
  testingFault = null,
}) {
  const options = {
    cwd: typeof cwd === "string" ? cwd : "",
    command: Array.isArray(command) ? [...command] : command,
    stdin: Buffer.isBuffer(stdin) ? Buffer.from(stdin) : stdin,
    environment: environment && typeof environment === "object" && !Array.isArray(environment)
      ? { ...environment }
      : environment,
    deadlineMs, leaderExitGraceMs, sampleIntervalMs, stdoutMaxBytes,
    stderrMaxBytes, physicalFootprintMaxBytes, addressSpaceBytes, cpuSeconds,
    fileSizeBytes, nofile,
  };
  const requiredBinary = expectedBinary && typeof expectedBinary === "object"
    ? { ...expectedBinary }
    : expectedBinary;
  validateRunOptions(options);
  const cwdIdentity = await privateDirectoryIdentity(options.cwd);
  const resolvedBinary = path.resolve(binaryPath);
  const observedBinary = await verifiedBinaryIdentity(resolvedBinary, requiredBinary);
  const childEnvironment = testingFault === null
    ? SUPERVISOR_ENVIRONMENT
    : { ...SUPERVISOR_ENVIRONMENT, PDF_TOOLS_SUPERVISOR_FAULT: testingFault };
  const child = spawn(resolvedBinary, runArguments(options), {
    cwd: cwdIdentity.path,
    env: childEnvironment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  let outerFailure = null;
  let escalationTimer = null;
  const terminate = error => {
    outerFailure ??= error;
    child.kill("SIGTERM");
    escalationTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    escalationTimer.unref?.();
  };
  const stdout = collectStream(child.stdout, stdoutMaxBytes, "Supervisor stdout", terminate);
  const stderr = collectStream(child.stderr, MAX_SUPERVISOR_STDERR_BYTES, "Supervisor stderr", terminate);
  const evidence = collectStream(child.stdio[3], MAX_EVIDENCE_BYTES, "Supervisor evidence", terminate);
  const lease = collectStream(child.stdio[4], MAX_EVIDENCE_BYTES, "Supervisor lease", terminate);
  const timer = setTimeout(
    () => terminate(new Error("Outer supervisor fail-safe elapsed")),
    deadlineMs + 5000,
  );
  timer.unref?.();
  child.stdin.on("error", error => {
    if (error.code !== "EPIPE") terminate(new Error(`Supervisor stdin failed: ${error.message}`));
  });
  child.stdin.end(options.stdin);
  const exit = await waitForClose(child);
  clearTimeout(timer);
  if (escalationTimer !== null) clearTimeout(escalationTimer);
  const stdoutResult = stdout();
  const stderrResult = stderr();
  const evidenceResult = evidence();
  const leaseResult = lease();
  if ([stdoutResult, stderrResult, evidenceResult, leaseResult].some(result => result.exceeded)) {
    throw outerFailure ?? new Error("Supervisor parent capture ceiling failed");
  }
  const parsedLease = leaseResult.buffer.length === 0
    ? null
    : validateSupervisorLease(parseCanonicalRecord(leaseResult.buffer, "Supervisor lease"));
  let binaryMutation = null;
  try {
    await verifiedBinaryIdentity(resolvedBinary, requiredBinary);
  } catch (cause) {
    binaryMutation = cause;
  }
  let cwdMutation = null;
  try {
    await verifyPrivateDirectoryIdentity(cwdIdentity);
  } catch (cause) {
    cwdMutation = cause;
  }
  if (evidenceResult.buffer.length === 0) {
    if (parsedLease === null) {
      throw Object.assign(new Error("Supervisor exited before its pre-exec lease and final evidence"), {
        code: "SUPERVISOR_PRELEASE_FAILURE",
        exit,
      });
    }
    if (binaryMutation !== null) {
      throw Object.assign(new Error("Supervisor binary changed before required crash cleanup; containment is unproven", {
        cause: binaryMutation,
      }), {
        code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
        exit,
        lease: parsedLease,
      });
    }
    let cleanup;
    try {
      cleanup = await cleanupFromLease({
        binaryPath: resolvedBinary,
        expectedBinary: requiredBinary,
        lease: parsedLease,
        testingFault,
      });
    } catch (cause) {
      throw Object.assign(new Error("Supervisor crash cleanup could not prove containment", { cause }), {
        code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
        exit,
        lease: parsedLease,
      });
    }
    throw Object.assign(new Error("Supervisor exited without final evidence; identity-bound cleanup passed"), {
      code: "SUPERVISOR_EVIDENCE_MISSING",
      cleanup,
      exit,
    });
  }
  const parsedEvidence = validateSupervisorEvidence(
    parseCanonicalRecord(evidenceResult.buffer, "Supervisor evidence"),
    parsedLease,
    options,
  );
  if (!parsedEvidence.observations.original_process_group_empty) {
    if (binaryMutation !== null) {
      throw Object.assign(new Error("Supervisor binary changed before required containment cleanup", {
        cause: binaryMutation,
      }), {
        code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
        evidence: parsedEvidence,
        exit,
      });
    }
    let cleanup = null;
    if (parsedLease !== null) {
      try {
        cleanup = await cleanupFromLease({
          binaryPath: resolvedBinary,
          expectedBinary: requiredBinary,
          lease: parsedLease,
          testingFault,
        });
      } catch (cause) {
        throw Object.assign(new Error("Supervisor containment remained unproven after crash cleanup", { cause }), {
          code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
          evidence: parsedEvidence,
          exit,
        });
      }
    }
    throw Object.assign(new Error("Supervisor evidence did not prove containment; cleanup passed"), {
      code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
      cleanup,
      evidence: parsedEvidence,
      exit,
    });
  }
  if (binaryMutation !== null) {
    throw Object.assign(new Error("Supervisor binary changed during execution; otherwise complete evidence was rejected", {
      cause: binaryMutation,
    }), {
      code: "SUPERVISOR_BINARY_MUTATED",
      evidence: parsedEvidence,
      exit,
    });
  }
  if (cwdMutation !== null) {
    throw Object.assign(new Error("Supervisor cwd changed during execution; otherwise complete evidence was rejected", {
      cause: cwdMutation,
    }), {
      code: "SUPERVISOR_CWD_MUTATED",
      evidence: parsedEvidence,
      exit,
    });
  }
  if (outerFailure !== null) throw outerFailure;
  if (parsedEvidence.controller_accepted
    && parsedEvidence.capture.stdout_retained_bytes !== stdoutResult.buffer.length) {
    throw new Error("Supervisor stdout differs from its parent evidence");
  }
  if (parsedEvidence.controller_accepted) {
    if (parsedLease === null || exit.code !== 0 || exit.signal !== null) {
      throw new Error("Accepted supervisor evidence has a failing process exit or no lease");
    }
  } else if (exit.code !== 1 || exit.signal !== null || stdoutResult.buffer.length !== 0) {
    throw new Error("Rejected supervisor evidence has an invalid process result");
  }
  return Object.freeze({
    binary: Object.freeze(observedBinary),
    cwd: cwdIdentity,
    lease: parsedLease === null ? null : Object.freeze(parsedLease),
    evidence: Object.freeze(parsedEvidence),
    stdout: stdoutResult.buffer,
    supervisor_stderr: stderrResult.buffer,
    exit: Object.freeze(exit),
  });
}

export async function runSupervisedCandidate(options) {
  return runSupervisedCandidateCore({ ...options, testingFault: null });
}

export async function runSupervisedCandidateForTest(options, testingFault = null) {
  if (options?.testCapability !== TEST_CAPABILITY) throw new Error("Supervisor test fault requires the private test capability");
  const { testCapability, ...rest } = options;
  return runSupervisedCandidateCore({ ...rest, testingFault });
}

export function supervisorTestCapability() {
  return TEST_CAPABILITY;
}

export function parseCanonicalCandidateJson(bytes, stdoutMaximumBytes) {
  if (!integer(stdoutMaximumBytes, 1, 16777216)) {
    throw new Error("Candidate response requires its explicit stdout byte ceiling");
  }
  return parseCanonicalRecord(bytes, "Candidate response", stdoutMaximumBytes);
}
