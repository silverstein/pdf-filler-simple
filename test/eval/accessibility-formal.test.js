import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fetchFormalAccessibilityCorpus } from "../../scripts/eval-fetch-accessibility-formal-corpus.mjs";
import {
  loadFormalAccessibilityContract,
  parseVeraPdfEvidence,
  runFormalAccessibilityEvaluation,
} from "./accessibility-formal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "formal-corpus.v1.json"
);
const temporaryDirectories = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function rawReport({
  compliant,
  failedRuleKeys = [],
  unhealthy = false,
  filename = "5-t01-fail-a.pdf",
  size = 38394,
}) {
  return Buffer.from(JSON.stringify({
    report: {
      buildInformation: {
        releaseDetails: [
          { id: "core", version: "1.30.2" },
          { id: "validation-model", version: "1.30.2" },
          { id: "apps", version: "1.30.2" },
        ],
      },
      jobs: [{
        itemDetails: { name: filename, size },
        validationResult: [{
          jobEndStatus: "normal",
          profileName: "PDF/UA-1 validation profile",
          compliant,
          details: {
            passedRules: compliant ? 106 : 105,
            failedRules: failedRuleKeys.length,
            passedChecks: compliant ? 905 : 900,
            failedChecks: failedRuleKeys.length,
            ruleSummaries: failedRuleKeys.map(key => {
              const [specification, clause, testNumber] = key.split("#");
              return { specification, clause, testNumber: Number(testNumber) };
            }),
          },
        }],
      }],
      batchSummary: {
        outOfMemory: unhealthy ? 1 : 0,
        veraExceptions: 0,
        failedEncryptedJobs: 0,
        failedParsingJobs: 0,
        validationSummary: { failedJobCount: 0 },
      },
    },
  }));
}

