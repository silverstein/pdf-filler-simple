import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recipeDir = path.join(repoRoot, "vendor", "qpdf-wasm");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(recipeDir, relativePath), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("ODA QPDF WASM recipe", () => {
  it("pins stable source archives and the amd64 Emscripten image by digest", async () => {
    const lock = await readJson("sources.lock.json");
    expect(lock.toolchain).toMatchObject({
      version: "6.0.3",
      platform: "linux/amd64",
      digest: "sha256:2a7a41cd7e2065b30ba389c8db0fbeaebd7ec06bb4e20f23cab8ba92180f25c7",
    });
    expect(lock.sources.map(({ name, version, sha256: hash }) => ({ name, version, hash }))).toEqual([
      {
        name: "qpdf",
        version: "12.3.2",
        hash: "6cba2f9f2cd887d905faeb99e0e51a307b217920d1bbf3e9cfbb2e8178a2deda",
      },
      {
        name: "zlib",
        version: "1.3.2",
        hash: "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
      },
      {
        name: "libjpeg-turbo",
        version: "3.2.0",
        hash: "6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e",
      },
    ]);
    for (const source of lock.sources) {
      expect(source.url).toMatch(/^https:\/\/github\.com\//);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("tracks and hash-binds every required runtime notice", async () => {
    const manifest = await readJson(path.join("licenses", "manifest.json"));
    const components = manifest.files.map((entry) => entry.component);
    for (const expected of [
      "qpdf 12.3.2",
      "zlib 1.3.2",
      "libjpeg-turbo 3.2.0",
      "Emscripten 6.0.3 generated runtime",
      "musl bundled by Emscripten 6.0.3",
      "compiler-rt bundled by Emscripten 6.0.3",
      "libc++ bundled by Emscripten 6.0.3",
      "libc++abi bundled by Emscripten 6.0.3",
    ]) {
      expect(components).toContain(expected);
    }

    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(recipeDir, "licenses", entry.file));
      expect(bytes.byteLength).toBeGreaterThan(100);
      expect(sha256(bytes)).toBe(entry.sha256);
    }
  });

  it("keeps the build hermetic and the runtime boundary out of production", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const dockerfile = await readFile(path.join(recipeDir, "Dockerfile"), "utf8");
    const build = await readFile(path.join(recipeDir, "build.sh"), "utf8");
    const fetcher = await readFile(path.join(recipeDir, "fetch-sources.mjs"), "utf8");

    expect(packageJson.dependencies["pdfjs-dist"]).toBe("5.4.624");
    expect(packageJson.dependencies).not.toHaveProperty("@neslinesli93/qpdf-wasm");
    expect(dockerfile).toContain("emscripten/emsdk@sha256:2a7a41cd7e2065b30ba389c8db0fbeaebd7ec06bb4e20f23cab8ba92180f25c7");
    expect(dockerfile).not.toContain("apt-get");
    expect(build).toContain("-DREQUIRE_CRYPTO_NATIVE=ON");
    expect(build).toContain("-DUSE_IMPLICIT_CRYPTO=OFF");
    expect(build).not.toContain("USE_INSECURE_RANDOM=ON");
    expect(fetcher).toContain("SHA-256 mismatch");

    const trackedRecipeFiles = await readdir(recipeDir);
    expect(trackedRecipeFiles).not.toContain("node_modules");
    expect(trackedRecipeFiles).not.toContain("dist");
  });

  it("pins the independently reproduced output contract", async () => {
    const expected = await readJson("expected-output.json");
    expect(expected.artifacts).toEqual({
      "qpdf.mjs": {
        bytes: 34382,
        sha256: "0c087b0d6ed0b57dd24a8b82e081207809dd97edff618d753c39a5639dcdc7c3",
      },
      "qpdf.wasm": {
        bytes: 2450542,
        sha256: "36830fb93e3f8a8a9bf4e8352b8b9b5f9ef1a25702b2eeaae0b52ab0b6746e6f",
      },
    });
  });
});
