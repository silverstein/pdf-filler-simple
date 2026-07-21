import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import {
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

  it("clamps old SOURCE_DATE_EPOCH values to 1980 and rounds to ZIP's two-second precision", () => {
    const epoch = canonicalZipMtime("0");
    expect(epoch.getFullYear()).toBe(1980);
    expect(epoch.getMonth()).toBe(0);
    expect(epoch.getDate()).toBe(1);
    expect(canonicalZipMtime("1760000001").getSeconds() % 2).toBe(0);
    expect(() => canonicalZipMtime("not-a-number")).toThrow(/non-negative integer/);
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
});