async function fakeFormalEnvironment() {
  const root = await temporaryDirectory("pdf-tools-formal-accessibility-");
  const corpus = path.join(root, "corpus");
  const validatorRoot = path.join(root, "validator");
  const javaHome = path.join(root, "java");
  const reports = path.join(root, "reports");
  await fs.mkdir(corpus, { recursive: true });
  await fs.mkdir(path.join(validatorRoot, "bin"), { recursive: true });
  await fs.mkdir(path.join(javaHome, "bin"), { recursive: true });

  const passBytes = Buffer.from("synthetic known-good input");
  const failBytes = Buffer.from("synthetic known-defect input");
  await fs.writeFile(path.join(corpus, "pass.pdf"), passBytes);
  await fs.writeFile(path.join(corpus, "fail.pdf"), failBytes);
  const artifact = path.join(root, "installer.zip");
  const runtimeArchive = path.join(root, "runtime.tar.gz");
  const cliJar = path.join(validatorRoot, "bin", "cli-1.30.2.jar");
  const java = path.join(javaHome, "bin", "java");
  await fs.writeFile(artifact, "pinned installer");
  await fs.writeFile(runtimeArchive, "pinned runtime archive");
  await fs.writeFile(cliJar, "pinned cli jar");
  await fs.writeFile(java, "pinned java binary");

  const validator = path.join(validatorRoot, "verapdf");
  const validatorSource = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const forbiddenEnvironment = ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH"];
if (forbiddenEnvironment.some(name => process.env[name])) process.exit(9);
if (process.env.LC_ALL !== "C.UTF-8" || process.env.TZ !== "UTC") process.exit(10);
if (args.includes("--version")) {
  process.stdout.write("veraPDF 1.30.2\\n");
  process.exit(0);
}
const defective = args.at(-1).endsWith("fail.pdf");
const input = args.at(-1);
const rules = defective ? [{ specification: "ISO 14289-1:2014", clause: "5", testNumber: 1 }] : [];
process.stdout.write(JSON.stringify({ report: {
  buildInformation: { releaseDetails: [
    { id: "core", version: "1.30.2" },
    { id: "validation-model", version: "1.30.2" },
    { id: "apps", version: "1.30.2" }
  ] },
  jobs: [{ itemDetails: { name: input, size: fs.statSync(input).size }, validationResult: [{
    jobEndStatus: "normal",
    profileName: "PDF/UA-1 validation profile",
    compliant: !defective,
    details: { passedRules: defective ? 105 : 106, failedRules: rules.length, passedChecks: 900, failedChecks: rules.length, ruleSummaries: rules }
  }] }],
  batchSummary: { outOfMemory: 0, veraExceptions: 0, failedEncryptedJobs: 0, failedParsingJobs: 0, validationSummary: { failedJobCount: 0 } }
} }));
process.exit(defective ? 1 : 0);
`;
  await fs.writeFile(validator, validatorSource, { mode: 0o755 });

  const { contract: original } = await loadFormalAccessibilityContract(CONTRACT_PATH);
  const contract = structuredClone(original);
  contract.validator.installer_sha256 = sha256(Buffer.from("pinned installer"));
  contract.validator.installed_wrapper_sha256 = sha256(Buffer.from(validatorSource));
  contract.validator.installed_cli_jar_sha256 = sha256(Buffer.from("pinned cli jar"));
  contract.runtime.archive_sha256 = sha256(Buffer.from("pinned runtime archive"));
  contract.runtime.java_binary_sha256 = sha256(Buffer.from("pinned java binary"));
  contract.fixtures = [
    {
      id: "fake.pass",
      filename: "pass.pdf",
      source_path: "pass.pdf",
      source_url: "https://example.test/pass.pdf",
      sha256: sha256(passBytes),
      size: passBytes.length,
      expected_machine_compliant: true,
      expected_failed_rule_keys: [],
      rule_family: "version_identification",
    },
    {
      id: "fake.fail",
      filename: "fail.pdf",
      source_path: "fail.pdf",
      source_url: "https://example.test/fail.pdf",
      sha256: sha256(failBytes),
      size: failBytes.length,
      expected_machine_compliant: false,
      expected_failed_rule_keys: ["ISO 14289-1:2014#5#1"],
      rule_family: "version_identification",
    },
  ];
  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify(contract));
  return { artifact, contract, contractPath, corpus, javaHome, reports, runtimeArchive, validator };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("formal accessibility machine-evidence pilot", () => {
  it("pins official validator, runtime, corpus, license, pass, defect, and raw-report evidence", async () => {
    const { contract } = await loadFormalAccessibilityContract(CONTRACT_PATH);
    expect(contract.validator).toMatchObject({
      name: "veraPDF Greenfield CLI",
      version: "1.30.2",
      profile: "ua1",
      signature_verification: "not_verified_no_trusted_key",
    });
    expect(contract.corpus).toMatchObject({
      license_spdx_id: "CC-BY-4.0",
      redistribution: "allowed",
    });
    expect(contract.fixtures.some(fixture => fixture.expected_machine_compliant)).toBe(true);
    expect(contract.fixtures.some(fixture => !fixture.expected_machine_compliant)).toBe(true);
    expect(contract.recorded_local_trial.pass_raw_report_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(contract.recorded_local_trial.fail_raw_report_sha256).toMatch(/^[a-f0-9]{64}$/);

    const directory = await temporaryDirectory("pdf-tools-formal-invalid-trial-");
    const invalid = structuredClone(contract);
    invalid.recorded_local_trial.pass_raw_report_sha256 = "not-a-digest";
    const invalidPath = path.join(directory, "invalid.json");
    await fs.writeFile(invalidPath, JSON.stringify(invalid));
    await expect(loadFormalAccessibilityContract(invalidPath))
      .rejects.toThrow("recorded_local_trial");
  });

  it("runs hash-bound validation and reports exact rule-family FP/FN without promoting conformance", async () => {
    const environment = await fakeFormalEnvironment();
    const hostileNames = ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH"];
    const previous = Object.fromEntries(hostileNames.map(name => [name, process.env[name]]));
    for (const name of hostileNames) process.env[name] = "hostile-parent-injection";
    let report;
    try {
      report = await runFormalAccessibilityEvaluation({
        contractPath: environment.contractPath,
        corpusDirectory: environment.corpus,
        validatorPath: environment.validator,
        validatorArtifactPath: environment.artifact,
        runtimeArchivePath: environment.runtimeArchive,
        javaHome: environment.javaHome,
        reportDirectory: environment.reports,
      });
    } finally {
      for (const name of hostileNames) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
    expect(report.passed).toBe(true);
    expect(report.execution_environment).toMatchObject({
      inherited_parent_environment: false,
      inherited_working_directory: false,
      locale: "C.UTF-8",
      timezone: "UTC",
      disposable_home: true,
      java_injection_variables_present: false,
    });
    expect(report.rule_family_confusion.version_identification).toEqual({
      true_positives: 1,
      true_negatives: 1,
      false_positives: 0,
      false_negatives: 0,
      harness_failures: 0,
    });
    expect(report.results.map(result => result.evidence.machine_validation_result)).toEqual([
      "validator_profile_passed",
      "validator_profile_failed",
    ]);
    expect(report.results.every(result =>
      result.evidence.claim_gate_ingestion === "not_available_phase_0"
    )).toBe(true);
    expect(report.results.every(result =>
      result.evidence.pdfua_conformance === "not_established_without_complete_human_review"
    )).toBe(true);
    expect(report.results.every(result => result.raw_report_sha256.match(/^[a-f0-9]{64}$/))).toBe(true);
  });

  it("fetches only hash-matching external corpus bytes", async () => {
    const environment = await fakeFormalEnvironment();
    const output = path.join(path.dirname(environment.contractPath), "fetched");
    const bodies = new Map([
      ["https://example.test/pass.pdf", Buffer.from("synthetic known-good input")],
      ["https://example.test/fail.pdf", Buffer.from("synthetic known-defect input")],
    ]);
    const result = await fetchFormalAccessibilityCorpus({
      contractPath: environment.contractPath,
      outputDirectory: output,
      fetchImpl: async url => new Response(bodies.get(url), { status: 200 }),
    });
    expect(result.results).toHaveLength(2);
    expect(result.results.map(item => item.sha256)).toEqual(environment.contract.fixtures.map(item => item.sha256));

    const corruptOutput = path.join(path.dirname(environment.contractPath), "corrupt");
    await expect(fetchFormalAccessibilityCorpus({
      contractPath: environment.contractPath,
      outputDirectory: corruptOutput,
      fetchImpl: async () => new Response("wrong bytes", { status: 200 }),
    })).rejects.toThrow("downloaded SHA-256 mismatch");
  });

  it("fails closed on exit/report disagreement, processing failures, and unexpected rules", async () => {
    const { contract } = await loadFormalAccessibilityContract(CONTRACT_PATH);
    const failingFixture = contract.fixtures.find(fixture => !fixture.expected_machine_compliant);
    const validFailure = rawReport({
      compliant: false,
      failedRuleKeys: ["ISO 14289-1:2014#5#1"],
    });
    expect(() => parseVeraPdfEvidence(validFailure, 0, failingFixture, contract))
      .toThrow("exit code");
    expect(() => parseVeraPdfEvidence(rawReport({
      compliant: false,
      failedRuleKeys: ["ISO 14289-1:2014#5#1"],
      unhealthy: true,
    }), 1, failingFixture, contract)).toThrow("processing or harness failure");
    const wrongRule = parseVeraPdfEvidence(rawReport({
      compliant: false,
      failedRuleKeys: ["ISO 14289-1:2014#7.1#99"],
    }), 1, failingFixture, contract);
    expect(wrongRule.expectation_met).toBe(false);
    expect(wrongRule.exact_failed_rules_match).toBe(false);
    const passingFixture = contract.fixtures.find(fixture => fixture.expected_machine_compliant);
    expect(() => parseVeraPdfEvidence(rawReport({
      compliant: true,
      failedRuleKeys: ["ISO 14289-1:2014#5#1"],
      filename: passingFixture.filename,
      size: passingFixture.size,
    }), 0, passingFixture, contract)).toThrow("failure counters");
  });
});
