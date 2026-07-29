import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const QPDF_BUDGET_FRAME_BYTES = 176;
export const QPDF_BUDGET_MAGIC = Buffer.from("QPBE", "ascii");
export const QPDF_BUDGET_PROTOCOL_VERSION = 3;
export const QPDF_BUDGET_READY = 1;
export const QPDF_BUDGET_ERROR = 2;
export const QPDF_BUDGET_STAGE_GROUP = 2;
export const QPDF_BUDGET_STAGE_INPUT_FD = 4;
export const QPDF_BUDGET_STAGE_READY = 10;
export const QPDF_BUDGET_STAGE_EXEC = 11;
export const QPDF_BUDGET_BUILD_PROTOCOL =
  "pdf-tools.macos-qpdf-budget-exec-build.v2";
export const QPDF_BUDGET_COMMAND_PROTOCOL =
  "pdf-tools.budgeted-qpdf-command.v3";
export const QPDF_BUDGET_COMMAND_CLAIM_BOUNDARY =
  "Cooperative same-user macOS command evidence only: exact input bytes and "
  + "kernel identity are checked across discrete reads around one fd-4 "
  + "invocation; READY followed by control EOF is only the reviewed launcher's "
  + "close-on-exec boundary signal, and the full successful lifecycle is "
  + "required to infer that the boundary was crossed. Separate authenticated "
  + "process sampling is required to bind the exec target. This evidence does "
  + "not exclude transient input or executable ABA by same-user or root "
  + "actors, concurrent shared-offset mutation after READY, kernel sandbox "
  + "escape, unsampled lifetime behavior, hostile-PDF universality, product "
  + "qualification, or release readiness.";

export const QPDF_ORACLE_POLICY = Object.freeze({
  address_space_headroom_bytes: 1536 * 1024 * 1024,
  file_size_bytes: 256 * 1024 * 1024,
  cpu_soft_seconds: 8,
  cpu_hard_seconds: 9,
  nofile: 64,
  core_bytes: 0,
  wall_timeout_ms: 10_000,
  calibration_required: true,
});

const BUILD_FLAGS = Object.freeze([
  "-std=c17",
  "-Os",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wconversion",
  "-Wsign-conversion",
  "-mmacosx-version-min=13.0",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BYTES = 250 * 1024 * 1024;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]*)$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort())
      === canonicalJson([...expected].sort());
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

