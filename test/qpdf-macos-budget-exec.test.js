import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  QPDF_BUDGET_ERROR,
  QPDF_BUDGET_FRAME_BYTES,
  QPDF_BUDGET_MAGIC,
  QPDF_BUDGET_PROTOCOL_VERSION,
  QPDF_BUDGET_STAGE_EXEC,
  QPDF_BUDGET_STAGE_GROUP,
  QPDF_BUDGET_STAGE_INPUT_FD,
  QPDF_BUDGET_STAGE_READY,
  QPDF_BUDGET_READY,
  QPDF_ORACLE_POLICY,
  QpdfBudgetFrameParser,
  compileQpdfMacosBudgetExec,
  openQpdfBudgetInput,
  qpdfBudgetFileIdentity,
  runBudgetedQpdfCommand,
  verifyQpdfMacosBudgetExecBuild,
} from "./eval/qpdf-macos-budget-exec.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FRAME_ADDRESS_SPACE_BASELINE_BYTES = 445_746_020_352;

function putLimit(frame, offset, current, maximum) {
  frame.writeBigUInt64BE(BigInt(current), offset);
  frame.writeBigUInt64BE(BigInt(maximum), offset + 8);
}

function frame({
  type = QPDF_BUDGET_READY,
  sequence = 0,
  stage = QPDF_BUDGET_STAGE_READY,
  errno = 0,
  pid = 101,
  pgid = 100,
  sid = 50,
  mutate = null,
} = {}) {
  const bytes = Buffer.alloc(QPDF_BUDGET_FRAME_BYTES);
  QPDF_BUDGET_MAGIC.copy(bytes, 0);
  bytes[4] = QPDF_BUDGET_PROTOCOL_VERSION;
  bytes[5] = type;
  bytes.writeUInt16BE(sequence, 6);
  bytes.writeUInt16BE(stage, 8);
  bytes.writeUInt32BE(errno, 12);
  bytes.writeUInt32BE(pid, 16);
  bytes.writeUInt32BE(pgid, 20);
  bytes.writeUInt32BE(sid, 24);
  putLimit(
    bytes,
    32,
    FRAME_ADDRESS_SPACE_BASELINE_BYTES
      + QPDF_ORACLE_POLICY.address_space_headroom_bytes,
    FRAME_ADDRESS_SPACE_BASELINE_BYTES
      + QPDF_ORACLE_POLICY.address_space_headroom_bytes,
  );
  putLimit(
    bytes,
    48,
    QPDF_ORACLE_POLICY.file_size_bytes,
    QPDF_ORACLE_POLICY.file_size_bytes,
  );
  putLimit(
    bytes,
    64,
    QPDF_ORACLE_POLICY.cpu_soft_seconds,
    QPDF_ORACLE_POLICY.cpu_hard_seconds,
  );
  putLimit(bytes, 80, QPDF_ORACLE_POLICY.nofile, QPDF_ORACLE_POLICY.nofile);
  putLimit(bytes, 96, 0, 0);
  bytes.writeBigUInt64BE(
    BigInt(FRAME_ADDRESS_SPACE_BASELINE_BYTES),
    112,
  );
  bytes.writeBigUInt64BE(
    BigInt(QPDF_ORACLE_POLICY.address_space_headroom_bytes),
    120,
  );
  bytes.writeBigUInt64BE(
    BigInt(FRAME_ADDRESS_SPACE_BASELINE_BYTES),
    128,
  );
  bytes.writeBigUInt64BE(1n, 136);
  bytes.writeBigUInt64BE(2n, 144);
  bytes.writeBigUInt64BE(5n, 152);
  bytes.writeUInt32BE(0o600, 160);
  bytes.writeUInt32BE(1, 164);
  bytes.writeUInt32BE(501, 168);
  bytes.writeUInt32BE(20, 172);
  mutate?.(bytes);
  return bytes;
}

