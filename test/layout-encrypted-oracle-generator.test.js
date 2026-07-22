import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertProvenanceContract,
  generateLayoutEncryptedOracle,
  replaceExactHeader,
  runLocalProcess,
  runQpdf,
} from "../scripts/generate-layout-encrypted-oracle.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROVENANCE_PATH = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.provenance.json",
);
const CONTAINER_ID = "c".repeat(64);

function processResult(status, stdout = "", stderr = "", error = undefined) {
  return { status, stdout, stderr, error };
}

function dockerRunner(provenance, {
  failureAt = null,
  diagnostic = "injected failure",
  createStdout = `${CONTAINER_ID}\n`,
  createResult = null,
  createLeavesContainer = false,
  preexisting = false,
  writeCidfile = true,
  cidfileContents = null,
  cidfileWriter = null,
  recordOverrides = {},
  swapAfterCopyCount = null,
  swapBeforeRemovalProof = false,
} = {}) {
  const calls = [];
  let containerName = null;
  let cidfilePath = null;
  let imageReference = provenance.qpdf.scratch_image;
  let currentCid = CONTAINER_ID;
  let ownershipLabelValue = null;
  let ownershipLabelKey = null;
  let exists = preexisting;
  let createSeen = false;
  let copyCount = 0;
  let cidInspectCount = 0;
  const writeTrustedCidfile = () => {
    if (!writeCidfile) return;
    if (cidfileWriter) cidfileWriter(cidfilePath, cidfileContents ?? `${currentCid}\n`);
    else fsSync.writeFileSync(cidfilePath, cidfileContents ?? `${currentCid}\n`, { mode: 0o600 });
  };
  const missing = target => processResult(1, "[]\n", `Error: No such container: ${target}\n`);
  const record = () => [{
    Id: recordOverrides.cid ?? currentCid,
    Name: recordOverrides.name ?? `/${containerName}`,
    Image: recordOverrides.imageId ?? provenance.qpdf.scratch_image_id_sha256,
    Config: {
      Image: recordOverrides.imageReference ?? imageReference,
      Labels: {
        [ownershipLabelKey]: recordOverrides.label ?? ownershipLabelValue,
      },
    },
    Path: recordOverrides.path ?? "/",
    Args: recordOverrides.args ?? [],
    State: { Status: recordOverrides.status ?? "created" },
  }];
  const swapToUnownedReplacement = () => {
    currentCid = "d".repeat(64);
    recordOverrides.cid = currentCid;
    recordOverrides.label = "unowned-replacement";
  };
  const runner = (_command, args) => {
    calls.push(args);
    if (args[0] === "image") {
      if (failureAt === "image") return processResult(1, "", diagnostic);
      return processResult(0, `${provenance.qpdf.scratch_image_id_sha256}\n`);
    }
    if (args[0] === "create") {
      createSeen = true;
      containerName = args[args.indexOf("--name") + 1];
      [ownershipLabelKey, ownershipLabelValue] = args[args.indexOf("--label") + 1].split("=");
      cidfilePath = args[args.indexOf("--cidfile") + 1];
      imageReference = args.at(-2);
      if (failureAt === "create") return processResult(1, "", diagnostic);
      if (createResult) {
        exists = createLeavesContainer;
        if (exists) writeTrustedCidfile();
        return createResult;
      }
      exists = true;
      writeTrustedCidfile();
      return processResult(0, createStdout);
    }
    if (args[0] === "cp") {
      if (failureAt === "cp") return processResult(1, "", diagnostic);
      copyCount += 1;
      if (swapAfterCopyCount === copyCount) swapToUnownedReplacement();
      return processResult(0);
    }
    if (args[0] === "rm") {
      if (failureAt === "rm") return processResult(1, "", diagnostic);
      if (args[2] === currentCid) exists = false;
      return processResult(0, `${CONTAINER_ID}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      containerName ??= args[2];
      if (failureAt === "inspect" && createSeen) return processResult(1, "", diagnostic);
      if (exists) {
        if (args[2] === CONTAINER_ID) {
          cidInspectCount += 1;
          if (swapBeforeRemovalProof && cidInspectCount === 2) swapToUnownedReplacement();
        }
        if (args[2] !== containerName && args[2] !== currentCid) return missing(args[2]);
        return processResult(0, `${JSON.stringify(record())}\n`);
      }
      return missing(args[2]);
    }
    throw new Error(`Unexpected Docker arguments: ${JSON.stringify(args)}`);
  };
  return {
    calls,
    runner,
    state: () => ({ exists, containerName, ownershipLabelValue, cidfilePath, currentCid, copyCount }),
  };
}

function validProverReport(provenance) {
  return {
    schema_version: 1,
    fixture_id: provenance.fixture_id,
    image_id_sha256: provenance.qpdf.scratch_image_id_sha256,
    qpdf_version: provenance.qpdf.version,
    qpdf_version_stdout_sha256: provenance.qpdf.version_stdout_sha256,
    artifact_sha256: {
      "qpdf.mjs": provenance.qpdf.qpdf_mjs_sha256,
      "qpdf.wasm": provenance.qpdf.qpdf_wasm_sha256,
    },
    runs: provenance.generation.runs,
    byte_identical_across_two_runs: true,
    aes_128_revision_4_dictionary_verified: true,
    reversible_header_transform_verified: true,
    committed_fixture_match: true,
    scratch_container_cleanup_verified: true,
  };
}

function completeErrorDiagnostics(error, seen = new WeakSet()) {
  if (error == null) return [];
  if (!(error instanceof Error)) return [String(error)];
  if (seen.has(error)) return ["[circular]"];
  seen.add(error);
  return [
    error.name,
    error.message,
    error.stack,
    ...completeErrorDiagnostics(error.cause, seen),
    ...Array.from(error.errors ?? [], nested => completeErrorDiagnostics(nested, seen)).flat(),
  ].filter(Boolean);
}

async function expectTemporaryCleanup(provenance, options, errorPattern) {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "oda-layout-oracle-hostile-"));
  try {
    await expect(generateLayoutEncryptedOracle({
      provenance,
      temporaryParent,
      ...options,
    })).rejects.toThrow(errorPattern);
    expect(await fs.readdir(temporaryParent)).toEqual([]);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
}

describe("encrypted layout oracle generator", () => {
  it("rejects a false two-run provenance claim and removes its temporary directory", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const adversarial = structuredClone(provenance);
    adversarial.generation.reproducible_across_two_runs = false;
    expect(() => assertProvenanceContract(adversarial)).toThrow(/reproducible_across_two_runs/);

    const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "oda-layout-oracle-redteam-"));
    try {
      await expect(generateLayoutEncryptedOracle({
        provenance: adversarial,
        temporaryParent,
      })).rejects.toThrow(/reproducible_across_two_runs/);
      expect(await fs.readdir(temporaryParent)).toEqual([]);
    } finally {
      await fs.rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it.each([
    ["purpose", mutant => { mutant.purpose += " mutated"; }, /purpose/],
    ["encryption", mutant => { mutant.encrypted_fixture.encryption = "AES-256"; }, /encrypted_fixture\.encryption/],
    ["intentional malformation", mutant => { mutant.encrypted_fixture.intentional_malformation += " mutated"; }, /encrypted_fixture\.intentional_malformation/],
    ["postprocess", mutant => { mutant.generation.postprocess = "Replace an unspecified header."; }, /generation\.postprocess/],
    ["security notice and boundary", mutant => { mutant.generation.security_notice = "Test-only fixture."; }, /generation\.security_notice/],
  ])("rejects a provenance mutant in the exact %s contract", async (_label, mutate, expectedError) => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const mutant = structuredClone(provenance);
    mutate(mutant);
    expect(() => assertProvenanceContract(mutant)).toThrow(expectedError);
  });

  it.each([
    ["top-level", mutant => { mutant.production_safe = true; }, /root keys/],
    ["encrypted fixture", mutant => { mutant.encrypted_fixture.production_safe = true; }, /encrypted_fixture keys/],
    ["generation", mutant => { mutant.generation.production_safe = true; }, /generation keys/],
  ])("rejects unknown or contradictory %s attestation fields", async (_label, mutate, expectedError) => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const mutant = structuredClone(provenance);
    mutate(mutant);
    expect(() => assertProvenanceContract(mutant)).toThrow(expectedError);
  });

  it("cannot certify a deep-exact public report returned by a zero-work injected prover", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance, { failureAt: "image" });
    let fakeProverCalls = 0;
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
      fixtureProver: async () => {
        fakeProverCalls += 1;
        return structuredClone(validProverReport(provenance));
      },
    }, /Pinned scratch image inspection failed/);
    expect(fakeProverCalls).toBe(0);
  });

  it("requires a byte-preserving reversible header transform", () => {
    const intermediate = Buffer.from("%PDF-1.7\nfixture", "ascii");
    const finalFixture = replaceExactHeader(intermediate, "%PDF-", "xxxxx");
    expect(finalFixture.subarray(0, 5).toString("ascii")).toBe("xxxxx");
    expect(replaceExactHeader(finalFixture, "xxxxx", "%PDF-")).toEqual(intermediate);
    expect(() => replaceExactHeader(intermediate, "%PDF-", "shorter")).toThrow(/preserve byte length/);
    expect(() => replaceExactHeader(intermediate, "xxxxx", "%PDF-")).toThrow(/expected transform input/);
  });

  it.each([
    ["image inspection", "image", /Pinned scratch image inspection failed/],
    ["container creation", "create", /Scratch artifact container creation failed/],
    ["artifact copy", "cp", /Scratch artifact copy for qpdf\.mjs failed/],
    ["container removal", "rm", /Scratch artifact container removal failed/],
    ["container absence inspection", "inspect", /absence verification failed/],
    ["artifact inventory", null, /temporary artifact inventory/],
  ])("cleans its temporary directory after hostile %s failure", async (_label, failureAt, expectedError) => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance, { failureAt });
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, expectedError);
  });

  it("requires a local-only Docker create and accepts only exact container absence", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const exact = dockerRunner(provenance);
    await expectTemporaryCleanup(provenance, {
      processRunner: exact.runner,
    }, /temporary artifact inventory/);
    const createCall = exact.calls.find(args => args[0] === "create");
    expect(createCall.slice(0, 4)).toEqual(["create", "--pull=never", "--name", expect.stringMatching(/^oda-layout-oracle-[a-f0-9]{24}$/)]);
    expect(createCall[4]).toBe("--label");
    expect(createCall[5]).toMatch(/^org\.open-document-alliance\.pdf-tools\.layout-oracle=[a-f0-9]{64}$/);
    expect(createCall[6]).toBe("--cidfile");
    expect(createCall[7]).toMatch(/\.docker-cid-[a-f0-9]{32}$/);
    expect(createCall.slice(8)).toEqual([provenance.qpdf.scratch_image, "/"]);

    for (const diagnostic of [
      "Cannot connect to the Docker daemon",
      "docker: unknown command: container",
      "permission denied while connecting to the Docker daemon",
    ]) {
      const inspectionFailure = dockerRunner(provenance, { failureAt: "inspect", diagnostic });
      await expectTemporaryCleanup(provenance, {
        processRunner: inspectionFailure.runner,
      }, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("owns cleanup immediately after successful create without using contaminated stdout as an argument", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const contaminated = `${CONTAINER_ID}\n--hostile-contamination\n`;
    const docker = dockerRunner(provenance, { createStdout: contaminated });
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, /stdout did not exactly match the trusted CID file/);

    const createCall = docker.calls.find(args => args[0] === "create");
    const trustedName = createCall[createCall.indexOf("--name") + 1];
    expect(trustedName).toMatch(/^oda-layout-oracle-[a-f0-9]{24}$/);
    expect(docker.calls.find(args => args[0] === "rm")).toEqual(["rm", "--force", CONTAINER_ID]);
    expect(docker.calls.find(args => args[0] === "container")).toEqual(["container", "inspect", trustedName]);
    expect(docker.calls.some(args => args.some(argument => argument === contaminated))).toBe(false);
    expect(docker.calls.some(args => args[0] === "cp")).toBe(false);
  });

  it("reconciles and removes an owned container after indeterminate ENOBUFS create", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const enobufs = new Error("spawnSync docker ENOBUFS after create");
    enobufs.code = "ENOBUFS";
    const docker = dockerRunner(provenance, {
      createResult: processResult(null, "", "", enobufs),
      createLeavesContainer: true,
    });
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, /ENOBUFS after create/);

    const trustedName = docker.calls.find(args => args[0] === "create")[3];
    expect(docker.calls.find(args => args[0] === "rm")).toEqual(["rm", "--force", CONTAINER_ID]);
    expect(docker.calls.filter(args => args[0] === "container" && args[1] === "inspect")).toEqual([
      ["container", "inspect", trustedName],
      ["container", "inspect", CONTAINER_ID],
      ["container", "inspect", CONTAINER_ID],
      ["container", "inspect", CONTAINER_ID],
      ["container", "inspect", trustedName],
    ]);
    expect(docker.state().exists).toBe(false);
  });

  it("never grants ownership or removes a raced-in container after known nonzero create", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance, {
      createResult: processResult(1, "", "name conflict"),
      createLeavesContainer: true,
    });
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, /status=1/);
    expect(docker.calls.some(args => args[0] === "rm")).toBe(false);
    expect(docker.calls.some(args => args[0] === "container" && args[2] === CONTAINER_ID)).toBe(false);
    expect(docker.state().exists).toBe(true);
    expect(fsSync.existsSync(docker.state().cidfilePath)).toBe(false);
  });

  it.each([
    ["missing CID file", { writeCidfile: false }],
    ["forged CID file", { cidfileContents: `${"d".repeat(64)}\n` }],
    ["symlink CID file", {
      cidfileWriter: cidfilePath => fsSync.symlinkSync("/dev/null", cidfilePath),
    }],
  ])("preserves an unresolved indeterminate container with %s", async (_label, options) => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const timeout = new Error("Docker create timed out after a possible side effect");
    timeout.code = "ETIMEDOUT";
    const docker = dockerRunner(provenance, {
      ...options,
      createResult: processResult(null, "", "", timeout),
      createLeavesContainer: true,
    });
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, /ownership remained unresolved|CID ownership|CID-bound/);
    expect(docker.calls.some(args => args[0] === "rm")).toBe(false);
    expect(docker.state().exists).toBe(true);
  });

  it("bounds the CID descriptor read and rejects concurrent post-read growth", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance);
    let oldUnboundedReadFileCalled = false;
    let largestRequestedRead = 0;
    const hostileFileSystem = {
      ...fs,
      async open(target, flags) {
        if (!path.basename(target).startsWith(".docker-cid-")) return fs.open(target, flags);
        const initial = await fs.stat(target, { bigint: true });
        const changed = new Proxy(initial, {
          get(value, property) {
            if (property === "size") return BigInt(8 * 1024 * 1024);
            if (property === "mtimeNs") return value.mtimeNs + 1n;
            const resolved = Reflect.get(value, property, value);
            return typeof resolved === "function" ? resolved.bind(value) : resolved;
          },
        });
        let statCalls = 0;
        return {
          async stat() {
            statCalls += 1;
            return statCalls === 1 ? initial : changed;
          },
          async read(buffer, offset, length, position) {
            largestRequestedRead = Math.max(largestRequestedRead, length);
            if (position === 0) {
              const bytes = Buffer.from(`${CONTAINER_ID}\n`, "ascii");
              bytes.copy(buffer, offset);
              return { bytesRead: bytes.length, buffer };
            }
            return { bytesRead: 0, buffer };
          },
          async readFile() {
            oldUnboundedReadFileCalled = true;
            return Buffer.alloc(8 * 1024 * 1024);
          },
          async close() {},
        };
      },
    };
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
      fileSystem: hostileFileSystem,
    }, /identity changed during its bounded descriptor read/);
    expect(oldUnboundedReadFileCalled).toBe(false);
    expect(largestRequestedRead).toBe(66);
    expect(docker.calls.some(args => args[0] === "rm")).toBe(false);
    expect(docker.state().exists).toBe(true);
  });

  it.each([
    ["CID", { cid: "d".repeat(64) }],
    ["name", { name: "/raced-name" }],
    ["nonce label", { label: "raced-label" }],
    ["image ID", { imageId: `sha256:${"d".repeat(64)}` }],
    ["image reference", { imageReference: "untrusted-image:latest" }],
    ["command", { path: "/bin/false" }],
    ["state", { status: "running" }],
  ])("does not remove a container with substituted %s ownership evidence", async (_label, recordOverrides) => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance, { recordOverrides });
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, /exact CID, name, nonce label, image, command, and created-state contract/);
    expect(docker.calls.some(args => args[0] === "rm")).toBe(false);
    expect(docker.state().exists).toBe(true);
  });

  it.each([
    ["after the second copy", { swapAfterCopyCount: 2 }],
    ["at the fresh pre-removal proof", { swapBeforeRemovalProof: true }],
  ])("revalidates ownership and preserves a replacement swapped %s", async (_label, options) => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance, options);
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, /ownership changed before removal/);
    expect(docker.calls.some(args => args[0] === "rm")).toBe(false);
    expect(docker.state()).toMatchObject({ exists: true, currentCid: "d".repeat(64) });
  });

  it("does not create or remove when the trusted container name unexpectedly pre-exists", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance, { preexisting: true });
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
    }, /already in use before create/);
    expect(docker.calls.some(args => args[0] === "create")).toBe(false);
    expect(docker.calls.some(args => args[0] === "rm")).toBe(false);
    expect(docker.state().exists).toBe(true);
  });

  it("refuses a pre-existing CID-file path before Docker create", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance);
    const hostileFileSystem = {
      ...fs,
      async lstat(target) {
        if (path.basename(target).startsWith(".docker-cid-")) return fs.stat(PROVENANCE_PATH);
        return fs.lstat(target);
      },
    };
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
      fileSystem: hostileFileSystem,
    }, /CID file unexpectedly existed before Docker create/);
    expect(docker.calls.some(args => args[0] === "create")).toBe(false);
    expect(docker.calls.some(args => args[0] === "rm")).toBe(false);
  });

  it("diagnoses CID-file cleanup failure after reconciling the owned container", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const docker = dockerRunner(provenance);
    const hostileFileSystem = {
      ...fs,
      async rm(target, options) {
        if (path.basename(target).startsWith(".docker-cid-")) {
          throw new Error("Injected CID-file cleanup failure");
        }
        return fs.rm(target, options);
      },
    };
    await expectTemporaryCleanup(provenance, {
      processRunner: docker.runner,
      fileSystem: hostileFileSystem,
    }, /CID file removal failed.*CID file remained after cleanup/);
    expect(docker.calls.find(args => args[0] === "rm")).toEqual(["rm", "--force", CONTAINER_ID]);
    expect(docker.state().exists).toBe(false);
  });

  it("retains Docker stderr diagnostics while redacting every test password", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const diagnostic = `copy failed for ${provenance.passwords.user}, ${provenance.passwords.owner}, and ${provenance.passwords.wrong_password_oracle}`;
    const docker = dockerRunner(provenance, { failureAt: "cp", diagnostic });
    const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "oda-layout-oracle-redaction-"));
    try {
      await generateLayoutEncryptedOracle({
        provenance,
        temporaryParent,
        processRunner: docker.runner,
      });
      throw new Error("Expected an injected Docker failure.");
    } catch (error) {
      const diagnostics = [error.message, ...(error.errors ?? []).map(nested => nested?.message)].join("\n");
      expect(diagnostics).toContain("stderr=copy failed for [REDACTED], [REDACTED], and [REDACTED]");
      for (const password of Object.values(provenance.passwords)) {
        expect(diagnostics).not.toContain(password);
      }
    } finally {
      expect(await fs.readdir(temporaryParent)).toEqual([]);
      await fs.rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("recursively redacts password-bearing Error causes and AggregateError members", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "oda-layout-oracle-nested-errors-"));
    let failure = null;
    const hostileFileSystem = {
      ...fs,
      async readFile() {
        throw new AggregateError(
          [
            new Error(`QPDF failed near ${provenance.passwords.user}`),
            new AggregateError(
              [new Error(`owner detail ${provenance.passwords.owner}`)],
              `nested ${provenance.passwords.wrong_password_oracle}`,
            ),
          ],
          `top-level ${provenance.passwords.user}`,
          { cause: new Error(`cause ${provenance.passwords.owner}`) },
        );
      },
    };
    try {
      await generateLayoutEncryptedOracle({
        provenance,
        temporaryParent,
        fileSystem: hostileFileSystem,
      });
    } catch (error) {
      failure = error;
    } finally {
      expect(await fs.readdir(temporaryParent)).toEqual([]);
      await fs.rm(temporaryParent, { recursive: true, force: true });
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const diagnostics = completeErrorDiagnostics(failure).join("\n");
    expect(diagnostics).toContain("[REDACTED]");
    for (const password of Object.values(provenance.passwords)) {
      expect(diagnostics).not.toContain(password);
    }
  });

  it("enforces a finite local-process timeout with signal and code evidence", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const startedAt = Date.now();
    const result = runLocalProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 50 },
    );
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.status).toBeNull();
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(result.signal).toBe("SIGKILL");
    await expectTemporaryCleanup(provenance, {
      processRunner: () => result,
    }, /signal=SIGKILL; code=ETIMEDOUT/);
  });

  it("binds the QPDF program name independently of the importing process argv", async () => {
    let configuredProgram = null;
    const result = await runQpdf(async options => {
      configuredProgram = options.thisProgram;
      return {
        FS: { writeFile() {} },
        callMain() {
          options.print(`${options.thisProgram} version 12.3.2`);
          return 0;
        },
      };
    }, ["--version"]);
    expect(configuredProgram).toBe("generate-layout-encrypted-oracle.mjs");
    expect(result.stdout).toEqual(["generate-layout-encrypted-oracle.mjs version 12.3.2"]);
  });

  it.each([
    ["thrown", () => { throw { status: 2 }; }],
    ["returned", () => 2],
  ])("fails a %s nonzero QPDF status and cleans every virtual PDF path", async (_kind, callMain) => {
    const unlinkAttempts = [];
    await expect(runQpdf(async () => ({
      FS: {
        writeFile() {},
        unlink(filePath) { unlinkAttempts.push(filePath); },
      },
      callMain,
    }), ["/input.pdf", "/output.pdf"], { "/input.pdf": Buffer.from("fixture") })).rejects.toThrow(
      /nonzero status 2/,
    );
    expect(unlinkAttempts.sort()).toEqual(["/input.pdf", "/output.pdf"]);
  });

  it("aggregates integer QPDF exit and virtual cleanup failures", async () => {
    const unlinkAttempts = [];
    let failure = null;
    try {
      await runQpdf(async () => ({
        FS: {
          writeFile() {},
          unlink(filePath) {
            unlinkAttempts.push(filePath);
            throw new Error(`cannot unlink ${filePath}`);
          },
        },
        callMain() { return 2; },
      }), ["/input.pdf", "/output.pdf"], { "/input.pdf": Buffer.from("fixture") });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(completeErrorDiagnostics(failure).join("\n")).toContain("nonzero status 2");
    expect(completeErrorDiagnostics(failure).join("\n")).toContain("virtual file cleanup failed");
    expect(unlinkAttempts.sort()).toEqual(["/input.pdf", "/output.pdf"]);
  });

  it("bounds QPDF output, drains synchronous callbacks, and returns redacted diagnostics", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    let callbackCount = 0;
    let callCompleted = false;
    const unlinked = [];
    let failure = null;
    try {
      await runQpdf(async ({ print, printErr }) => ({
        FS: {
          writeFile() {},
          readFile() { return new Uint8Array(); },
          unlink(filePath) { unlinked.push(filePath); },
        },
        callMain() {
          for (let index = 0; index < 20_000; index += 1) {
            print(`line-${index}-${provenance.passwords.user}`);
            printErr(`error-${index}-${provenance.passwords.owner}`);
            callbackCount += 2;
          }
          callCompleted = true;
          return 0;
        },
      }), ["/input.pdf", "/encrypted.pdf"], { "/input.pdf": Buffer.from("fixture") });
    } catch (error) {
      failure = error;
    }
    expect(callCompleted).toBe(true);
    expect(callbackCount).toBe(40_000);
    expect(unlinked.sort()).toEqual(["/encrypted.pdf", "/input.pdf"]);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("65536-byte hard cap");
    expect(failure.message.length).toBeLessThanOrEqual(2000);
    expect(failure.message).toContain("[REDACTED]");
    for (const password of Object.values(provenance.passwords)) {
      expect(completeErrorDiagnostics(failure).join("\n")).not.toContain(password);
    }
  });

  it("aggregates bounded cap and virtual-file cleanup failures after attempting every unlink", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const unlinkAttempts = [];
    let failure = null;
    try {
      await runQpdf(async ({ print }) => ({
        FS: {
          writeFile() {},
          unlink(filePath) {
            unlinkAttempts.push(filePath);
            throw new Error(`unlink failed for ${filePath} near ${provenance.passwords.owner}`);
          },
        },
        callMain() {
          for (let index = 0; index < 10_000; index += 1) {
            print(`overflow-${index}-${provenance.passwords.user}`);
          }
          return 0;
        },
      }), ["/input.pdf", "/encrypted.pdf"], { "/input.pdf": Buffer.from("fixture") });
    } catch (error) {
      failure = error;
    }
    expect(unlinkAttempts.sort()).toEqual(["/encrypted.pdf", "/input.pdf"]);
    expect(failure).toBeInstanceOf(AggregateError);
    const diagnostics = completeErrorDiagnostics(failure);
    expect(diagnostics.join("\n")).toContain("65536-byte hard cap");
    expect(diagnostics.join("\n")).toContain("virtual file cleanup failed for /input.pdf");
    expect(diagnostics.join("\n")).toContain("virtual file cleanup failed for /encrypted.pdf");
    expect(diagnostics.every(value => value.length <= 2000)).toBe(true);
    for (const password of Object.values(provenance.passwords)) {
      expect(diagnostics.join("\n")).not.toContain(password);
    }
  });

  it("redacts raw QPDF factory and execution errors", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const factories = [
      async () => {
        throw new Error(`factory ${provenance.passwords.user}`, {
          cause: new Error(`factory cause ${provenance.passwords.owner}`),
        });
      },
      async () => ({
        FS: { writeFile() {} },
        callMain() {
          throw new AggregateError(
            [new Error(`execution ${provenance.passwords.wrong_password_oracle}`)],
            `callMain ${provenance.passwords.user}`,
          );
        },
      }),
    ];
    for (const factory of factories) {
      let failure = null;
      try {
        await runQpdf(factory, ["--hostile-error"]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const diagnostics = completeErrorDiagnostics(failure).join("\n");
      expect(diagnostics).toContain("[REDACTED]");
      for (const password of Object.values(provenance.passwords)) {
        expect(diagnostics).not.toContain(password);
      }
    }
  });

  it("reports a temporary-directory cleanup failure and permits external recovery", async () => {
    const provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "oda-layout-oracle-cleanup-failure-"));
    let generatedRoot = null;
    const hostileFileSystem = {
      ...fs,
      async mkdtemp(prefix) {
        generatedRoot = await fs.mkdtemp(prefix);
        return generatedRoot;
      },
      async rm(target, options) {
        if (target === generatedRoot) throw new Error("Injected temporary cleanup failure");
        return fs.rm(target, options);
      },
    };
    const docker = dockerRunner(provenance, { failureAt: "image" });
    try {
      await expect(generateLayoutEncryptedOracle({
        provenance,
        temporaryParent,
        fileSystem: hostileFileSystem,
        processRunner: docker.runner,
      })).rejects.toThrow(/Injected temporary cleanup failure.*temporary directory remained after cleanup/);
      expect(generatedRoot).not.toBeNull();
      expect(await fs.readdir(temporaryParent)).toEqual([path.basename(generatedRoot)]);
    } finally {
      if (generatedRoot) await fs.rm(generatedRoot, { recursive: true, force: true });
      await fs.rm(temporaryParent, { recursive: true, force: true });
    }
  });
});
