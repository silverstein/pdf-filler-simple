/**
 * The developer-inner-loop half of the QPDF WebAssembly reproducibility gate.
 *
 * The authoritative gate is `npm run qpdf-wasm:verify`, which rebuilds the
 * runtime twice from pinned sources in a pinned container with networking
 * disabled and requires both results to be byte-identical to
 * `vendor/qpdf-wasm/expected-output.json`. It needs Docker and takes roughly
 * 45 minutes under x86-64 emulation on Apple Silicon, so it is a release and
 * nightly step and must never join `npm test`.
 *
 * What runs here instead is the cheap binding that makes that slow gate mean
 * something day to day: the committed bytes are pinned to the same
 * `expected-output.json` contract, to the pinned source hashes and toolchain
 * digest in `sources.lock.json`, and to the notice manifest — and the
 * committed module is actually instantiated and made to decrypt a PDF. A
 * shipped artifact that is present but not loadable is the failure this suite
 * exists to catch.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  QPDF_WASM_RUNTIME_ASSETS,
  QPDF_WASM_RUNTIME_BINARY,
  QPDF_WASM_RUNTIME_DIRECTORY,
  QPDF_WASM_RUNTIME_ENTRY_POINT,
  QPDF_WASM_RUNTIME_FILES,
  QPDF_WASM_RUNTIME_PROVENANCE,
  QPDF_WASM_RUNTIME_PROVENANCE_PATH,
  readQpdfWasmRuntimeInventory,
  verifyQpdfWasmRuntime,
} from "../scripts/qpdf-wasm-runtime.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECIPE_DIR = path.join(REPO_ROOT, "vendor", "qpdf-wasm");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalLfSha256(bytes) {
  return sha256(Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n?/g, "\n"), "utf8"));
}

async function readRecipeJson(filename) {
  return JSON.parse(await fs.readFile(path.join(RECIPE_DIR, filename), "utf8"));
}

const expectedOutput = await readRecipeJson("expected-output.json");
const sourcesLock = await readRecipeJson("sources.lock.json");
const licenseManifest = JSON.parse(
  await fs.readFile(path.join(RECIPE_DIR, "licenses", "manifest.json"), "utf8"),
);

describe("committed qpdf-wasm runtime", () => {
  it("reproduces the expected-output.json artifact contract byte for byte", async () => {
    const contractNames = Object.keys(expectedOutput.artifacts);
    expect(contractNames.sort()).toEqual(["qpdf.mjs", "qpdf.wasm"]);
    for (const [filename, contract] of Object.entries(expectedOutput.artifacts)) {
      const bytes = await fs.readFile(
        path.join(REPO_ROOT, ...QPDF_WASM_RUNTIME_DIRECTORY.split("/"), filename),
      );
      // Derived from the bytes on disk, then compared to the contract. The
      // contract is never restated from the provenance, which is generated
      // from the same bytes and would agree with itself either way.
      expect(bytes.length, `${filename} size`).toBe(contract.bytes);
      expect(sha256(bytes), `${filename} sha256`).toBe(contract.sha256);
    }
  });

  it("is exactly the inventory the provenance records, with nothing added or missing", () => {
    const inventory = verifyQpdfWasmRuntime(REPO_ROOT, "checkout");
    expect(inventory.map(asset => asset.path)).toEqual([...QPDF_WASM_RUNTIME_FILES].sort());
    expect(inventory.length).toBe(QPDF_WASM_RUNTIME_ASSETS.length);
    expect(QPDF_WASM_RUNTIME_FILES).toContain(QPDF_WASM_RUNTIME_ENTRY_POINT);
    expect(QPDF_WASM_RUNTIME_FILES).toContain(QPDF_WASM_RUNTIME_BINARY);
  });

  it("rejects a runtime tree that is short a file", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-qpdf-wasm-"));
    try {
      for (const relativePath of QPDF_WASM_RUNTIME_FILES.slice(0, -1)) {
        const target = path.join(scratch, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(REPO_ROOT, ...relativePath.split("/")), target);
      }
      expect(() => verifyQpdfWasmRuntime(scratch, "scratch")).toThrow(/is missing/);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a runtime tree whose bytes drifted", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-qpdf-wasm-"));
    try {
      for (const relativePath of QPDF_WASM_RUNTIME_FILES) {
        const target = path.join(scratch, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(REPO_ROOT, ...relativePath.split("/")), target);
      }
      const binary = path.join(scratch, ...QPDF_WASM_RUNTIME_BINARY.split("/"));
      const bytes = await fs.readFile(binary);
      bytes[bytes.length - 1] ^= 0xff;
      await fs.writeFile(binary, bytes);
      expect(() => verifyQpdfWasmRuntime(scratch, "scratch")).toThrow(/drifted at/);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a runtime tree carrying an unreviewed extra file", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-qpdf-wasm-"));
    try {
      for (const relativePath of QPDF_WASM_RUNTIME_FILES) {
        const target = path.join(scratch, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(REPO_ROOT, ...relativePath.split("/")), target);
      }
      await fs.writeFile(
        path.join(scratch, ...QPDF_WASM_RUNTIME_DIRECTORY.split("/"), "smuggled.mjs"),
        "export default 1;\n",
      );
      expect(() => verifyQpdfWasmRuntime(scratch, "scratch")).toThrow(/unreviewed files/);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("qpdf-wasm runtime provenance", () => {
  it("records the pinned source hashes and the Emscripten image digest", () => {
    expect(QPDF_WASM_RUNTIME_PROVENANCE.build.toolchain).toMatchObject({
      name: sourcesLock.toolchain.name,
      version: sourcesLock.toolchain.version,
      platform: sourcesLock.toolchain.platform,
      image: sourcesLock.toolchain.image,
      digest: sourcesLock.toolchain.digest,
    });
    expect(QPDF_WASM_RUNTIME_PROVENANCE.build.source_date_epoch).toBe(sourcesLock.source_date_epoch);
    expect(QPDF_WASM_RUNTIME_PROVENANCE.build.sources.map(source => ({
      name: source.name,
      version: source.version,
      sha256: source.sha256,
    }))).toEqual(sourcesLock.sources.map(source => ({
      name: source.name,
      version: source.version,
      sha256: source.sha256,
    })));
    // The pinned set itself, so silently dropping a source from the lock and
    // from the provenance together still fails.
    expect(sourcesLock.sources.map(source => `${source.name} ${source.version}`)).toEqual([
      "qpdf 12.3.2",
      "zlib 1.3.2",
      "libjpeg-turbo 3.2.0",
    ]);
  });

  it("records the artifact hashes the expected-output contract pins", async () => {
    expect(QPDF_WASM_RUNTIME_PROVENANCE.expected_output_contract.artifacts).toEqual(expectedOutput.artifacts);
    expect(QPDF_WASM_RUNTIME_PROVENANCE.expected_output_contract.sha256).toBe(
      sha256(await fs.readFile(path.join(RECIPE_DIR, "expected-output.json"))),
    );
  });

  it("names both reproduction paths and keeps the slow one out of npm test", async () => {
    const { release_gate: release, developer_gate: developer } = QPDF_WASM_RUNTIME_PROVENANCE.reproduction;
    expect(release.command).toBe("npm run qpdf-wasm:verify");
    expect(release.cadence).toMatch(/Deliberately excluded from `npm test`/);
    expect(developer.command).toContain("test/qpdf-wasm-runtime-artifact.test.js");

    const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(packageJson.scripts["qpdf-wasm:verify"]).toBeTruthy();
    // The 45-minute Docker rebuild must not be reachable from `npm test` or
    // from the aggregate that release qualification runs.
    expect(packageJson.scripts.test).not.toMatch(/qpdf-wasm/);
    expect(packageJson.scripts.pretest || "").not.toMatch(/qpdf-wasm/);
    for (const script of ["test:all", "test:node-native", "test:concurrent"]) {
      const command = packageJson.scripts[script];
      const source = await fs.readFile(path.join(REPO_ROOT, command.replace(/^node\s+/, "")), "utf8");
      expect(source, `${script} must not invoke the Docker rebuild`).not.toMatch(/qpdf-wasm:verify/);
    }
  });

  it("is regenerable rather than hand-edited", async () => {
    const generatorPath = path.join(REPO_ROOT, QPDF_WASM_RUNTIME_PROVENANCE.generator.path);
    expect(QPDF_WASM_RUNTIME_PROVENANCE.generator.sha256).toBe(
      canonicalLfSha256(await fs.readFile(generatorPath)),
    );
    expect(QPDF_WASM_RUNTIME_PROVENANCE_PATH).toBe("vendor/qpdf-wasm/runtime.provenance.json");
  });

  it("does not claim the runtime is wired into any tool", async () => {
    expect(QPDF_WASM_RUNTIME_PROVENANCE.integration_status).toMatch(/No PDF Tools tool loads/);
    /*
     * `server/` already names qpdf in prose, telling a user to decrypt an
     * encrypted file externally before retrying. What must stay absent is any
     * reference to the packaged runtime itself: this phase ships the artifact
     * and nothing more, so the moment a server module reaches for it the
     * provenance claim above stops being true.
     */
    for (const filename of await fs.readdir(path.join(REPO_ROOT, "server"))) {
      const source = await fs.readFile(path.join(REPO_ROOT, "server", filename), "utf8");
      for (const forbidden of ["qpdf-wasm", "qpdf.mjs", "qpdf.wasm", QPDF_WASM_RUNTIME_DIRECTORY]) {
        expect(source, `server/${filename} reaches for the unintegrated qpdf runtime`)
          .not.toContain(forbidden);
      }
    }
  });
});

