import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { assertSchema } from "./extraction-phase1-protocol.js";
import {
  DOCLING_BOOTSTRAP_V1,
  isValidDoclingUvVersion,
  prepareDoclingMacHandoff,
  prepareDoclingMacHandoffForTest,
} from "./extraction-docling-handoff.js";
import { canonicalJson, normalizeUvLockSentinels, validateFinalizationSchemaMirror } from "../../scripts/eval-docling-authority.mjs";

const roots = [];
const DARWIN_ARM64 = {
  platform: "darwin", architecture: "arm64", os_build: "25G88", kernel_release: "25.6.0", node_version: process.version,
};
const SILVERBOOK_UV_VERSION = "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple-darwin)";
const LEAP_DAY_UV_VERSION = "uv 0.11.29 (901092ee1 2024-02-29 aarch64-apple-darwin)";
const LEAP_CENTURY_UV_VERSION = "uv 0.11.29 (901092ee1 2000-02-29 aarch64-apple-darwin)";
const HOSTILE_UV_VERSIONS = [
  "uv 0.11.29 (901092 2026-07-15 aarch64-apple-darwin)",
  "uv 0.11.29 (901092eeG 2026-07-15 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 2026-13-15 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 2026-07-32 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 2025-02-29 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 2026-02-30 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 2026-02-31 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 2026-04-31 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 1900-02-29 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 0000-01-01 aarch64-apple-darwin)",
  "uv 0.11.29 (901092ee1 2026-07-15 aarch64-Apple-darwin)",
  "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple)",
  "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple-darwin) trailing",
  "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple-darwin)\n",
];

async function temporaryRoot(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  await fs.chmod(root, 0o700);
  return root;
}

async function fixture(root, name = "fixture.pdf") {
  const filename = path.join(root, name);
  await fs.writeFile(filename, "%PDF-1.7\ntruth-free handoff fixture\n%%EOF\n", { mode: 0o600 });
  return filename;
}

async function uvLockFixture() {
  const root = await temporaryRoot("pdf-tools-docling-uv-lock-");
  const managed = path.join(root, "managed-python");
  const snapshot = path.join(root, "snapshot");
  const venv = path.join(snapshot, "venv");
  const managedPython = path.join(managed, "cpython/bin/python3.12");
  const venvPython = path.join(venv, "bin/python");
  const managedLock = path.join(managed, ".lock");
  const venvLock = path.join(venv, ".lock");
  const packageLock = path.join(venv, "lib/python3.12/site-packages/setuptools/_vendor/.lock");
  await fs.mkdir(path.dirname(managedPython), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.dirname(venvPython), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.dirname(packageLock), { recursive: true, mode: 0o755 });
  await Promise.all([fs.chmod(managed, 0o700), fs.chmod(snapshot, 0o700), fs.chmod(venv, 0o755)]);
  await fs.writeFile(managedPython, "python", { mode: 0o755 });
  await fs.symlink(managedPython, venvPython);
  await Promise.all([
    fs.writeFile(managedLock, "", { mode: 0o600 }),
    fs.writeFile(venvLock, "", { mode: 0o600 }),
    fs.writeFile(packageLock, "", { mode: 0o600 }),
  ]);
  await Promise.all([fs.chmod(managedLock, 0o666), fs.chmod(venvLock, 0o666)]);
  return {
    root, managed, snapshot, venv, managedPython, venvPython, managedLock, venvLock, packageLock,
    receipt: { roots: { uv_python_install: managed, sidecar_snapshot: snapshot } },
  };
}

