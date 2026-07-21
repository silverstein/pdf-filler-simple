import { existsSync, readFileSync } from "fs";
import path from "path";

export const BUILD_TOOLCHAIN_PACKAGES = [
  "@anthropic-ai/mcpb",
  "vite",
  "vite-plugin-singlefile",
];

export function verifyInstalledBuildToolchain(repoRoot, packageNames = BUILD_TOOLCHAIN_PACKAGES) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const lockedRoot = lock.packages?.[""];

  for (const packageName of packageNames) {
    const declared = packageJson.devDependencies?.[packageName];
    const lockedDeclaration = lockedRoot?.devDependencies?.[packageName];
    const locked = lock.packages?.[`node_modules/${packageName}`]?.version;
    const installedPath = path.join(repoRoot, "node_modules", ...packageName.split("/"), "package.json");

    if (!declared || declared !== lockedDeclaration || !locked) {
      throw new Error(`Build toolchain lock is incomplete or stale for ${packageName}`);
    }
    if (!existsSync(installedPath)) {
      throw new Error(`Build toolchain package is not installed: ${packageName}. Run npm ci.`);
    }

    const installed = JSON.parse(readFileSync(installedPath, "utf8")).version;
    if (installed !== locked) {
      throw new Error(
        `Installed ${packageName}@${installed} does not match package-lock.json ${locked}. Run npm ci before building.`,
      );
    }
  }
}