describe("qpdf-wasm runtime notices", () => {
  it("ships every notice the recipe manifest binds, byte-identical to the recipe copy", async () => {
    const shipped = new Set(QPDF_WASM_RUNTIME_FILES);
    for (const entry of licenseManifest.files) {
      const relativePath = `${QPDF_WASM_RUNTIME_DIRECTORY}/licenses/${entry.file}`;
      expect(shipped, `${entry.file} is not shipped`).toContain(relativePath);
      const bytes = await fs.readFile(path.join(REPO_ROOT, ...relativePath.split("/")));
      expect(canonicalLfSha256(bytes), `${entry.file} does not match its manifest hash`).toBe(entry.sha256);
      expect(bytes, `${entry.file} drifted from the recipe copy`).toEqual(
        await fs.readFile(path.join(RECIPE_DIR, "licenses", entry.file)),
      );
    }
    expect(shipped).toContain(`${QPDF_WASM_RUNTIME_DIRECTORY}/licenses/manifest.json`);
  });

  it("covers qpdf and every statically linked component", () => {
    expect(licenseManifest.files.map(entry => entry.component).sort()).toEqual([
      "Emscripten 6.0.3 generated runtime",
      "compiler-rt bundled by Emscripten 6.0.3",
      "libc++ bundled by Emscripten 6.0.3",
      "libc++abi bundled by Emscripten 6.0.3",
      "libjpeg-turbo 3.2.0",
      "libunwind bundled by Emscripten 6.0.3",
      "musl bundled by Emscripten 6.0.3",
      "qpdf 12.3.2",
      "qpdf 12.3.2 bundled-code notices",
      "zlib 1.3.2",
    ]);
    expect(licenseManifest.files.find(entry => entry.component === "qpdf 12.3.2").spdx).toBe("Apache-2.0");
  });
});

