import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { pathToFileURL } from "url";
import { spawnSync } from "child_process";
import {
  activateCanonicalCandidateAtomic,
  assertSafeArchivePath,
  buildExpectedFileManifest,
  canonicalZipMtime,
  createCanonicalZip,
  readCentralDirectory,
  sha256Bytes,
  verifyCanonicalZip,
  writeCanonicalBytesAtomic,
} from "../scripts/mcpb-archive.mjs";
import {
  assertRegularFirstPartyFile,
  trimStagedProductionGraph,
  verifyLockedTooling,
} from "../scripts/build-mcpb.mjs";

const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "pdf-tools-mcpb-test-"));
  temporaryRoots.push(root);
  return root;
}

function fixtureStage() {
  const root = temporaryRoot();
  mkdirSync(path.join(root, "server"), { recursive: true });
  writeFileSync(path.join(root, "manifest.json"), "{\"manifest_version\":\"0.3\"}\n");
  writeFileSync(path.join(root, "server", "index.js"), "console.log('test');\n");
  chmodSync(path.join(root, "server", "index.js"), 0o777);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical MCPB archive", () => {
  it("is byte-identical with sorted paths, fixed timestamps, normalized modes, and no extras", () => {
    const stage = fixtureStage();
    const expected = buildExpectedFileManifest(stage);
    const first = createCanonicalZip(expected);
    const second = createCanonicalZip(expected);

    expect(sha256Bytes(first)).toBe(sha256Bytes(second));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(() => verifyCanonicalZip(first, expected)).not.toThrow();
    const entries = readCentralDirectory(first);
    expect(entries.map(entry => entry.path)).toEqual(["manifest.json", "server/index.js"]);
    expect(entries.every(entry => entry.os === 3 && entry.unixMode === 0o100644 && entry.mode === 0o644)).toBe(true);
    expect(entries.every(entry => entry.extraLength === 0 && entry.commentLength === 0)).toBe(true);
    expect(new Set(entries.map(entry => `${entry.dosDate}:${entry.dosTime}`)).size).toBe(1);
  });

  it("always uses the representable 1980 DOS epoch and ignores ambient build epochs", () => {
    const epoch = canonicalZipMtime();
    expect(epoch.getFullYear()).toBe(1980);
    expect(epoch.getMonth()).toBe(0);
    expect(epoch.getDate()).toBe(1);
    expect(epoch.getHours()).toBe(0);
    expect(epoch.getMinutes()).toBe(0);
  });

  it("is byte-identical across UTC and DST-observing timezones", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts/mcpb-archive.mjs")).href;
    const script = `
      import { createHash } from "crypto";
      import { createCanonicalZip, sha256Bytes } from ${JSON.stringify(moduleUrl)};
      const bytes = Buffer.from("timezone invariant");
      const files = [{ path: "fixture.txt", bytes, size: bytes.length, sha256: sha256Bytes(bytes), mode: 420 }];
      process.stdout.write(createHash("sha256").update(createCanonicalZip(files)).digest("hex"));
    `;
    const hashes = [
      ["UTC", "0"],
      ["America/New_York", "1710037800"],
      ["America/Los_Angeles", "1760000001"],
    ].map(([TZ, SOURCE_DATE_EPOCH]) => {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
        env: { ...process.env, TZ, SOURCE_DATE_EPOCH },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    });
    expect(new Set(hashes).size).toBe(1);
  });

  it("rejects local-header timestamp tampering, EOCD comments, and trailing bytes", () => {
    const stage = fixtureStage();
    const expected = buildExpectedFileManifest(stage);
    const canonical = Buffer.from(createCanonicalZip(expected));
    const localTimestamp = Buffer.from(canonical);
    localTimestamp[10] ^= 1;
    expect(() => verifyCanonicalZip(localTimestamp, expected)).toThrow(/exactly match/);

    const eocdOffset = canonical.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const commented = Buffer.concat([canonical, Buffer.from("x")]);
    commented.writeUInt16LE(1, eocdOffset + 20);
    expect(() => verifyCanonicalZip(commented, expected)).toThrow(/exactly match/);
    expect(() => verifyCanonicalZip(Buffer.concat([canonical, Buffer.from("trailing")]), expected)).toThrow(/exactly match/);
  });

  it("rejects traversal, absolute, Windows, duplicate, and symbolic-link inputs", () => {
    for (const unsafe of ["../secret", "/absolute", "C:/windows", "a\\b", "a//b", "./a"]) {
      expect(() => assertSafeArchivePath(unsafe)).toThrow(/archive path|canonical/i);
    }
    const stage = fixtureStage();
    symlinkSync(path.join(stage, "manifest.json"), path.join(stage, "linked-secret"));
    expect(() => buildExpectedFileManifest(stage)).toThrow(/symbolic link/);
    expect(() => assertRegularFirstPartyFile(stage, "linked-secret")).toThrow(/regular file/);
    const bytes = Buffer.from("same");
    expect(() => createCanonicalZip([
      { path: "same", bytes, size: bytes.length, sha256: sha256Bytes(bytes), mode: 0o644 },
      { path: "same", bytes, size: bytes.length, sha256: sha256Bytes(bytes), mode: 0o644 },
    ])).toThrow(/Duplicate archive path/);

    if (process.platform !== "win32") {
      rmSync(path.join(stage, "linked-secret"));
      const fifo = path.join(stage, "named-pipe");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      expect(created.status, created.stderr).toBe(0);
      expect(() => buildExpectedFileManifest(stage)).toThrow(/non-regular/);
    }
  });

  it("applies PDF.js exclusions without removing the legacy build runtime", () => {
    const stage = temporaryRoot();
    const pdfjs = path.join(stage, "node_modules", "pdfjs-dist");
    for (const directory of ["build", "web", "types", "image_decoders", "cmaps", "wasm", "legacy/build"]) {
      mkdirSync(path.join(pdfjs, directory), { recursive: true });
      writeFileSync(path.join(pdfjs, directory, "fixture"), directory);
    }
    mkdirSync(path.join(stage, "node_modules"), { recursive: true });
    mkdirSync(path.join(stage, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(stage, "node_modules", ".bin", "unused-cli"), "shim");
    writeFileSync(path.join(stage, "node_modules", "types.d.ts"), "type Fixture = string;");
    writeFileSync(path.join(stage, "node_modules", "runtime.js.map"), "{}");
    writeFileSync(path.join(stage, "package-lock.json"), "root lock");
    writeFileSync(path.join(stage, "node_modules", ".package-lock.json"), "install lock");
    trimStagedProductionGraph(stage);
    expect(readFileSync(path.join(pdfjs, "legacy", "build", "fixture"), "utf8")).toBe("legacy/build");
    for (const directory of ["build", "web", "types", "image_decoders", "cmaps", "wasm"]) {
      expect(() => readFileSync(path.join(pdfjs, directory, "fixture"))).toThrow();
    }
    expect(() => readFileSync(path.join(stage, "package-lock.json"))).toThrow();
    expect(() => readFileSync(path.join(stage, "node_modules", ".bin", "unused-cli"))).toThrow();
    expect(() => readFileSync(path.join(stage, "node_modules", "types.d.ts"))).toThrow();
    expect(() => readFileSync(path.join(stage, "node_modules", "runtime.js.map"))).toThrow();
  });

  it("preserves the previous artifact when candidate verification or activation fails", () => {
    const stage = fixtureStage();
    const expected = buildExpectedFileManifest(stage);
    const bytes = createCanonicalZip(expected);
    const output = path.join(temporaryRoot(), "pdf-toolkit-mcp.mcpb");
    writeFileSync(output, "known-good");

    expect(() => writeCanonicalBytesAtomic({
      bytes,
      expectedFiles: expected,
      outputPath: output,
      beforeRename() {
        throw new Error("forced activation failure");
      },
    })).toThrow(/forced activation failure/);
    expect(readFileSync(output, "utf8")).toBe("known-good");
  });

  it("makes fsync and rename failures fail closed while cleaning candidates", () => {
    const stage = fixtureStage();
    const expected = buildExpectedFileManifest(stage);
    const bytes = createCanonicalZip(expected);
    const outputRoot = temporaryRoot();
    const output = path.join(outputRoot, "pdf-toolkit-mcp.mcpb");
    const candidates = () => readdirSync(outputRoot).filter(name => name.includes(".candidate-"));

    for (const operations of [
      { fileFsync() { const error = new Error("file fsync failed"); error.code = "EIO"; throw error; } },
      { directoryFsync() { const error = new Error("directory fsync failed"); error.code = "EIO"; throw error; } },
      { rename() { const error = new Error("rename failed"); error.code = "EACCES"; throw error; } },
    ]) {
      writeFileSync(output, "known-good");
      expect(() => writeCanonicalBytesAtomic({ bytes, expectedFiles: expected, outputPath: output, operations })).toThrow();
      expect(readFileSync(output, "utf8")).toBe("known-good");
      expect(candidates()).toEqual([]);
    }

    let directoryFsyncCalls = 0;
    const result = writeCanonicalBytesAtomic({
      bytes,
      expectedFiles: expected,
      outputPath: output,
      operations: { directoryFsync() { directoryFsyncCalls += 1; } },
    });
    expect(result.sha256).toBe(sha256Bytes(bytes));
    expect(directoryFsyncCalls).toBe(2);
    expect(statSync(output).mode & 0o777).toBe(0o644);
    expect(candidates()).toEqual([]);

    const unsupportedCandidate = path.join(outputRoot, "unsupported.mcpb");
    writeFileSync(unsupportedCandidate, bytes);
    expect(() => activateCanonicalCandidateAtomic({
      candidatePath: unsupportedCandidate,
      outputPath: output,
      operations: {
        directoryFsync() { const error = new Error("unsupported"); error.code = "ENOTSUP"; throw error; },
      },
    })).not.toThrow();
    expect(readFileSync(output).equals(Buffer.from(bytes))).toBe(true);

    const failedCandidate = path.join(outputRoot, "rename-failure.mcpb");
    writeFileSync(failedCandidate, bytes);
    writeFileSync(output, "known-good");
    expect(() => activateCanonicalCandidateAtomic({
      candidatePath: failedCandidate,
      outputPath: output,
      operations: {
        rename() { const error = new Error("rename failed"); error.code = "EACCES"; throw error; },
      },
    })).toThrow(/rename failed/);
    expect(readFileSync(output, "utf8")).toBe("known-good");
    expect(() => statSync(failedCandidate)).toThrow();
  });

  it("fails closed when the installed canonical tooling drifts from the lock", () => {
    const root = temporaryRoot();
    mkdirSync(path.join(root, "node_modules", "@anthropic-ai", "mcpb"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "fflate"), { recursive: true });
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {
      "": { dependencies: { "pdfjs-dist": "5.4.624" } },
      "node_modules/@anthropic-ai/mcpb": { version: "2.1.2" },
      "node_modules/fflate": { version: "0.8.3" },
    } }));
    writeFileSync(path.join(root, "node_modules", "@anthropic-ai", "mcpb", "package.json"), JSON.stringify({
      version: "2.1.2",
      dependencies: { fflate: "^0.8.2" },
    }));
    const fflatePackage = path.join(root, "node_modules", "fflate", "package.json");
    writeFileSync(fflatePackage, JSON.stringify({ version: "0.8.3" }));
    expect(() => verifyLockedTooling(root)).not.toThrow();
    writeFileSync(fflatePackage, JSON.stringify({ version: "0.8.4" }));
    expect(() => verifyLockedTooling(root)).toThrow(/fflate@0\.8\.3/);
  });
});
