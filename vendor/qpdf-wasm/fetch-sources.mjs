import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const recipeDir = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(recipeDir, "sources.lock.json"), "utf8"));
const outputDir = path.join(recipeDir, "sources");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readVerified(filePath, expectedHash) {
  try {
    const bytes = await readFile(filePath);
    return sha256(bytes) === expectedHash ? bytes : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fetchSource(source) {
  const destination = path.join(outputDir, source.filename);
  const cached = await readVerified(destination, source.sha256);
  if (cached) {
    return { ...source, bytes: cached.byteLength, cache: "verified" };
  }

  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${source.name}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(bytes);
  if (actualHash !== source.sha256) {
    throw new Error(
      `${source.name} SHA-256 mismatch: expected ${source.sha256}, received ${actualHash}`,
    );
  }

  await writeFile(partial, bytes, { flag: "wx" });
  await rename(partial, destination);
  return { ...source, bytes: bytes.byteLength, cache: "downloaded" };
}

await mkdir(outputDir, { recursive: true });
const results = [];
for (const source of lock.sources) {
  results.push(await fetchSource(source));
}

console.log(JSON.stringify({ schema_version: 1, sources: results }, null, 2));