describe("committed qpdf-wasm runtime execution", () => {
  /*
   * Loaded through the recipe's own smoke in a child process. Emscripten's
   * generated ESM resolves its `.wasm` sibling relative to `import.meta.url`
   * and expects a plain Node loader, so running it out of process both keeps
   * Vite's transform pipeline out of the way and exercises the same load path
   * a host would use. The whole run is well under a second.
   */
  it("instantiates from the committed tree and completes an encrypt/decrypt round trip", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(RECIPE_DIR, "smoke.mjs"),
        path.join(REPO_ROOT, ...QPDF_WASM_RUNTIME_DIRECTORY.split("/")),
        path.join(REPO_ROOT, "example-fw9.pdf"),
      ],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout);
    expect(evidence).toMatchObject({
      qpdf_version: "12.3.2",
      version_status: 0,
      encrypt_status: 0,
      decrypt_status: 0,
      check_status: 0,
      wrong_password_created_output: false,
    });
    // A wrong password must fail rather than silently produce a file.
    expect(evidence.wrong_password_status).not.toBe(0);
    expect(evidence.decrypted_bytes).toBeGreaterThan(1000);
  }, 30000);

  it("reads the same inventory back out of the runtime directory it loaded from", () => {
    const inventory = readQpdfWasmRuntimeInventory(REPO_ROOT);
    const entry = inventory.find(asset => asset.path === QPDF_WASM_RUNTIME_ENTRY_POINT);
    const binary = inventory.find(asset => asset.path === QPDF_WASM_RUNTIME_BINARY);
    expect(entry.sha256).toBe(expectedOutput.artifacts["qpdf.mjs"].sha256);
    expect(binary.sha256).toBe(expectedOutput.artifacts["qpdf.wasm"].sha256);
  });
});
