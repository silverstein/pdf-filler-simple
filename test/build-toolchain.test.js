import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { verifyInstalledBuildToolchain } from "../scripts/build-toolchain.mjs";

const temporaryDirectories = [];

async function toolchainFixture({ declared = "^8.1.5", locked = "8.1.5", installed = "8.1.5" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pdf-tools-build-toolchain-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "node_modules", "vite"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { vite: declared } }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    packages: {
      "": { devDependencies: { vite: declared } },
      "node_modules/vite": { version: locked },
    },
  }));
  await writeFile(path.join(root, "node_modules", "vite", "package.json"), JSON.stringify({ version: installed }));
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("MCPB build toolchain preflight", () => {
  it("accepts an installed build tool that exactly matches the lock", async () => {
    const root = await toolchainFixture();
    expect(() => verifyInstalledBuildToolchain(root, ["vite"])).not.toThrow();
  });

  it("rejects a stale installed build tool before rebuilding the artifact", async () => {
    const root = await toolchainFixture({ installed: "8.0.9" });
    expect(() => verifyInstalledBuildToolchain(root, ["vite"])).toThrow(
      "Installed vite@8.0.9 does not match package-lock.json 8.1.5. Run npm ci before building.",
    );
  });

  it("rejects package and lock declarations that drift apart", async () => {
    const root = await toolchainFixture();
    const packageJson = path.join(root, "package.json");
    await writeFile(packageJson, JSON.stringify({ devDependencies: { vite: "^8.0.9" } }));
    expect(() => verifyInstalledBuildToolchain(root, ["vite"])).toThrow(
      "Build toolchain lock is incomplete or stale for vite",
    );
  });
});
