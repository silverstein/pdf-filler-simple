import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const recipeDir = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(process.argv[2] || path.join(recipeDir, "dist"));
const fixturePath = path.resolve(
  process.argv[3] || path.join(recipeDir, "..", "..", "example-fw9.pdf"),
);
const createQpdf = (await import(pathToFileURL(path.join(artifactDir, "qpdf.mjs")).href)).default;
const requiredModuleSurface = ["FS", "_main", "callMain"];
const requiredFsSurface = ["writeFile", "readFile", "unlink", "mkdir", "rename", "symlink"];

function assertRawModuleSurface(qpdf) {
  const missingModuleSurface = requiredModuleSurface.filter((name) => !(name in qpdf));
  const missingFsSurface = requiredFsSurface.filter((name) => typeof qpdf.FS?.[name] !== "function");
  if (missingModuleSurface.length || missingFsSurface.length) {
    throw new Error(
      `QPDF raw module surface drifted; missing module [${missingModuleSurface.join(", ")}], `
      + `FS [${missingFsSurface.join(", ")}]`,
    );
  }
  if (typeof qpdf._main !== "function" || typeof qpdf.callMain !== "function") {
    throw new Error("QPDF raw module entry points are not callable");
  }
}

async function runQpdf(args, inputs = {}) {
  const stdout = [];
  const stderr = [];
  const qpdf = await createQpdf({
    print: (line) => stdout.push(String(line)),
    printErr: (line) => stderr.push(String(line)),
  });

  for (const [filePath, bytes] of Object.entries(inputs)) {
    qpdf.FS.writeFile(filePath, bytes);
  }

  let status;
  try {
    status = qpdf.callMain(args);
  } catch (error) {
    if (!Number.isInteger(error?.status)) throw error;
    status = error.status;
  }

  return {
    qpdf,
    status,
    stdout,
    stderr,
    readOutput(filePath) {
      try {
        return qpdf.FS.readFile(filePath);
      } catch {
        return null;
      }
    },
  };
}

const fixture = new Uint8Array(await readFile(fixturePath));
const version = await runQpdf(["--version"]);
assertRawModuleSurface(version.qpdf);
if (version.status !== 0 || !version.stdout.join("\n").includes("version 12.3.2")) {
  throw new Error(`QPDF version smoke failed with status ${version.status}`);
}

const encryptedRun = await runQpdf(
  [
    "/input.pdf",
    "--encrypt",
    "wasm-user-password",
    "wasm-owner-password",
    "256",
    "--",
    "/encrypted.pdf",
  ],
  { "/input.pdf": fixture },
);
const encrypted = encryptedRun.readOutput("/encrypted.pdf");
if (encryptedRun.status !== 0 || !encrypted || encrypted.byteLength < 100) {
  throw new Error(`QPDF encryption smoke failed with status ${encryptedRun.status}`);
}

const wrongPassword = await runQpdf(
  [
    "--password=incorrect-password",
    "--decrypt",
    "/encrypted.pdf",
    "/wrong-output.pdf",
  ],
  { "/encrypted.pdf": encrypted },
);
const wrongOutput = wrongPassword.readOutput("/wrong-output.pdf");
if (wrongPassword.status === 0 || wrongOutput) {
  throw new Error("QPDF accepted a wrong password or created output for a rejected password");
}

const decryptedRun = await runQpdf(
  [
    "--password=wasm-user-password",
    "--decrypt",
    "/encrypted.pdf",
    "/decrypted.pdf",
  ],
  { "/encrypted.pdf": encrypted },
);
const decrypted = decryptedRun.readOutput("/decrypted.pdf");
if (decryptedRun.status !== 0 || !decrypted || !Buffer.from(decrypted).subarray(0, 5).equals(Buffer.from("%PDF-"))) {
  throw new Error(`QPDF correct-password smoke failed with status ${decryptedRun.status}`);
}

const checkRun = await runQpdf(["--check", "/decrypted.pdf"], { "/decrypted.pdf": decrypted });
if (checkRun.status !== 0) {
  throw new Error(`QPDF rejected its decrypted output with status ${checkRun.status}`);
}

console.log(JSON.stringify({
  schema_version: 1,
  qpdf_version: "12.3.2",
  raw_module_surface: requiredModuleSurface,
  raw_fs_surface: requiredFsSurface,
  version_status: version.status,
  encrypt_status: encryptedRun.status,
  wrong_password_status: wrongPassword.status,
  wrong_password_created_output: Boolean(wrongOutput),
  decrypt_status: decryptedRun.status,
  check_status: checkRun.status,
  encrypted_bytes: encrypted.byteLength,
  decrypted_bytes: decrypted.byteLength,
}, null, 2));