async function options(root, fixturePaths, uvVersion = "uv 0.8.15") {
  const uvPath = path.join(root, "uv-test-binary");
  const shellVersion = uvVersion.replaceAll("'", "'\\''");
  try {
    await fs.writeFile(uvPath, `#!/bin/sh
if [ "$1" = python ] && [ "$2" = install ]; then
  case " $* " in
    *" --no-bin "*) ;;
    *) /bin/mkdir -p "$HOME/.local/bin"; : > "$HOME/.local/bin/python3.12" ;;
  esac
  exit 0
fi
printf '%s\\n' '${shellVersion}'
`, { mode: 0o700, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return {
    cacheRoot: path.join(root, "Library/Caches/oda-pdf-tools-extraction"),
    sidecarRoot: path.join(root, "Sites/pdf-tools-extraction-sidecars"),
    protectedRoots: [path.join(root, "Documents"), path.join(root, "Dropbox"), path.join(root, "Library/Mobile Documents")],
    fixturePaths,
    testOnlyHost: DARWIN_ARM64,
    testOnlyUv: { path: uvPath, version: uvVersion },
  };
}

async function mutationCase(suffix) {
  const root = await temporaryRoot(`pdf-tools-docling-mutation-${suffix}-`);
  const result = await prepareDoclingMacHandoffForTest(await options(root, [await fixture(root)]));
  return { root, result };
}

function cleanVerifyCommand(result) {
  return result.receipt.setup.authority_command.map(value => value === "setup" ? "verify"
    : value === "$OUT_OF_BAND_RECEIPT_SHA256" ? result.receipt_sha256
      : value === "$OUT_OF_BAND_PROTECTED_ROOTS_JSON" ? result.protected_roots_json : value);
}

function runCleanVerify(result, environment = process.env) {
  const command = cleanVerifyCommand(result);
  return spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: environment });
}

async function rewriteCanonicalReceipt(result, receipt) {
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  await fs.writeFile(result.receiptPath, bytes);
  return { ...result, receipt_sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function bootstrapMutationCase(suffix) {
  const root = await temporaryRoot(`pdf-tools-docling-bootstrap-${suffix}-`);
  const bootstrapRoot = path.join(root, "bootstrap-source");
  await fs.mkdir(path.join(bootstrapRoot, "scripts"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(bootstrapRoot, "test/eval"), { recursive: true, mode: 0o700 });
  const cliPath = path.join(bootstrapRoot, "scripts/eval-verify-docling-macos-handoff.mjs");
  const verifierPath = path.join(bootstrapRoot, "test/eval/extraction-docling-handoff-verifier.js");
  await fs.copyFile(path.resolve("scripts/eval-verify-docling-macos-handoff.mjs"), cliPath);
  await fs.copyFile(path.resolve("test/eval/extraction-docling-handoff-verifier.js"), verifierPath);
  await Promise.all([fs.chmod(cliPath, 0o644), fs.chmod(verifierPath, 0o644)]);
  const result = await prepareDoclingMacHandoffForTest({
    ...(await options(root, [await fixture(root)])),
    testOnlyBootstrapRoot: bootstrapRoot,
  });
  return { root, result, cliPath, verifierPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Docling macOS handoff", () => {
  it("normalizes only the two exact uv lock sentinels while preserving managed-runtime symlinks", async () => {
    const value = await uvLockFixture();
    await normalizeUvLockSentinels(value.receipt);
    expect((await fs.lstat(value.managedLock)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(value.venvLock)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(value.packageLock)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(value.venvPython)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(value.venvPython)).toBe(value.managedPython);
  });

  it("rejects any other writable runtime entry before changing either sentinel", async () => {
    const value = await uvLockFixture();
    const extra = path.join(value.venv, "unexpected-writable");
    await fs.writeFile(extra, "", { mode: 0o600 });
    await fs.chmod(extra, 0o666);
    await expect(normalizeUvLockSentinels(value.receipt)).rejects.toThrow(/unexpected group\/other-writable entry/i);
    expect((await fs.lstat(value.managedLock)).mode & 0o777).toBe(0o666);
    expect((await fs.lstat(value.venvLock)).mode & 0o777).toBe(0o666);
  });

  it.each(["symlink", "special", "nonzero", "hardlink", "mode", "missing", "root-mode", "root-substitution", "parent-substitution"])("rejects a %s uv lock sentinel mutation", async mutation => {
    const value = await uvLockFixture();
    if (mutation === "symlink") {
      await fs.unlink(value.venvLock);
      await fs.symlink(value.packageLock, value.venvLock);
    } else if (mutation === "special") {
      await fs.unlink(value.venvLock);
      const fifo = spawnSync("/usr/bin/mkfifo", [value.venvLock], { encoding: "utf8" });
      expect(fifo.status, fifo.stderr).toBe(0);
    } else if (mutation === "nonzero") {
      await fs.writeFile(value.venvLock, "not empty");
      await fs.chmod(value.venvLock, 0o666);
    } else if (mutation === "hardlink") {
      const target = path.join(value.root, "hardlink-target");
      await fs.unlink(value.venvLock);
      await fs.writeFile(target, "", { mode: 0o600 });
      await fs.chmod(target, 0o666);
      await fs.link(target, value.venvLock);
    } else if (mutation === "mode") {
      await fs.chmod(value.venvLock, 0o644);
    } else if (mutation === "missing") {
      await fs.unlink(value.venvLock);
    } else if (mutation === "root-mode") {
      await fs.chmod(value.managed, 0o755);
    } else if (mutation === "root-substitution") {
      const real = `${value.managed}-real`;
      await fs.rename(value.managed, real);
      await fs.symlink(real, value.managed);
    } else if (mutation === "parent-substitution") {
      const real = `${value.venv}-real`;
      await fs.rename(value.venv, real);
      await fs.symlink(real, value.venv);
    }
    await expect(normalizeUvLockSentinels(value.receipt)).rejects.toThrow();
  });

  it("enforces the retained finalization schema mirror before live-state checks", async () => {
    const sha = "a".repeat(64);
    const uvTool = { path: "/private/uv", version: SILVERBOOK_UV_VERSION, bytes: 1, sha256: sha, mode: 0o755, links: 1 };
    const nodeTool = { path: "/private/node", version: "v24.4.1", bytes: 1, sha256: sha, mode: 0o755, links: 1 };
    const tree = [{ relative_path: "file", type: "file", mode: 0o600, links: 1, bytes: 1, sha256: sha }];
    const rootRecord = { path: "/private/root", real_path: "/private/root", mode: 0o700, links: 1 };
    const value = {
      protocol: "pdf-tools.docling-finalization.v1", handoff_id: sha, receipt_sha256: sha,
      platform: { interpreter: "cpython-3.12.13-macos-aarch64-none", operating_system: "macos", architecture: "arm64", os_build: "25G88", kernel_release: "25.6.0", node_version: "v24.4.1" },
      toolchain: { uv: uvTool, node: nodeTool }, lock: { bytes: 0, sha256: sha },
      python: { path: "/private/python", bytes: 1, sha256: sha, version: "Python 3.12.13" },
      installed_distributions: [["docling-slim", "2.114.0"]], model_files: tree, managed_python_files: tree, venv_files: tree,
      root_policy: Object.fromEntries(["uv", "uv_python_install", "models", "runs", "sidecar_snapshot", "authority_home", "authority_tmp", "hf_cache"].map(name => [name, rootRecord])),
      network_isolation_enforced: false, execution_state: "setup_complete_not_executed", finalization_id: sha,
    };
    const schema = JSON.parse(await fs.readFile(path.resolve("test/fixtures/eval/extraction/phase1/docling-finalization.schema.json"), "utf8"));
    expect(() => validateFinalizationSchemaMirror(value)).not.toThrow();
    expect(() => assertSchema(value, schema, "Docling finalization")).not.toThrow();
    const ownerExecuteOnlyTree = [{ ...tree[0], mode: 0o711 }];
    const ownerExecuteOnlyValue = { ...value, managed_python_files: ownerExecuteOnlyTree, venv_files: ownerExecuteOnlyTree };
    expect(() => validateFinalizationSchemaMirror(ownerExecuteOnlyValue)).not.toThrow();
    expect(() => assertSchema(ownerExecuteOnlyValue, schema, "Docling finalization")).not.toThrow();
    const ownerExecuteOnlyModel = { ...value, model_files: ownerExecuteOnlyTree };
    expect(() => validateFinalizationSchemaMirror(ownerExecuteOnlyModel)).toThrow(/schema mirror/);
    expect(() => assertSchema(ownerExecuteOnlyModel, schema, "Docling finalization")).toThrow();
    for (const mode of [0o700, 0o755, 0o777]) {
      const symlinkTree = [{ relative_path: "bin/python", type: "symlink", mode, links: 1, target: "/private/managed/python" }];
      const symlinkValue = { ...value, managed_python_files: symlinkTree, venv_files: symlinkTree };
      expect(() => validateFinalizationSchemaMirror(symlinkValue)).not.toThrow();
      expect(() => assertSchema(symlinkValue, schema, "Docling finalization")).not.toThrow();
    }
    for (const mode of [0o700, 0o755, 0o777]) {
      const privateModelSymlink = { ...value, model_files: [{ relative_path: "model-link", type: "symlink", mode, links: 1, target: "/private/model" }] };
      expect(() => validateFinalizationSchemaMirror(privateModelSymlink)).toThrow(/schema mirror/);
      expect(() => assertSchema(privateModelSymlink, schema, "Docling finalization")).toThrow();
    }
    for (const mode of [0o000, 0o705, 0o711, 0o733, 0o775]) {
      const unsafeSymlinkTree = [{ relative_path: "bin/python", type: "symlink", mode, links: 1, target: "/private/managed/python" }];
      const unsafeSymlinkValue = { ...value, managed_python_files: unsafeSymlinkTree, venv_files: unsafeSymlinkTree };
      expect(() => validateFinalizationSchemaMirror(unsafeSymlinkValue)).toThrow(/schema mirror/);
      expect(() => assertSchema(unsafeSymlinkValue, schema, "Docling finalization")).toThrow();
    }
    for (const inventoryName of ["managed_python_files", "venv_files"]) {
      for (const relative_path of ["../models/weight", "bin/../models/weight", "bin/./python", "bin//python", "/bin/python", "bin\\python", "bin/python/"]) {
        const forgedPathValue = { ...ownerExecuteOnlyValue, [inventoryName]: [{ ...ownerExecuteOnlyTree[0], relative_path }] };
        expect(() => validateFinalizationSchemaMirror(forgedPathValue)).toThrow(/schema mirror/);
        expect(() => assertSchema(forgedPathValue, schema, "Docling finalization")).toThrow();
        const forgedSymlinkValue = { ...value, [inventoryName]: [{ relative_path, type: "symlink", mode: 0o700, links: 1, target: "/private/managed/python" }] };
        expect(() => validateFinalizationSchemaMirror(forgedSymlinkValue)).toThrow(/schema mirror/);
        expect(() => assertSchema(forgedSymlinkValue, schema, "Docling finalization")).toThrow();
      }
    }
    for (const mode of [0o771, 0o733, 0o760]) {
      const unsafeTree = [{ ...tree[0], mode }];
      const unsafeValue = { ...value, managed_python_files: unsafeTree, venv_files: unsafeTree };
      expect(() => validateFinalizationSchemaMirror(unsafeValue)).toThrow(/schema mirror/);
      expect(() => assertSchema(unsafeValue, schema, "Docling finalization")).toThrow();
    }
    const leapValue = { ...value, toolchain: { ...value.toolchain, uv: { ...uvTool, version: LEAP_DAY_UV_VERSION } } };
    expect(() => validateFinalizationSchemaMirror(leapValue)).not.toThrow();
    expect(() => assertSchema(leapValue, schema, "Docling finalization")).not.toThrow();
    const leapCenturyValue = { ...value, toolchain: { ...value.toolchain, uv: { ...uvTool, version: LEAP_CENTURY_UV_VERSION } } };
    expect(() => validateFinalizationSchemaMirror(leapCenturyValue)).not.toThrow();
    expect(() => assertSchema(leapCenturyValue, schema, "Docling finalization")).not.toThrow();
    expect(() => validateFinalizationSchemaMirror({ ...value, python: { ...value.python, version: "Python 3.12.14" } })).toThrow(/schema mirror/);
    expect(() => validateFinalizationSchemaMirror({ ...value, model_files: [] })).toThrow(/schema mirror/);
    for (const version of HOSTILE_UV_VERSIONS) {
      expect(() => validateFinalizationSchemaMirror({ ...value, toolchain: { ...value.toolchain, uv: { ...uvTool, version } } })).toThrow(/schema mirror/);
      expect(() => assertSchema({ ...value, toolchain: { ...value.toolchain, uv: { ...uvTool, version } } }, schema, "Docling finalization")).toThrow();
    }
  });

  it("accepts and preserves the exact official uv metadata suffix", async () => {
    const root = await temporaryRoot("pdf-tools-docling-uv-metadata-");
    const result = await prepareDoclingMacHandoffForTest(await options(root, [await fixture(root)], SILVERBOOK_UV_VERSION));
    expect(result.receipt.toolchain.uv.version).toBe(SILVERBOOK_UV_VERSION);
    const schema = JSON.parse(await fs.readFile(path.resolve("test/fixtures/eval/extraction/phase1/docling-handoff.schema.json"), "utf8"));
    expect(() => assertSchema(result.receipt, schema, "Docling handoff receipt")).not.toThrow();
    const leapReceipt = { ...result.receipt, toolchain: { ...result.receipt.toolchain, uv: { ...result.receipt.toolchain.uv, version: LEAP_DAY_UV_VERSION } } };
    expect(() => assertSchema(leapReceipt, schema, "Docling handoff receipt")).not.toThrow();
    const leapCenturyReceipt = { ...result.receipt, toolchain: { ...result.receipt.toolchain, uv: { ...result.receipt.toolchain.uv, version: LEAP_CENTURY_UV_VERSION } } };
    expect(() => assertSchema(leapCenturyReceipt, schema, "Docling handoff receipt")).not.toThrow();
    for (const version of HOSTILE_UV_VERSIONS) {
      const malformed = { ...result.receipt, toolchain: { ...result.receipt.toolchain, uv: { ...result.receipt.toolchain.uv, version } } };
      expect(() => assertSchema(malformed, schema, "Docling handoff receipt")).toThrow();
    }
    const verification = runCleanVerify(result);
    expect(verification.status, verification.stderr).toBe(0);
  }, 10000);

  it("rejects malformed uv metadata suffixes", () => {
    expect(isValidDoclingUvVersion("uv 0.11.29")).toBe(true);
    expect(isValidDoclingUvVersion(SILVERBOOK_UV_VERSION)).toBe(true);
    expect(isValidDoclingUvVersion(LEAP_DAY_UV_VERSION)).toBe(true);
    expect(isValidDoclingUvVersion(LEAP_CENTURY_UV_VERSION)).toBe(true);
    for (const version of HOSTILE_UV_VERSIONS) expect(isValidDoclingUvVersion(version), version).toBe(false);
  });

  it("rejects a receipt-bound uv version that differs from live output", async () => {
    const root = await temporaryRoot("pdf-tools-docling-uv-live-mismatch-");
    const handoffOptions = await options(root, [await fixture(root)]);
    handoffOptions.testOnlyUv.version = SILVERBOOK_UV_VERSION;
    const result = await prepareDoclingMacHandoffForTest(handoffOptions);
    const verification = runCleanVerify(result);
    expect(verification.status).not.toBe(0);
    expect(verification.stderr).toMatch(/reported version differs from receipt identity/i);
  });

  it("creates a truth-free, content-addressed, mode-0700/0600 handoff outside protected roots", async () => {
    const root = await temporaryRoot("pdf-tools-docling-handoff-");
    const source = await fixture(root);
    const result = await prepareDoclingMacHandoffForTest(await options(root, [source]));
    const schema = JSON.parse(await fs.readFile(path.resolve("test/fixtures/eval/extraction/phase1/docling-handoff.schema.json"), "utf8"));
    expect(() => assertSchema(result.receipt, schema, "Docling handoff receipt")).not.toThrow();
    expect(result.receipt).toMatchObject({
      protocol: "pdf-tools.docling-macos-handoff.v1",
      execution_state: "not_run",
      setup: { network_required: true },
      execution: { offline_intent: true, network_isolation_enforced: false },
    });
    expect(result.receipt.setup.authority_command.slice(0, 10)).toEqual([
      "/bin/sh", "-c", DOCLING_BOOTSTRAP_V1, "pdf-tools-docling-bootstrap.v1",
      result.receipt.toolchain.node.path, result.receipt.toolchain.node.sha256,
      String(result.receipt.toolchain.node.bytes), result.receipt.toolchain.node.mode.toString(8),
      String(result.receipt.toolchain.node.links), path.join(path.resolve("."), "scripts/eval-verify-docling-macos-handoff.mjs"),
    ]);
    expect(result.bootstrap_sha256).toBe("9921055c8883627b062c4edfa8996c49ec37e6a7262374cdff27fc3ec7067b6f");
    expect(result.receipt.identity.recipe.setup.commands[0]).toEqual(["$UV", "python", "install", "--no-bin", "3.12.13"]);
    expect(result.receipt.setup.commands[0]).toEqual([result.receipt.toolchain.uv.path, "python", "install", "--no-bin", "3.12.13"]);
    expect(result.receipt.setup.environment.HF_HOME).toBe(result.receipt.roots.hf_cache);
    expect(result.receipt.execution.environment.HF_HOME).toBe(result.receipt.roots.hf_cache);
    expect(result.receipt.identity.recipe.setup.environment.HF_HOME).toBe("$HF_CACHE_ROOT");
    expect(result.receipt.setup.commands.at(-1).slice(-2)).toEqual(["--hf-cache-path", result.receipt.roots.hf_cache]);
    const unsafeHome = path.join(root, "unsafe-home-control");
    await fs.mkdir(unsafeHome, { mode: 0o700 });
    const unsafeCommand = result.receipt.setup.commands[0].filter(argument => argument !== "--no-bin");
    const unsafeInstall = spawnSync(unsafeCommand[0], unsafeCommand.slice(1), {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...result.receipt.setup.environment, HOME: unsafeHome }, cwd: result.receipt.roots.authority_tmp,
    });
    expect(unsafeInstall.status, unsafeInstall.stderr).toBe(0);
    expect((await fs.stat(path.join(unsafeHome, ".local/bin/python3.12"))).isFile()).toBe(true);
    const fakeInstall = spawnSync(result.receipt.setup.commands[0][0], result.receipt.setup.commands[0].slice(1), {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: result.receipt.setup.environment,
      cwd: result.receipt.roots.authority_tmp,
    });
    expect(fakeInstall.status, fakeInstall.stderr).toBe(0);
    expect(await fs.readdir(result.receipt.roots.authority_home)).toEqual([]);
    expect(await fs.readdir(result.receipt.roots.authority_tmp)).toEqual([]);
    expect(await fs.readdir(result.receipt.roots.hf_cache)).toEqual([]);
    expect(result.receipt.setup.commands.at(-1).slice(0, 3)).toEqual([path.join(result.receipt.roots.sidecar_snapshot, "venv/bin/python"), "-I", "-B"]);
    expect(result.receipt.execution.adapter_command.slice(0, 3)).toEqual([path.join(result.receipt.roots.sidecar_snapshot, "venv/bin/python"), "-I", "-B"]);
    expect(result.receipt.handoff_id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    const cleanVerify = runCleanVerify(result);
    expect(cleanVerify.status, cleanVerify.stderr).toBe(0);
    expect(JSON.parse(cleanVerify.stdout)).toMatchObject({ verified: true, handoff_id: result.receipt.handoff_id });
    const hostileParentVerify = runCleanVerify(result, { ...process.env, NODE_OPTIONS: "--no-warnings" });
    expect(hostileParentVerify.status, hostileParentVerify.stderr).toBe(0);
    const serialized = JSON.stringify({ inputs: result.receipt.inputs, fixtures: result.receipt.fixtures });
    for (const forbidden of ["ground_truth", "expected", "partition", "category", "fact_ids", "truth_boxes", "answer_state"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(result.receipt.fixtures).toEqual([
      expect.objectContaining({ ordinal: 1, filename: expect.stringMatching(/^source-001-[a-f0-9]{12}\.pdf$/), bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    expect(result.receipt.fixtures[0]).not.toHaveProperty("source_path");
    for (const [name, directory] of Object.entries(result.receipt.roots).filter(([name, value]) => name !== "models" && typeof value === "string" && value.startsWith(root))) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await fs.stat(result.receiptPath)).mode & 0o777).toBe(0o600);
    for (const retained of result.receipt.inputs) {
      const bytes = await fs.readFile(path.join(result.receipt.roots.sidecar_snapshot, retained.filename));
      expect(bytes.length).toBe(retained.bytes);
    }
  }, 10000);

  it("rejects omission or reordering of the receipt-bound --no-bin flag", async () => {
    for (const mutation of ["omit", "reorder"]) {
      const root = await temporaryRoot(`pdf-tools-docling-no-bin-${mutation}-`);
      const result = await prepareDoclingMacHandoffForTest(await options(root, [await fixture(root)]));
      const receipt = structuredClone(result.receipt);
      receipt.setup.commands[0] = mutation === "omit"
        ? [receipt.toolchain.uv.path, "python", "install", "3.12.13"]
        : [receipt.toolchain.uv.path, "python", "install", "3.12.13", "--no-bin"];
      const verification = runCleanVerify(await rewriteCanonicalReceipt(result, receipt));
      expect(verification.status).not.toBe(0);
      expect(verification.stderr).toMatch(/does not realize the retained authority recipe/i);
    }
  }, 10000);

  it("is content deterministic across distinct secure destinations", async () => {
    const firstRoot = await temporaryRoot("pdf-tools-docling-handoff-a-");
    const secondRoot = await temporaryRoot("pdf-tools-docling-handoff-b-");
    const firstFixture = await fixture(firstRoot);
    const secondFixture = await fixture(secondRoot);
    const [first, second] = await Promise.all([
      prepareDoclingMacHandoffForTest(await options(firstRoot, [firstFixture])),
      prepareDoclingMacHandoffForTest(await options(secondRoot, [secondFixture])),
    ]);
    expect(first.receipt.handoff_id).toBe(second.receipt.handoff_id);
    expect(first.receipt.fixtures).toEqual(second.receipt.fixtures);
    expect(first.receipt.inputs).toEqual(second.receipt.inputs);
  });

  it("rejects cache or sidecar destinations under protected sync roots", async () => {
    const root = await temporaryRoot("pdf-tools-docling-protected-");
    const source = await fixture(root);
    const unsafe = await options(root, [source]);
    unsafe.cacheRoot = path.join(root, "Documents/oda-pdf-tools-extraction");
    await expect(prepareDoclingMacHandoffForTest(unsafe)).rejects.toThrow(/outside Documents/);
  });

  it("rejects symbolic-link fixtures and weak existing destination modes", async () => {
    const root = await temporaryRoot("pdf-tools-docling-hostile-");
    const source = await fixture(root, "source.pdf");
    const linked = path.join(root, "linked.pdf");
    await fs.symlink(source, linked);
    await expect(prepareDoclingMacHandoffForTest(await options(root, [linked]))).rejects.toThrow(/symbolic link|ELOOP/);

    const weak = await options(root, [source]);
    await fs.mkdir(weak.cacheRoot, { recursive: true, mode: 0o755 });
    await fs.chmod(weak.cacheRoot, 0o755);
    await expect(prepareDoclingMacHandoffForTest(weak)).rejects.toThrow(/mode-0700/);
  });

  it("rejects wrong hosts, non-PDF inputs, hard links, and aggregate fixture overages", async () => {
    const root = await temporaryRoot("pdf-tools-docling-inputs-");
    const source = await fixture(root);
    await expect(prepareDoclingMacHandoffForTest({ ...(await options(root, [source])), testOnlyHost: { ...DARWIN_ARM64, platform: "linux", architecture: "x64" } })).rejects.toThrow(/darwin\/arm64/);
    await expect(prepareDoclingMacHandoff(await options(root, [source]))).rejects.toThrow(/does not accept injected/);

    const text = path.join(root, "fixture.txt");
    await fs.writeFile(text, "not a pdf", { mode: 0o600 });
    await expect(prepareDoclingMacHandoffForTest(await options(root, [text]))).rejects.toThrow(/only PDF/);

    const hard = path.join(root, "hard.pdf");
    await fs.link(source, hard);
    await expect(prepareDoclingMacHandoffForTest(await options(root, [hard]))).rejects.toThrow(/single-link/);

    const large = path.join(root, "large.pdf");
    await fs.writeFile(large, Buffer.alloc((8 * 1024 * 1024) + 1, 0x20), { mode: 0o600 });
    await expect(prepareDoclingMacHandoffForTest(await options(root, [large]))).rejects.toThrow(/bounded|8 MiB/);
  });

  it("rejects a receipt mutation against the out-of-band receipt digest", async () => {
    const receiptCase = await mutationCase("receipt");
    await fs.appendFile(receiptCase.result.receiptPath, " ");
    const receiptVerification = runCleanVerify(receiptCase.result);
    expect(receiptVerification.status).not.toBe(0);
    expect(receiptVerification.stderr).toMatch(/out-of-band/);
  });

  it("rejects a retained-input mutation against the out-of-band receipt digest", async () => {
    const inputCase = await mutationCase("input");
    const config = inputCase.result.receipt.inputs.find(item => item.role === "candidate_config");
    await fs.appendFile(path.join(inputCase.result.receipt.roots.sidecar_snapshot, config.filename), " ");
    const inputVerification = runCleanVerify(inputCase.result);
    expect(inputVerification.status).not.toBe(0);
    expect(inputVerification.stderr).toMatch(/input mismatch/i);
  });

  it("rejects mismatched authority bytes before executing them", async () => {
    const authorityCase = await mutationCase("authority");
    const authority = authorityCase.result.receipt.inputs.find(item => item.role === "handoff_authority");
    const authorityPath = path.join(authorityCase.result.receipt.roots.sidecar_snapshot, authority.filename);
    const executionMarker = path.join(authorityCase.root, "mutated-authority-executed");
    await fs.writeFile(authorityPath, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(executionMarker)}, "executed");\n`, { mode: 0o600 });
    const authorityVerification = runCleanVerify(authorityCase.result);
    expect(authorityVerification.status).not.toBe(0);
    expect(authorityVerification.stderr).toMatch(/before execution/);
    await expect(fs.stat(executionMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mutated launcher CLI in a fresh process before any mutation executes", async () => {
    const mutation = await bootstrapMutationCase("cli");
    const marker = path.join(mutation.root, "mutated-cli-executed");
    await fs.writeFile(mutation.cliPath, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
    const verification = runCleanVerify(mutation.result);
    expect(verification.status).not.toBe(0);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mutated launcher module in a fresh process before any mutation executes", async () => {
    const mutation = await bootstrapMutationCase("module");
    const marker = path.join(mutation.root, "mutated-module-executed");
    await fs.writeFile(mutation.verifierPath, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, "executed");\nexport const runDoclingAuthority = null;\n`);
    const verification = runCleanVerify(mutation.result);
    expect(verification.status).not.toBe(0);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a retained fixture mutation", async () => {
    const fixtureCase = await mutationCase("fixture");
    const retainedFixture = fixtureCase.result.receipt.fixtures[0];
    await fs.appendFile(path.join(path.dirname(fixtureCase.result.receiptPath), "fixtures", retainedFixture.filename), " ");
    const fixtureVerification = runCleanVerify(fixtureCase.result);
    expect(fixtureVerification.status).not.toBe(0);
    expect(fixtureVerification.stderr).toMatch(/fixture mismatch/i);
  });

  it("rejects a uv mutation", async () => {
    const uvCase = await mutationCase("uv");
    await fs.appendFile(uvCase.result.receipt.toolchain.uv.path, "mutated");
    const uvVerification = runCleanVerify(uvCase.result);
    expect(uvVerification.status).not.toBe(0);
    expect(uvVerification.stderr).toMatch(/uv binary/i);
  });

  it("rejects an unbound snapshot entry", async () => {
    const snapshotCase = await mutationCase("snapshot-extra");
    await fs.writeFile(path.join(snapshotCase.result.receipt.roots.sidecar_snapshot, "unbound.py"), "raise SystemExit(0)\n", { mode: 0o600 });
    const snapshotVerification = runCleanVerify(snapshotCase.result);
    expect(snapshotVerification.status).not.toBe(0);
    expect(snapshotVerification.stderr).toMatch(/unbound top-level entry/i);
  });

  it("rejects a nonempty authority isolation root", async () => {
    const isolationCase = await mutationCase("isolation-root");
    await fs.writeFile(path.join(isolationCase.result.receipt.roots.authority_home, "usercustomize.py"), "raise SystemExit(0)\n", { mode: 0o600 });
    const isolationVerification = runCleanVerify(isolationCase.result);
    expect(isolationVerification.status).not.toBe(0);
    expect(isolationVerification.stderr).toMatch(/must remain empty/i);
  });

  it("rejects a nonempty receipt-bound HF cache", async () => {
    const cacheCase = await mutationCase("hf-cache-isolation-root");
    await fs.writeFile(path.join(cacheCase.result.receipt.roots.hf_cache, "xet.log"), "transient\n", { mode: 0o600 });
    const cacheVerification = runCleanVerify(cacheCase.result);
    expect(cacheVerification.status).not.toBe(0);
    expect(cacheVerification.stderr).toMatch(/must remain empty/i);
  }, 10000);

  it("rejects post-handoff root substitution into protected storage", async () => {
    const root = await temporaryRoot("pdf-tools-docling-root-substitution-");
    const result = await prepareDoclingMacHandoffForTest(await options(root, [await fixture(root)]));
    const protectedTarget = path.join(root, "Dropbox/model-target");
    await fs.mkdir(protectedTarget, { recursive: true, mode: 0o700 });
    await fs.symlink(protectedTarget, result.receipt.roots.models);
    const verification = runCleanVerify(result);
    expect(verification.status).not.toBe(0);
    expect(verification.stderr).toMatch(/symbolic link|real path|protected storage/i);
  });

  it("rejects post-handoff HF cache substitution", async () => {
    const root = await temporaryRoot("pdf-tools-docling-hf-cache-substitution-");
    const result = await prepareDoclingMacHandoffForTest(await options(root, [await fixture(root)]));
    const protectedTarget = path.join(root, "Dropbox/hf-cache-target");
    await fs.mkdir(protectedTarget, { recursive: true, mode: 0o700 });
    await fs.rm(result.receipt.roots.hf_cache, { recursive: true });
    await fs.symlink(protectedTarget, result.receipt.roots.hf_cache);
    const verification = runCleanVerify(result);
    expect(verification.status).not.toBe(0);
    expect(verification.stderr).toMatch(/symbolic link|real path|protected storage/i);
  });
});