test("fixed-endian fd3 lifecycle requires exact READY then CLOEXEC EOF", () => {
  const parser = new QpdfBudgetFrameParser({
    expectedPgid: 100,
  });
  const ready = frame();
  parser.add(ready.subarray(0, 17));
  parser.add(ready.subarray(17));
  assert.throws(
    () => parser.finish({ spawnedPid: 101 }),
    /lifecycle is incomplete/,
  );
  const lifecycle = parser.finish({
    spawnedPid: 101,
    controlEof: true,
  });
  assert.equal(lifecycle.control_eof_after_ready, true);
  assert.equal(lifecycle.error, null);
  assert.deepEqual(lifecycle.ready.limits.cpu, { current: 8, maximum: 9 });
  assert.equal(
    lifecycle.ready.address_space_baseline_bytes,
    FRAME_ADDRESS_SPACE_BASELINE_BYTES,
  );
  assert.equal(
    lifecycle.ready.address_space_headroom_bytes,
    QPDF_ORACLE_POLICY.address_space_headroom_bytes,
  );
  assert.equal(
    lifecycle.ready.address_space_observed_bytes,
    FRAME_ADDRESS_SPACE_BASELINE_BYTES,
  );
});

test("fd3 parser fails closed on framing, identity, policy, and exec errors", () => {
  for (const invalid of [
    frame({ mutate: bytes => { bytes[0] ^= 1; } }),
    frame({ mutate: bytes => { bytes[4] ^= 1; } }),
    frame({ pgid: 99 }),
    frame({ sid: 0 }),
    frame({ mutate: bytes => { bytes.writeBigUInt64BE(7n, 64); } }),
    frame({ mutate: bytes => { bytes.writeBigUInt64BE(0n, 112); } }),
    frame({
      mutate: bytes => {
        bytes.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER), 112);
      },
    }),
    frame({ mutate: bytes => { bytes.writeBigUInt64BE(0n, 136); } }),
    frame({ mutate: bytes => { bytes.writeUInt32BE(2, 164); } }),
    frame({ mutate: bytes => { bytes.writeBigUInt64BE(7n, 120); } }),
    frame({
      mutate: bytes => {
        bytes.writeBigUInt64BE(
          BigInt(
            FRAME_ADDRESS_SPACE_BASELINE_BYTES
              + QPDF_ORACLE_POLICY.address_space_headroom_bytes + 1,
          ),
          128,
        );
      },
    }),
  ]) {
    const parser = new QpdfBudgetFrameParser({
      expectedPgid: 100,
    });
    assert.throws(() => parser.add(invalid));
  }
  const inputMismatch = new QpdfBudgetFrameParser({
    expectedPgid: 100,
    expectedInput: {
      device: "1",
      inode: "99",
      bytes: 5,
      mode: 0o600,
      links: 1,
      owner: 501,
      group: 20,
    },
  });
  assert.throws(() => inputMismatch.add(frame()));

  const execFailure = new QpdfBudgetFrameParser({
    expectedPgid: 100,
  });
  execFailure.add(frame());
  execFailure.add(frame({
    type: QPDF_BUDGET_ERROR,
    sequence: 1,
    stage: QPDF_BUDGET_STAGE_EXEC,
    errno: 2,
  }));
  assert.equal(execFailure.finish({
    spawnedPid: 101,
    controlEof: true,
  }).control_eof_after_ready, false);

  const truncated = new QpdfBudgetFrameParser();
  truncated.add(frame().subarray(0, 111));
  assert.throws(() => truncated.finish({ controlEof: true }));

  const setupFailure = new QpdfBudgetFrameParser({
    expectedPgid: 100,
  });
  setupFailure.add(frame({
    type: QPDF_BUDGET_ERROR,
    sequence: 0,
    stage: 4,
    errno: 22,
  }));
  const setupLifecycle = setupFailure.finish({
    spawnedPid: 101,
    controlEof: true,
  });
  assert.equal(setupLifecycle.ready, null);
  assert.equal(setupLifecycle.control_eof_after_ready, false);

  const groupFailure = new QpdfBudgetFrameParser({
    expectedPgid: 100,
  });
  groupFailure.add(frame({
    type: QPDF_BUDGET_ERROR,
    sequence: 0,
    stage: QPDF_BUDGET_STAGE_GROUP,
    errno: 116,
    pgid: 99,
  }));
  const groupLifecycle = groupFailure.finish({
    spawnedPid: 101,
    controlEof: true,
  });
  assert.equal(groupLifecycle.ready, null);
  assert.equal(groupLifecycle.error.stage, QPDF_BUDGET_STAGE_GROUP);
  assert.equal(groupLifecycle.error.pgid, 99);
  assert.equal(groupLifecycle.control_eof_after_ready, false);
});

