import { existsSync, readFileSync } from "fs";
import path from "path";

export const BUILD_TOOLCHAIN_PACKAGES = [
  "@anthropic-ai/mcpb",
  "vite",
  "vite-plugin-singlefile",
];

export const SUPPORTED_BUILD_NODE_RANGE = "^20.19.0 || >=22.12.0";

export function verifyBuildNodeVersion(
  version = process.versions.node,
  declaredRange = SUPPORTED_BUILD_NODE_RANGE,
) {
  if (declaredRange !== SUPPORTED_BUILD_NODE_RANGE) {
    throw new Error(
      `package.json engines.node must remain ${SUPPORTED_BUILD_NODE_RANGE}; found ${declaredRange ?? "missing"}`,
    );
  }

  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const supported = (major === 20 && minor >= 19) ||
    (major === 22 && minor >= 12) ||
    major > 22;

  if (!match || !supported) {
    throw new Error(
      `PDF Tools build/test requires Node ${SUPPORTED_BUILD_NODE_RANGE}; found ${version}. ` +
        "Install a supported Node release and run npm ci again.",
    );
  }
}

export function verifyInstalledBuildToolchain(repoRoot, packageNames = BUILD_TOOLCHAIN_PACKAGES) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const lockedRoot = lock.packages?.[""];

  verifyBuildNodeVersion(process.versions.node, packageJson.engines?.node);
  if (lockedRoot?.engines?.node !== packageJson.engines.node) {
    throw new Error("package.json engines.node does not match package-lock.json. Run npm install --package-lock-only.");
  }

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
