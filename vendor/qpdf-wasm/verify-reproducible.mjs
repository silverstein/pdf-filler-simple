import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const recipeDir = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(await readFile(path.join(recipeDir, "expected-output.json"), "utf8"));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "oda-qpdf-wasm-verify-"));
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const tags = [`oda-qpdf-wasm-verify:${suffix}-a`, `oda-qpdf-wasm-verify:${suffix}-b`];
const useBuildx = spawnSync("docker", ["buildx", "version"], { stdio: "ignore" }).status === 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: recipeDir,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}`
      + (options.capture ? `\n${result.stderr}` : ""),
    );
  }
  return options.capture ? result.stdout.trim() : "";
}

function build(tag) {
  if (useBuildx) {
    run("docker", [
      "buildx", "build",
      "--platform=linux/amd64",
      "--network=none",
      "--no-cache",
      "--target", "export",
      "--load",
      "--tag", tag,
      ".",
    ]);
    return;
  }

  run("docker", [
    "build",
    "--platform=linux/amd64",
    "--network=none",
    "--no-cache",
    "--target", "export",
    "--tag", tag,
    ".",
  ], { env: { ...process.env, DOCKER_BUILDKIT: "0" } });
}

async function extract(tag, destination) {
  await mkdir(destination, { recursive: true });
  const container = run("docker", ["create", tag, "/"], { capture: true });
  try {
    for (const file of ["qpdf.mjs", "qpdf.wasm", "BUILD-INPUTS.json", "THIRD_PARTY_VERSIONS.txt"]) {
      run("docker", ["cp", `${container}:/${file}`, path.join(destination, file)]);
    }
    run("docker", ["cp", `${container}:/licenses`, path.join(destination, "licenses")]);
  } finally {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
}

async function listFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

async function inventory(root) {
  const result = {};
  for (const relativePath of await listFiles(root)) {
    const bytes = await readFile(path.join(root, relativePath));
    result[relativePath] = {
      bytes: (await stat(path.join(root, relativePath))).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return result;
}

try {
  run(process.execPath, [path.join(recipeDir, "fetch-sources.mjs")]);
  run("docker", ["info"], { capture: true });

  const buildDirectories = [];
  for (let index = 0; index < tags.length; index += 1) {
    build(tags[index]);
    const destination = path.join(temporaryRoot, `build-${index + 1}`);
    await extract(tags[index], destination);
    buildDirectories.push(destination);
  }

  const firstInventory = await inventory(buildDirectories[0]);
  const secondInventory = await inventory(buildDirectories[1]);
  if (JSON.stringify(firstInventory) !== JSON.stringify(secondInventory)) {
    throw new Error("Clean QPDF WASM builds were not byte-identical");
  }

  for (const [file, contract] of Object.entries(expected.artifacts)) {
    const actual = firstInventory[file];
    if (!actual || actual.bytes !== contract.bytes || actual.sha256 !== contract.sha256) {
      throw new Error(
        `${file} drifted: expected ${contract.bytes}/${contract.sha256}, `
        + `received ${actual?.bytes}/${actual?.sha256}`,
      );
    }
  }

  run(process.execPath, [
    path.join(recipeDir, "smoke.mjs"),
    buildDirectories[0],
    path.join(recipeDir, "..", "..", "example-fw9.pdf"),
  ]);

  console.log(JSON.stringify({
    schema_version: 1,
    byte_identical: true,
    toolchain: "Emscripten 6.0.3 linux/amd64",
    artifact_count: Object.keys(firstInventory).length,
    artifacts: expected.artifacts,
  }, null, 2));
} finally {
  for (const tag of tags) {
    spawnSync("docker", ["image", "rm", "--force", tag], { stdio: "ignore" });
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