async function noLinkAncestors(filename) {
  let cursor = path.resolve(filename);
  for (;;) {
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`QPDF budget path contains a symbolic link: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export async function qpdfBudgetFileIdentity(
  filename,
  maximumBytes = MAX_BINARY_BYTES,
  allowedModes = null,
) {
  if (path.resolve(filename) !== filename) {
    throw new Error("QPDF budget evidence path must be canonical and absolute.");
  }
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  const mode = Number(before.mode & 0o777n);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximumBytes)
      || (allowedModes && !allowedModes.includes(mode))) {
    throw new Error("QPDF budget evidence violates its regular-file contract.");
  }
  const handle = await fs.open(
    filename,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const digest = createHash("sha256");
  let observed = 0;
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (descriptorBefore.dev !== before.dev || descriptorBefore.ino !== before.ino
        || descriptorBefore.size !== before.size
        || descriptorBefore.mode !== before.mode
        || descriptorBefore.nlink !== before.nlink) {
      throw new Error("QPDF budget evidence changed before hashing.");
    }
    const buffer = Buffer.allocUnsafe(Math.min(maximumBytes, 1024 * 1024));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      observed += bytesRead;
      if (observed > maximumBytes) {
        throw new Error("QPDF budget evidence exceeded its byte ceiling.");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathnameAfter = await fs.lstat(filename, { bigint: true });
    if (descriptorAfter.dev !== before.dev
        || descriptorAfter.ino !== before.ino
        || descriptorAfter.size !== before.size
        || descriptorAfter.mode !== before.mode
        || descriptorAfter.nlink !== before.nlink
        || pathnameAfter.dev !== before.dev
        || pathnameAfter.ino !== before.ino
        || pathnameAfter.size !== before.size
        || pathnameAfter.mode !== before.mode
        || pathnameAfter.nlink !== before.nlink
        || observed !== Number(before.size)) {
      throw new Error("QPDF budget evidence changed while hashing.");
    }
  } finally {
    await handle.close();
  }
  if (await fs.realpath(filename) !== filename) {
    throw new Error("QPDF budget evidence path is not canonical.");
  }
  return Object.freeze({
    path: filename,
    bytes: observed,
    sha256: digest.digest("hex"),
    mode,
    links: Number(before.nlink),
  });
}

function validInputIdentity(value, maximumBytes = MAX_INPUT_BYTES) {
  return exactKeys(value, [
    "bytes",
    "device",
    "group",
    "inode",
    "links",
    "mode",
    "owner",
    "path",
    "sha256",
  ])
    && typeof value.path === "string"
    && path.resolve(value.path) === value.path
    && integer(value.bytes, 1, maximumBytes)
    && DECIMAL_IDENTITY.test(value.device)
    && BigInt(value.device) > 0n
    && DECIMAL_IDENTITY.test(value.inode)
    && BigInt(value.inode) > 0n
    && value.links === 1
    && integer(value.mode, 0, 0o777)
    && integer(value.owner, 0, 0xffffffff)
    && integer(value.group, 0, 0xffffffff)
    && SHA256.test(value.sha256);
}

function inputKernelProjection(value) {
  return {
    device: value.device,
    inode: value.inode,
    bytes: value.bytes,
    mode: value.mode,
    links: value.links,
    owner: value.owner,
    group: value.group,
  };
}

function validInputKernelProjection(value) {
  return exactKeys(value, [
    "bytes", "device", "group", "inode", "links", "mode", "owner",
  ])
    && integer(value.bytes, 1, MAX_INPUT_BYTES)
    && DECIMAL_IDENTITY.test(value.device)
    && BigInt(value.device) > 0n
    && DECIMAL_IDENTITY.test(value.inode)
    && BigInt(value.inode) > 0n
    && value.links === 1
    && integer(value.mode, 0, 0o777)
    && integer(value.owner, 0, 0xffffffff)
    && integer(value.group, 0, 0xffffffff);
}

async function retainedQpdfInputIdentity(
  handle,
  filename,
  maximumBytes = MAX_INPUT_BYTES,
) {
  if (!handle || !integer(handle.fd, 0, 2147483647)
      || path.resolve(filename) !== filename
      || !integer(maximumBytes, 1, MAX_INPUT_BYTES)) {
    throw new TypeError("Invalid retained qpdf input authority.");
  }
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  const mode = Number(before.mode & 0o777n);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximumBytes)
      || before.uid < 0n || before.uid > 0xffffffffn
      || before.gid < 0n || before.gid > 0xffffffffn) {
    throw new Error("Retained qpdf input violates its regular-file contract.");
  }
  const descriptorBefore = await handle.stat({ bigint: true });
  if (descriptorBefore.dev !== before.dev
      || descriptorBefore.ino !== before.ino
      || descriptorBefore.size !== before.size
      || descriptorBefore.mode !== before.mode
      || descriptorBefore.nlink !== before.nlink
      || descriptorBefore.uid !== before.uid
      || descriptorBefore.gid !== before.gid) {
    throw new Error("Retained qpdf input changed before hashing.");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(maximumBytes, 1024 * 1024));
  let observed = 0;
  for (;;) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      observed,
    );
    if (bytesRead === 0) break;
    observed += bytesRead;
    if (observed > maximumBytes) {
      throw new Error("Retained qpdf input exceeded its byte ceiling.");
    }
    digest.update(buffer.subarray(0, bytesRead));
  }
  const descriptorAfter = await handle.stat({ bigint: true });
  const pathnameAfter = await fs.lstat(filename, { bigint: true });
  for (const current of [descriptorAfter, pathnameAfter]) {
    if (current.dev !== before.dev || current.ino !== before.ino
        || current.size !== before.size || current.mode !== before.mode
        || current.nlink !== before.nlink || current.uid !== before.uid
        || current.gid !== before.gid) {
      throw new Error("Retained qpdf input changed while hashing.");
    }
  }
  if (observed !== Number(before.size)
      || await fs.realpath(filename) !== filename) {
    throw new Error("Retained qpdf input path or byte count changed.");
  }
  return Object.freeze({
    path: filename,
    bytes: observed,
    sha256: digest.digest("hex"),
    mode,
    links: Number(before.nlink),
    device: before.dev.toString(),
    inode: before.ino.toString(),
    owner: Number(before.uid),
    group: Number(before.gid),
  });
}

export async function openQpdfBudgetInput(
  filename,
  maximumBytes = MAX_INPUT_BYTES,
  allowedModes = null,
) {
  if (path.resolve(filename) !== filename
      || !integer(maximumBytes, 1, MAX_INPUT_BYTES)
      || !(allowedModes === null
        || (Array.isArray(allowedModes)
          && allowedModes.every(mode => integer(mode, 0, 0o777))))) {
    throw new TypeError("Invalid qpdf input-open authority.");
  }
  await noLinkAncestors(filename);
  const handle = await fs.open(
    filename,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const identity = await retainedQpdfInputIdentity(
      handle,
      filename,
      maximumBytes,
    );
    if (allowedModes && !allowedModes.includes(identity.mode)) {
      throw new Error("Retained qpdf input mode is not allowed.");
    }
    return Object.freeze({ handle, identity });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function validIdentity(value, maximumBytes = MAX_BINARY_BYTES) {
  return exactKeys(value, ["bytes", "links", "mode", "path", "sha256"])
    && typeof value.path === "string"
    && path.resolve(value.path) === value.path
    && integer(value.bytes, 1, maximumBytes)
    && value.links === 1
    && integer(value.mode, 0, 0o777)
    && SHA256.test(value.sha256);
}

function validCompilerIdentity(value) {
  return exactKeys(value, [
    "bytes", "links", "mode", "path", "sha256", "version",
  ])
    && validIdentity({
      bytes: value.bytes,
      links: value.links,
      mode: value.mode,
      path: value.path,
      sha256: value.sha256,
    }, 256 * 1024 * 1024)
    && typeof value.version === "string"
    && value.version.length > 0
    && value.version.length <= 4096;
}

function commandOutput(executable, args, environment, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal !== null
      || result.stderr !== "") {
    throw new Error("Unable to inspect the macOS qpdf budget build authority.");
  }
  return result.stdout.trim();
}

function compileEnvironment(directory) {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: directory,
  };
}

export class QpdfBudgetFrameParser {
  constructor({
    expectedPolicy = QPDF_ORACLE_POLICY,
    expectedPgid = null,
    expectedInput = null,
  } = {}) {
    if (!validQpdfPolicy(expectedPolicy)
        || !(expectedPgid === null
          || integer(expectedPgid, 2, 2147483647))
        || !(expectedInput === null
          || validInputKernelProjection(expectedInput))) {
      throw new TypeError("Invalid qpdf budget frame-parser authority.");
    }
    this.expectedPolicy = expectedPolicy;
    this.expectedPgid = expectedPgid;
    this.expectedInput = expectedInput;
    this.pending = Buffer.alloc(0);
    this.frames = [];
  }

  add(chunk) {
    const bytes = Buffer.from(chunk);
    if (bytes.length === 0) return;
    if (this.frames.length >= 2
        || bytes.length > QPDF_BUDGET_FRAME_BYTES * 2) {
      throw new Error("QPDF budget control protocol exceeded its frame ceiling.");
    }
    const available = this.pending.length
      ? Buffer.concat([this.pending, bytes])
      : bytes;
    let offset = 0;
    while (available.length - offset >= QPDF_BUDGET_FRAME_BYTES) {
      if (this.frames.length >= 2) {
        throw new Error("QPDF budget control protocol emitted extra frames.");
      }
      this.frames.push(this.#decode(
        available.subarray(offset, offset + QPDF_BUDGET_FRAME_BYTES),
      ));
      offset += QPDF_BUDGET_FRAME_BYTES;
    }
    this.pending = Buffer.from(available.subarray(offset));
  }

  #decode(frame) {
    if (!frame.subarray(0, 4).equals(QPDF_BUDGET_MAGIC)
        || frame[4] !== QPDF_BUDGET_PROTOCOL_VERSION
        || frame[10] !== 0 || frame[11] !== 0
        || frame.subarray(28, 32).some(byte => byte !== 0)) {
      throw new Error("QPDF budget control frame header is invalid.");
    }
    const type = frame[5];
    const sequence = frame.readUInt16BE(6);
    const stage = frame.readUInt16BE(8);
    const errorNumber = frame.readUInt32BE(12);
    const pid = frame.readUInt32BE(16);
    const pgid = frame.readUInt32BE(20);
    const sid = frame.readUInt32BE(24);
    if (![QPDF_BUDGET_READY, QPDF_BUDGET_ERROR].includes(type)
        || sequence !== this.frames.length
        || !integer(stage, 1, QPDF_BUDGET_STAGE_EXEC)
        || !integer(pid, 2, 2147483647)
        || !integer(pgid, 2, 2147483647)
        || !integer(sid, 1, 2147483647)
        || (this.expectedPgid !== null && pgid !== this.expectedPgid
          && !(type === QPDF_BUDGET_ERROR
            && sequence === 0
            && stage === QPDF_BUDGET_STAGE_GROUP))) {
      throw new Error("QPDF budget control frame identity is invalid.");
    }
    const names = [
      "address_space",
      "file_size",
      "cpu",
      "nofile",
      "core",
    ];
    const limits = {};
    let offset = 32;
    for (const name of names) {
      const currentBig = frame.readBigUInt64BE(offset);
      const maximumBig = frame.readBigUInt64BE(offset + 8);
      const infinity = BigInt("18446744073709551615");
      if ((currentBig > BigInt(Number.MAX_SAFE_INTEGER)
            && currentBig !== infinity)
          || (maximumBig > BigInt(Number.MAX_SAFE_INTEGER)
            && maximumBig !== infinity)) {
        throw new Error("QPDF budget control limit is not safely representable.");
      }
      limits[name] = {
        current: currentBig === infinity ? "infinity" : Number(currentBig),
        maximum: maximumBig === infinity ? "infinity" : Number(maximumBig),
      };
      offset += 16;
    }
    const addressSpaceBaselineBytes = frame.readBigUInt64BE(112);
    const addressSpaceHeadroomBytes = frame.readBigUInt64BE(120);
    const addressSpaceObservedBytes = frame.readBigUInt64BE(128);
    const input = {
      device: frame.readBigUInt64BE(136).toString(),
      inode: frame.readBigUInt64BE(144).toString(),
      bytes: Number(frame.readBigUInt64BE(152)),
      mode: frame.readUInt32BE(160),
      links: frame.readUInt32BE(164),
      owner: frame.readUInt32BE(168),
      group: frame.readUInt32BE(172),
    };
    if (addressSpaceBaselineBytes > BigInt(Number.MAX_SAFE_INTEGER)
        || addressSpaceHeadroomBytes > BigInt(Number.MAX_SAFE_INTEGER)
        || addressSpaceObservedBytes > BigInt(Number.MAX_SAFE_INTEGER)
        || frame.readBigUInt64BE(152) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("QPDF budget address-space proof is not safely representable.");
    }
    if (type === QPDF_BUDGET_READY
        && (sequence !== 0 || stage !== QPDF_BUDGET_STAGE_READY
          || errorNumber !== 0
          || !validInputKernelProjection(input)
          || (this.expectedInput !== null
            && canonicalJson(input) !== canonicalJson(this.expectedInput))
          || !limitsEqualPolicy(
            limits,
            this.expectedPolicy,
            Number(addressSpaceBaselineBytes),
            Number(addressSpaceHeadroomBytes),
            Number(addressSpaceObservedBytes),
          ))) {
      throw new Error("QPDF budget READY frame does not prove the exact policy.");
    }
    if (type === QPDF_BUDGET_ERROR
        && (errorNumber === 0
          || (sequence === 1 && (this.frames[0]?.type !== QPDF_BUDGET_READY
            || stage !== QPDF_BUDGET_STAGE_EXEC))
          || (sequence === 0 && stage === QPDF_BUDGET_STAGE_EXEC))) {
      throw new Error("QPDF budget ERROR frame lifecycle is invalid.");
    }
    return {
      type,
      sequence,
      stage,
      error_number: errorNumber,
      pid,
      pgid,
      sid,
      input: type === QPDF_BUDGET_READY ? input : null,
      limits,
      address_space_baseline_bytes: Number(addressSpaceBaselineBytes),
      address_space_headroom_bytes: Number(addressSpaceHeadroomBytes),
      address_space_observed_bytes: Number(addressSpaceObservedBytes),
    };
  }

  finish({ spawnedPid = null, controlEof = false } = {}) {
    if (controlEof !== true
        || this.pending.length !== 0 || this.frames.length < 1) {
      throw new Error("QPDF budget control lifecycle is incomplete.");
    }
    if (spawnedPid !== null
        && this.frames.some(frame => frame.pid !== spawnedPid)) {
      throw new Error("QPDF budget control PID does not match the spawned child.");
    }
    const [first, second] = this.frames;
    if (first.type === QPDF_BUDGET_ERROR) {
      if (second) throw new Error("QPDF budget setup error emitted extra frames.");
      return {
        ready: null,
        error: first,
        control_eof_after_ready: false,
      };
    }
    if (first.type !== QPDF_BUDGET_READY) {
      throw new Error("QPDF budget lifecycle did not begin with READY.");
    }
    if (second && second.type !== QPDF_BUDGET_ERROR) {
      throw new Error("QPDF budget lifecycle has an invalid terminal frame.");
    }
    return {
      ready: first,
      error: second ?? null,
      control_eof_after_ready: second === undefined,
    };
  }
}

function limitsEqualPolicy(
  limits,
  policy,
  addressSpaceBaselineBytes,
  addressSpaceHeadroomBytes,
  addressSpaceObservedBytes,
) {
  return integer(addressSpaceBaselineBytes, 1)
    && addressSpaceHeadroomBytes === policy.address_space_headroom_bytes
    && Number.isSafeInteger(
      addressSpaceBaselineBytes + addressSpaceHeadroomBytes,
    )
    && limits.address_space.current
      === addressSpaceBaselineBytes + addressSpaceHeadroomBytes
    && limits.address_space.maximum
      === addressSpaceBaselineBytes + addressSpaceHeadroomBytes
    && integer(addressSpaceObservedBytes, 1)
    && addressSpaceObservedBytes
      <= addressSpaceBaselineBytes + addressSpaceHeadroomBytes
    && limits.file_size.current === policy.file_size_bytes
    && limits.file_size.maximum === policy.file_size_bytes
    && limits.cpu.current === policy.cpu_soft_seconds
    && limits.cpu.maximum === policy.cpu_hard_seconds
    && limits.nofile.current === policy.nofile
    && limits.nofile.maximum === policy.nofile
    && limits.core.current === policy.core_bytes
    && limits.core.maximum === policy.core_bytes;
}

export function validQpdfPolicy(value) {
  return exactKeys(value, [
    "address_space_headroom_bytes",
    "calibration_required",
    "core_bytes",
    "cpu_hard_seconds",
    "cpu_soft_seconds",
    "file_size_bytes",
    "nofile",
    "wall_timeout_ms",
  ])
    && integer(
      value.address_space_headroom_bytes,
      16 * 1024 * 1024,
      512 * 2 ** 30,
    )
    && integer(value.file_size_bytes, 1024 * 1024, 1024 * 2 ** 30)
    && integer(value.cpu_soft_seconds, 1, 3600)
    && integer(value.cpu_hard_seconds, value.cpu_soft_seconds, 3601)
    && integer(value.nofile, 4, 4096)
    && integer(value.wall_timeout_ms, 100, 60_000)
    && value.core_bytes === 0
    && value.calibration_required === true;
}

function identityMatches(actual, expected) {
  return validIdentity(expected)
    && canonicalJson(actual) === canonicalJson(expected);
}

function collectOutput(maximum, onOverflow) {
  const chunks = [];
  let observed = 0;
  let overflowed = false;
  return {
    add(chunk) {
      const bytes = Buffer.from(chunk);
      observed += bytes.length;
      if (observed <= maximum) chunks.push(bytes);
      if (observed > maximum && !overflowed) {
        overflowed = true;
        onOverflow();
      }
    },
    result() {
      const bytes = Buffer.concat(chunks);
      return {
        bytes: observed,
        sha256: sha256(bytes),
        text: bytes.toString("utf8"),
        overflowed,
      };
    },
  };
}

export async function runBudgetedQpdfCommand({
  launcher,
  qpdf,
  input,
  args,
  expectedPgid,
  timeoutMs,
  outputMaxBytes,
  policy = QPDF_ORACLE_POLICY,
  cwd = undefined,
  spawnProcess = spawn,
  platform = process.platform,
}) {
  if (platform !== "darwin" || !validIdentity(launcher)
      || !validIdentity(qpdf, 64 * 1024 * 1024)
      || !exactKeys(input, ["handle", "identity"])
      || !input.handle
      || !integer(input.handle.fd, 0, 2147483647)
      || !validInputIdentity(input.identity)
      || !Array.isArray(args) || args.some(arg => typeof arg !== "string")
      || !args.includes("/dev/fd/4")
      || !integer(expectedPgid, 2, 2147483647)
      || !validQpdfPolicy(policy)
      || !integer(timeoutMs, 1, 60_000)
      || timeoutMs !== policy.wall_timeout_ms
      || !integer(outputMaxBytes, 1, 64 * 1024 * 1024)
      || (qpdf.mode & 0o111) === 0) {
    throw new TypeError("Invalid budgeted qpdf command authority.");
  }
  const [launcherObserved, qpdfObserved] = await Promise.all([
    qpdfBudgetFileIdentity(launcher.path, MAX_BINARY_BYTES, [0o700, 0o755]),
    qpdfBudgetFileIdentity(qpdf.path, 64 * 1024 * 1024),
  ]);
  if (!identityMatches(launcherObserved, launcher)
      || !identityMatches(qpdfObserved, qpdf)) {
    throw new Error("Budgeted qpdf executable identity changed before spawn.");
  }
  const inputObserved = await retainedQpdfInputIdentity(
    input.handle,
    input.identity.path,
    input.identity.bytes,
  );
  if (canonicalJson(inputObserved) !== canonicalJson(input.identity)) {
    throw new Error("Retained qpdf input identity changed before spawn.");
  }
  const expectedInput = inputKernelProjection(input.identity);
  const launcherArgs = [
    "--expected-parent-pid", String(process.pid),
    "--expected-pgid", String(expectedPgid),
    "--as-headroom-bytes", String(policy.address_space_headroom_bytes),
    "--fsize-bytes", String(policy.file_size_bytes),
    "--cpu-soft-seconds", String(policy.cpu_soft_seconds),
    "--cpu-hard-seconds", String(policy.cpu_hard_seconds),
    "--nofile", String(policy.nofile),
    "--input-device", input.identity.device,
    "--input-inode", input.identity.inode,
    "--input-bytes", String(input.identity.bytes),
    "--input-mode", String(input.identity.mode),
    "--input-links", String(input.identity.links),
    "--input-owner", String(input.identity.owner),
    "--input-group", String(input.identity.group),
    "--qpdf", qpdf.path,
    "--",
    ...args,
  ];
  let child;
  try {
    child = spawnProcess(launcher.path, launcherArgs, {
      cwd,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe", "pipe", input.handle.fd],
    });
  } catch (error) {
    return {
      protocol: QPDF_BUDGET_COMMAND_PROTOCOL,
      claim_boundary: QPDF_BUDGET_COMMAND_CLAIM_BOUNDARY,
      containment: {
        budget_enforced: false,
        expected_parent_pid: process.pid,
        expected_pgid: expectedPgid,
        ready: null,
        error: null,
        control_eof_after_ready: false,
        same_process_group: false,
        same_session: false,
        spawned_pid: null,
        launcher_sha256: launcher.sha256,
        input: input.identity,
        input_stable: false,
        input_error_sha256: null,
        control_error_sha256: sha256(Buffer.from(String(error.message), "utf8")),
      },
      policy,
      command: {
        outcome: "spawn_error",
        error_sha256: sha256(Buffer.from(String(error.message), "utf8")),
      },
      classification: "launcher_failed",
      pass: false,
    };
  }
  if (!child?.stdout || !child?.stderr || !child?.stdio?.[3]) {
    try { child?.kill("SIGKILL"); } catch {}
    throw new Error("Budgeted qpdf spawn did not provide its required pipes.");
  }
  const spawnedPid = integer(child.pid, 2, 2147483647) ? child.pid : null;
  const parser = new QpdfBudgetFrameParser({
    expectedPolicy: policy,
    expectedPgid,
    expectedInput,
  });
  let controlError = null;
  let controlEof = false;
  child.stdio[3].once("end", () => {
    controlEof = true;
  });
  child.stdio[3].on("data", chunk => {
    try {
      parser.add(chunk);
    } catch (error) {
      controlError ??= error;
      try { child.kill("SIGKILL"); } catch {}
    }
  });
  child.stdio[3].on("error", error => {
    controlError ??= error;
    try { child.kill("SIGKILL"); } catch {}
  });
  const stdout = collectOutput(outputMaxBytes, () => child.kill("SIGKILL"));
  const stderr = collectOutput(outputMaxBytes, () => child.kill("SIGKILL"));
  child.stdout.on("data", stdout.add);
  child.stderr.on("data", stderr.add);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch {}
  }, timeoutMs);
  timer.unref();
  let spawnError = null;
  const closed = await new Promise(resolve => {
    child.once("error", error => {
      spawnError = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const out = stdout.result();
  const err = stderr.result();
  let lifecycle = null;
  if (!controlError) {
    try {
      lifecycle = parser.finish({ spawnedPid, controlEof });
    } catch (error) {
      controlError = error;
    }
  }
  if (spawnError) controlError ??= spawnError;
  const budgetEnforced = controlError === null
    && spawnedPid !== null
    && lifecycle?.ready !== null
    && lifecycle?.control_eof_after_ready === true;
  const command = {
    outcome: "close",
    code: closed.code,
    signal: closed.signal,
    timed_out: timedOut,
    output_overflow: out.overflowed || err.overflowed,
    stdout: {
      bytes: out.bytes,
      sha256: out.sha256,
      text: out.text,
    },
    stderr: {
      bytes: err.bytes,
      sha256: err.sha256,
    },
  };
  const pass = budgetEnforced
    && closed.code === 0
    && closed.signal === null
    && !timedOut
    && !command.output_overflow;
  const classification = controlError || !lifecycle
    ? "launcher_failed"
    : lifecycle.error
      ? "launcher_failed"
      : timedOut
        ? "wall_timeout"
        : command.output_overflow
          ? "output_overflow"
          : pass
            ? "passed"
            : "qpdf_failed_under_enforced_budget";
  const [launcherAfter, qpdfAfter] = await Promise.all([
    qpdfBudgetFileIdentity(launcher.path, MAX_BINARY_BYTES, [0o700, 0o755]),
    qpdfBudgetFileIdentity(qpdf.path, 64 * 1024 * 1024),
  ]);
  const executablesStable = identityMatches(launcherAfter, launcher)
    && identityMatches(qpdfAfter, qpdf);
  let inputStable = false;
  let inputError = null;
  try {
    const inputAfter = await retainedQpdfInputIdentity(
      input.handle,
      input.identity.path,
      input.identity.bytes,
    );
    inputStable = canonicalJson(inputAfter) === canonicalJson(input.identity);
    if (!inputStable) {
      inputError = new Error("Retained qpdf input identity changed after spawn.");
    }
  } catch (error) {
    inputError = error;
  }
  const finalPass = pass && executablesStable && inputStable;
  const finalClassification = executablesStable && inputStable
    ? classification
    : "launcher_failed";
  return {
    protocol: QPDF_BUDGET_COMMAND_PROTOCOL,
    claim_boundary: QPDF_BUDGET_COMMAND_CLAIM_BOUNDARY,
    containment: {
      budget_enforced: budgetEnforced,
      expected_parent_pid: process.pid,
      expected_pgid: expectedPgid,
      ready: lifecycle?.ready ?? null,
      error: lifecycle?.error ?? null,
      control_eof_after_ready:
        lifecycle?.control_eof_after_ready ?? false,
      same_process_group: lifecycle?.ready?.pgid === expectedPgid,
      same_session: budgetEnforced
        && integer(lifecycle?.ready?.sid, 1, 2147483647),
      spawned_pid: spawnedPid,
      launcher_sha256: launcher.sha256,
      executables_stable: executablesStable,
      input: input.identity,
      input_stable: inputStable,
      input_error_sha256: inputError
        ? sha256(Buffer.from(String(inputError.message), "utf8"))
        : null,
      control_error_sha256: controlError
        ? sha256(Buffer.from(String(controlError.message), "utf8"))
        : null,
    },
    policy,
    command,
    classification: finalClassification,
    pass: finalPass,
  };
}

export function boundedQpdfCommandEvidence(value, { retainStdoutText = false } = {}) {
  if (!value || value.protocol !== QPDF_BUDGET_COMMAND_PROTOCOL) {
    throw new TypeError("Invalid budgeted qpdf command evidence.");
  }
  if (value.command?.outcome !== "close") return value;
  return {
    ...value,
    command: {
      ...value.command,
      stdout: retainStdoutText
        ? value.command.stdout
        : {
            bytes: value.command.stdout.bytes,
            sha256: value.command.stdout.sha256,
          },
    },
  };
}

export async function compileQpdfMacosBudgetExec({
  sourcePath,
  outputPath,
  architecture = process.arch,
  testing = false,
} = {}) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)
      || typeof testing !== "boolean") {
    throw new Error("QPDF budget launcher compilation requires macOS arm64 or x64.");
  }
  const source = await qpdfBudgetFileIdentity(
    path.resolve(sourcePath),
    MAX_SOURCE_BYTES,
    [0o600, 0o644],
  );
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedOutput !== outputPath || path.extname(outputPath) !== "") {
    throw new Error("QPDF budget launcher output must be canonical and extensionless.");
  }
  await fs.lstat(outputPath).then(
    () => { throw new Error("Refusing to overwrite a qpdf budget launcher."); },
    error => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
  const outputParent = path.dirname(outputPath);
  await noLinkAncestors(outputParent);
  const parentMetadata = await fs.lstat(outputParent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
      || (parentMetadata.mode & 0o777) !== 0o700
      || await fs.realpath(outputParent) !== outputParent) {
    throw new Error("QPDF budget build output parent must be real mode 0700.");
  }
  const baseEnvironment = compileEnvironment(outputParent);
  const xcrun = "/usr/bin/xcrun";
  const compilerPath = await fs.realpath(commandOutput(
    xcrun,
    ["--sdk", "macosx", "--find", "clang"],
    baseEnvironment,
    outputParent,
  ));
  const sdkPath = await fs.realpath(commandOutput(
    xcrun,
    ["--sdk", "macosx", "--show-sdk-path"],
    baseEnvironment,
    outputParent,
  ));
  const compilerVersion = commandOutput(
    compilerPath,
    ["--version"],
    baseEnvironment,
    outputParent,
  );
  const sdkVersion = commandOutput(
    xcrun,
    ["--sdk", "macosx", "--show-sdk-version"],
    baseEnvironment,
    outputParent,
  );
  const compiler = await qpdfBudgetFileIdentity(
    compilerPath,
    256 * 1024 * 1024,
    [0o755],
  );
  const buildRoot = await fs.mkdtemp(path.join(
    outputParent,
    ".qpdf-budget-build-",
  ));
  await fs.chmod(buildRoot, 0o700);
  const artifact = path.join(buildRoot, "qpdf-budget-exec");
  const first = path.join(buildRoot, "qpdf-budget-exec-first");
  const archFlag = architecture === "x64" ? "x86_64" : architecture;
  const compile = destination => [
    ...BUILD_FLAGS,
    "-arch", archFlag,
    "-isysroot", sdkPath,
    ...(testing ? ["-DPDF_TOOLS_QPDF_BUDGET_TESTING=1"] : []),
    "-o", destination,
    source.path,
  ];
  try {
    let firstIdentity;
    for (let build = 0; build < 2; build += 1) {
      const result = spawnSync(compilerPath, compile(artifact), {
        cwd: buildRoot,
        env: compileEnvironment(buildRoot),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      });
      if (result.error || result.status !== 0 || result.signal !== null
          || result.stdout !== "" || result.stderr !== "") {
        throw new Error("Compiler rejected the qpdf budget launcher authority.");
      }
      await fs.chmod(artifact, 0o700);
      if (build === 0) {
        await fs.copyFile(artifact, first, fsConstants.COPYFILE_EXCL);
        await fs.chmod(first, 0o700);
        firstIdentity = await qpdfBudgetFileIdentity(first);
      }
    }
    const secondIdentity = await qpdfBudgetFileIdentity(artifact);
    if (firstIdentity.bytes !== secondIdentity.bytes
        || firstIdentity.sha256 !== secondIdentity.sha256) {
      throw new Error("QPDF budget launcher builds are not reproducible.");
    }
    await fs.copyFile(artifact, outputPath, fsConstants.COPYFILE_EXCL);
    await fs.chmod(outputPath, 0o700);
    const binary = await qpdfBudgetFileIdentity(outputPath);
    if (binary.bytes !== firstIdentity.bytes
        || binary.sha256 !== firstIdentity.sha256) {
      throw new Error("Published qpdf budget launcher differs from verified build.");
    }
    return {
      protocol: QPDF_BUDGET_BUILD_PROTOCOL,
      testing,
      platform: {
        operating_system: "macos",
        architecture,
        os_build: commandOutput(
          "/usr/bin/sw_vers",
          ["-buildVersion"],
          baseEnvironment,
          outputParent,
        ),
        kernel_release: os.release(),
      },
      source,
      compiler: { ...compiler, version: compilerVersion },
      sdk: { path: sdkPath, version: sdkVersion },
      command: [
        compilerPath,
        ...compile("$OUTPUT").map(value => {
          if (value === source.path) return "$SOURCE";
          if (value === sdkPath) return "$SDKROOT";
          return value;
        }),
      ],
      binary,
    };
  } finally {
    await fs.rm(buildRoot, { recursive: true, force: true });
  }
}

export async function verifyQpdfMacosBudgetExecBuild(build, {
  sourcePath,
  binaryPath,
  architecture = process.arch,
  testing = false,
  verifyToolchain = true,
} = {}) {
  if (!exactKeys(build, [
    "binary",
    "command",
    "compiler",
    "platform",
    "protocol",
    "sdk",
    "source",
    "testing",
  ]) || build.protocol !== QPDF_BUDGET_BUILD_PROTOCOL
      || build.testing !== testing
      || !exactKeys(build.platform, [
        "architecture",
        "kernel_release",
        "operating_system",
        "os_build",
      ])
      || build.platform.operating_system !== "macos"
      || build.platform.architecture !== architecture
      || typeof build.platform.os_build !== "string"
      || build.platform.os_build.length < 1
      || build.platform.os_build.length > 200
      || typeof build.platform.kernel_release !== "string"
      || build.platform.kernel_release.length < 1
      || build.platform.kernel_release.length > 200
      || !validIdentity(build.source, MAX_SOURCE_BYTES)
      || !validIdentity(build.binary)
      || !validCompilerIdentity(build.compiler)
      || !exactKeys(build.sdk, ["path", "version"])
      || typeof build.sdk.path !== "string"
      || path.resolve(build.sdk.path) !== build.sdk.path
      || typeof build.sdk.version !== "string"
      || build.sdk.version.length < 1
      || !Array.isArray(build.command)
      || build.command.some(value => typeof value !== "string")) {
    throw new Error("QPDF budget launcher build receipt is malformed.");
  }
  const [source, binary] = await Promise.all([
    qpdfBudgetFileIdentity(path.resolve(sourcePath), MAX_SOURCE_BYTES, [0o600, 0o644]),
    qpdfBudgetFileIdentity(path.resolve(binaryPath), MAX_BINARY_BYTES, [0o700, 0o755]),
  ]);
  if (canonicalJson(source) !== canonicalJson(build.source)
      || canonicalJson(binary) !== canonicalJson(build.binary)) {
    throw new Error("QPDF budget build receipt no longer binds source and binary.");
  }
  if (verifyToolchain) {
    if (process.platform !== "darwin") {
      throw new Error("QPDF budget toolchain verification requires macOS.");
    }
    const environment = compileEnvironment(path.dirname(binaryPath));
    const compilerPath = await fs.realpath(commandOutput(
      "/usr/bin/xcrun",
      ["--sdk", "macosx", "--find", "clang"],
      environment,
      path.dirname(binaryPath),
    ));
    const sdkPath = await fs.realpath(commandOutput(
      "/usr/bin/xcrun",
      ["--sdk", "macosx", "--show-sdk-path"],
      environment,
      path.dirname(binaryPath),
    ));
    const compiler = await qpdfBudgetFileIdentity(
      compilerPath,
      256 * 1024 * 1024,
      [0o755],
    );
    const compilerVersion = commandOutput(
      compilerPath,
      ["--version"],
      environment,
      path.dirname(binaryPath),
    );
    const sdkVersion = commandOutput(
      "/usr/bin/xcrun",
      ["--sdk", "macosx", "--show-sdk-version"],
      environment,
      path.dirname(binaryPath),
    );
    const osBuild = commandOutput(
      "/usr/bin/sw_vers",
      ["-buildVersion"],
      environment,
      path.dirname(binaryPath),
    );
    const archFlag = architecture === "x64" ? "x86_64" : architecture;
    const expectedCommand = [
      compilerPath,
      ...BUILD_FLAGS,
      "-arch", archFlag,
      "-isysroot", "$SDKROOT",
      ...(testing ? ["-DPDF_TOOLS_QPDF_BUDGET_TESTING=1"] : []),
      "-o", "$OUTPUT",
      "$SOURCE",
    ];
    if (compilerPath !== build.compiler.path || sdkPath !== build.sdk.path
        || canonicalJson({ ...compiler, version: compilerVersion })
          !== canonicalJson(build.compiler)
        || compilerVersion !== build.compiler.version
        || sdkVersion !== build.sdk.version
        || osBuild !== build.platform.os_build
        || os.release() !== build.platform.kernel_release
        || canonicalJson(build.command) !== canonicalJson(expectedCommand)) {
      throw new Error("QPDF budget build toolchain or host authority drifted.");
    }
  }
  return build;
}