test("native launcher is exec-only and sets then gets every required limit", async () => {
  const source = await fs.readFile(path.join(
    REPO_ROOT,
    "test/eval/native/qpdf-macos-budget-exec.c",
  ), "utf8");
  assert.doesNotMatch(source, /\bfork\s*\(/);
  assert.doesNotMatch(source, /\bsetpgid\s*\(/);
  assert.doesNotMatch(source, /\bsetsid\s*\(/);
  assert.match(source, /FD_CLOEXEC/);
  assert.match(source, /#define INPUT_FD 4/);
  assert.match(source, /F_GETFL/);
  assert.match(source, /O_ACCMODE/);
  assert.match(source, /\bfstat\s*\(\s*INPUT_FD/);
  assert.match(source, /descriptor_flags & ~FD_CLOEXEC/);
  assert.match(source, /PROC_PIDLISTFDS/);
  assert.match(source, /exact_descriptor_set/);
  assert.match(source, /lseek\(INPUT_FD, 0, SEEK_SET\) != 0/);
  assert.match(source, /\bexecve\s*\(/);
  assert.match(source, /getppid\(\) != config\.expected_parent_pid/);
  assert.match(source, /getpgid\(config\.expected_parent_pid\)/);
  assert.match(source, /getsid\(config\.expected_parent_pid\)/);
  assert.match(source, /parent_sid != inherited_sid/);
  assert.match(source, /MACH_TASK_BASIC_INFO/);
  assert.match(source, /frame_address_space_observed_bytes/);
  for (const resource of [
    "RLIMIT_AS",
    "RLIMIT_FSIZE",
    "RLIMIT_CPU",
    "RLIMIT_NOFILE",
    "RLIMIT_CORE",
  ]) {
    assert.match(source, new RegExp(`apply_exact_limit\\(${resource}`));
  }
  assert.match(source, /setrlimit\(resource/);
  assert.match(source, /getrlimit\(resource/);
});

test("v3 and v4 rows have no direct qpdf route and short-circuit after check", async () => {
  for (const version of ["v3", "v4"]) {
    const source = await fs.readFile(path.join(
      REPO_ROOT,
      `test/helpers/deep-malformed-row-runner-${version}.js`,
    ), "utf8");
    assert.doesNotMatch(source, /runBoundedCommand/);
    assert.doesNotMatch(source, /spawn\s*\(\s*request\.qpdf\.path/);
    for (const route of [
      "--check",
      "--show-npages",
      "--object-streams=disable",
      "--json-output=2",
    ]) {
      assert.match(source, new RegExp(route.replace(/[=]/g, "\\=")));
    }
    assert.match(source, /const pages = qpdfCheckPass\s*\?/);
    assert.match(source, /const semanticFingerprint = qpdfCheckPass\s*\?/);
  }
});

test("macOS mechanism proves build authority, exact limits, and exec", {
  skip: process.platform !== "darwin",
}, async () => {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "qpdf-budget-test-"));
  await fs.chmod(root, 0o700);
  let input = null;
  try {
    const sourcePath = path.join(
      REPO_ROOT,
      "test/eval/native/qpdf-macos-budget-exec.c",
    );
    const outputPath = path.join(root, "qpdf-budget-exec");
    const receipt = await compileQpdfMacosBudgetExec({
      sourcePath,
      outputPath,
      testing: true,
    });
    await verifyQpdfMacosBudgetExecBuild(receipt, {
      sourcePath,
      binaryPath: outputPath,
      testing: true,
    });
    const probeSourcePath = path.join(
      REPO_ROOT,
      "test/eval/native/qpdf-macos-address-space-probe.c",
    );
    const probePath = path.join(root, "qpdf-address-space-probe");
    const probeCompile = spawnSync(
      receipt.command[0],
      receipt.command.slice(1).map(value => {
        if (value === "$OUTPUT") return probePath;
        if (value === "$SOURCE") return probeSourcePath;
        if (value === "$SDKROOT") return receipt.sdk.path;
        return value;
      }),
      {
        cwd: root,
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          TMPDIR: root,
        },
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(probeCompile.error, undefined);
    assert.equal(probeCompile.status, 0);
    assert.equal(probeCompile.signal, null);
    assert.equal(probeCompile.stdout, "");
    assert.equal(probeCompile.stderr, "");
    await fs.chmod(probePath, 0o700);
    const fdProbeSourcePath = path.join(
      REPO_ROOT,
      "test/eval/native/qpdf-macos-fd4-probe.c",
    );
    const fdProbePath = path.join(root, "qpdf-fd4-probe");
    const fdProbeCompile = spawnSync(
      receipt.command[0],
      receipt.command.slice(1).map(value => {
        if (value === "$OUTPUT") return fdProbePath;
        if (value === "$SOURCE") return fdProbeSourcePath;
        if (value === "$SDKROOT") return receipt.sdk.path;
        return value;
      }),
      {
        cwd: root,
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          TMPDIR: root,
        },
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(fdProbeCompile.error, undefined);
    assert.equal(fdProbeCompile.status, 0);
    assert.equal(fdProbeCompile.signal, null);
    assert.equal(fdProbeCompile.stdout, "");
    assert.equal(fdProbeCompile.stderr, "");
    await fs.chmod(fdProbePath, 0o700);
    const driftedReceipt = structuredClone(receipt);
    driftedReceipt.compiler.sha256 = "0".repeat(64);
    await assert.rejects(
      verifyQpdfMacosBudgetExecBuild(driftedReceipt, {
        sourcePath,
        binaryPath: outputPath,
        testing: true,
      }),
    );
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
    const identity =
      identityResult.stdout.trim().split(/\s+/).map(Number);
    assert.equal(identity.length, 1);
    assert.ok(Number.isSafeInteger(identity[0]) && identity[0] >= 2);
    const launcher = await qpdfBudgetFileIdentity(outputPath);
    const qpdf = await qpdfBudgetFileIdentity(fdProbePath, 64 << 20);
    const inputPath = path.join(root, "input.pdf");
    await fs.writeFile(inputPath, "%PDF\n", { mode: 0o600 });
    input = await openQpdfBudgetInput(inputPath, 4096, [0o600]);
    const primingBuffer = Buffer.alloc(2);
    const primingRead = await input.handle.read(
      primingBuffer,
      0,
      primingBuffer.length,
      null,
    );
    assert.equal(primingRead.bytesRead, 2);
    const observation = await runBudgetedQpdfCommand({
      launcher,
      qpdf,
      input,
      args: ["/dev/fd/4"],
      expectedPgid: identity[0],
      timeoutMs: 10_000,
      outputMaxBytes: 4096,
      policy: QPDF_ORACLE_POLICY,
    });
    assert.equal(observation.classification, "passed");
    assert.equal(observation.containment.budget_enforced, true);
    assert.equal(observation.containment.control_eof_after_ready, true);
    assert.equal(observation.containment.same_process_group, true);
    assert.equal(observation.containment.same_session, true);
    assert.equal(
      observation.containment.expected_parent_pid,
      process.pid,
    );
    assert.equal(
      observation.containment.ready.stage,
      QPDF_BUDGET_STAGE_READY,
    );
    assert.equal(observation.containment.input_stable, true);
    assert.deepEqual(
      observation.containment.ready.input,
      {
        device: input.identity.device,
        inode: input.identity.inode,
        bytes: input.identity.bytes,
        mode: input.identity.mode,
        links: input.identity.links,
        owner: input.identity.owner,
        group: input.identity.group,
      },
    );
    assert.equal(observation.containment.error, null);
    assert.equal(observation.command.code, 0);
    assert.equal(observation.command.signal, null);

    const leakedDescriptor = await runBudgetedQpdfCommand({
      launcher,
      qpdf,
      input,
      args: ["/dev/fd/4"],
      expectedPgid: identity[0],
      timeoutMs: 10_000,
      outputMaxBytes: 4096,
      policy: QPDF_ORACLE_POLICY,
      spawnProcess: (executable, args, options) => spawn(
        executable,
        args,
        {
          ...options,
          stdio: [...options.stdio, input.handle.fd],
        },
      ),
    });
    assert.equal(leakedDescriptor.classification, "launcher_failed");
    assert.equal(leakedDescriptor.pass, false);
    assert.equal(
      leakedDescriptor.containment.error.stage,
      QPDF_BUDGET_STAGE_INPUT_FD,
    );

    const writableHandle = await fs.open(inputPath, "r+");
    try {
      const writableDescriptor = await runBudgetedQpdfCommand({
        launcher,
        qpdf,
        input: {
          handle: writableHandle,
          identity: input.identity,
        },
        args: ["/dev/fd/4"],
        expectedPgid: identity[0],
        timeoutMs: 10_000,
        outputMaxBytes: 4096,
        policy: QPDF_ORACLE_POLICY,
      });
      assert.equal(writableDescriptor.classification, "launcher_failed");
      assert.equal(writableDescriptor.pass, false);
      assert.equal(
        writableDescriptor.containment.error.stage,
        QPDF_BUDGET_STAGE_INPUT_FD,
      );
    } finally {
      await writableHandle.close();
    }

    await assert.rejects(
      runBudgetedQpdfCommand({
        launcher,
        qpdf,
        input: {
          handle: input.handle,
          identity: {
            ...input.identity,
            inode: "99",
          },
        },
        args: ["/dev/fd/4"],
        expectedPgid: identity[0],
        timeoutMs: 10_000,
        outputMaxBytes: 4096,
        policy: QPDF_ORACLE_POLICY,
      }),
      /changed before spawn/,
    );

    const mappingDenial = await runBudgetedQpdfCommand({
      launcher,
      qpdf: await qpdfBudgetFileIdentity(probePath, 64 << 20),
      input,
      args: ["/dev/fd/4"],
      expectedPgid: identity[0],
      timeoutMs: 10_000,
      outputMaxBytes: 4096,
      policy: QPDF_ORACLE_POLICY,
    });
    assert.equal(mappingDenial.classification, "passed");
    assert.equal(mappingDenial.containment.budget_enforced, true);
    assert.equal(mappingDenial.containment.control_eof_after_ready, true);
    assert.equal(mappingDenial.command.code, 0);
    assert.equal(mappingDenial.command.signal, null);

    const wrongGroup = await runBudgetedQpdfCommand({
      launcher,
      qpdf,
      input,
      args: ["/dev/fd/4"],
      expectedPgid: identity[0] + 1,
      timeoutMs: 10_000,
      outputMaxBytes: 4096,
      policy: QPDF_ORACLE_POLICY,
    });
    assert.equal(wrongGroup.classification, "launcher_failed");
    assert.equal(wrongGroup.pass, false);
    assert.equal(wrongGroup.containment.ready, null);
    assert.equal(wrongGroup.containment.error.stage, 2);
    assert.equal(wrongGroup.containment.control_eof_after_ready, false);

    const malformedPath = path.join(root, "malformed-qpdf");
    await fs.writeFile(malformedPath, "not a Mach-O executable", { mode: 0o700 });
    const execFailure = await runBudgetedQpdfCommand({
      launcher,
      qpdf: await qpdfBudgetFileIdentity(malformedPath, 64 << 20),
      input,
      args: ["/dev/fd/4"],
      expectedPgid: identity[0],
      timeoutMs: 10_000,
      outputMaxBytes: 4096,
      policy: QPDF_ORACLE_POLICY,
    });
    assert.equal(execFailure.classification, "launcher_failed");
    assert.equal(execFailure.containment.control_eof_after_ready, false);
    assert.equal(
      execFailure.containment.ready.stage,
      QPDF_BUDGET_STAGE_READY,
    );
    assert.equal(
      execFailure.containment.error.stage,
      QPDF_BUDGET_STAGE_EXEC,
    );
  } finally {
    await input?.handle.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
