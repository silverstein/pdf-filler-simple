import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyEvidencePrecondition,
  trajectoryApprovalStalenessOnly,
} from "./evidence-preconditions.js";
import { doclingCalibrationStatus } from "../eval/extraction-docling-handoff.js";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    root => fs.rm(root, { recursive: true, force: true }),
  ));
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("evidence precondition classifier", () => {
  it("classifies the stale attestation code as stale", () => {
    const error = new Error("anything");
    error.code = "EVAL_ATTESTATION_STALE";
    expect(classifyEvidencePrecondition(error)).toMatchObject({ kind: "stale" });
  });

  it("classifies the unprovisioned code as unprovisioned, not stale", () => {
    const error = new Error("anything");
    error.code = "EVAL_EVIDENCE_UNPROVISIONED";
    expect(classifyEvidencePrecondition(error)).toMatchObject({ kind: "unprovisioned" });
  });

  it("returns null for an unrecognised error so the caller fails red", () => {
    expect(classifyEvidencePrecondition(new Error("some product defect"))).toBeNull();
    expect(classifyEvidencePrecondition(null)).toBeNull();
  });
});

describe("trajectory approval staleness classifier", () => {
  it("accepts an aggregate whose every finding is approval-source staleness", () => {
    expect(trajectoryApprovalStalenessOnly(
      "Invalid trajectory suite:\n"
      + "- visual oracle approval source file package-lock.json changed\n"
      + "- visual oracle approval source file server/index.js changed",
    )).toBe(true);
  });

  it("rejects an aggregate that mixes staleness with a real integrity defect", () => {
    expect(trajectoryApprovalStalenessOnly(
      "Invalid trajectory suite:\n"
      + "- visual oracle approval source file package-lock.json changed\n"
      + "- visual oracle approval review receipt is invalid",
    )).toBe(false);
  });

  it("rejects a non-staleness finding whose interpolated path merely ends in 'changed'", () => {
    expect(trajectoryApprovalStalenessOnly(
      "Invalid trajectory suite:\n"
      + "- visual oracle approval source file evil changed is not allowlisted",
    )).toBe(false);
  });

  it("accepts CRLF staleness findings", () => {
    expect(trajectoryApprovalStalenessOnly(
      "Invalid trajectory suite:\r\n"
      + "- visual oracle approval source file package-lock.json changed\r",
    )).toBe(true);
  });

  it("rejects a malformed-approval aggregate with no staleness finding", () => {
    expect(trajectoryApprovalStalenessOnly(
      "Invalid trajectory suite:\n"
      + "- visual oracle approval artifact has missing or undeclared top-level fields",
    )).toBe(false);
  });

  it("rejects messages with no findings at all, including loader crashes", () => {
    expect(trajectoryApprovalStalenessOnly("ENOENT: no such file or directory")).toBe(false);
    expect(trajectoryApprovalStalenessOnly("Unexpected token in JSON")).toBe(false);
    expect(trajectoryApprovalStalenessOnly("")).toBe(false);
  });
});

describe("docling calibration status corruption boundary", () => {
  const ATTESTATION_RELATIVE =
    "test/fixtures/eval/extraction/phase1/docling-supervisor-calibration-attestation.v1.json";
  const RETIREMENT_RELATIVE =
    "test/fixtures/eval/extraction/phase1/docling-supervisor-calibration-retirement.v1.json";
  const SOURCE_RELATIVE = "test/eval/native/docling-macos-supervisor.c";
  const CONTROLLER_RELATIVE = "test/eval/docling-macos-supervisor.js";

  async function writeRetirement(root, attestation, overrides = {}) {
    const bytes = Buffer.from(JSON.stringify(attestation));
    await fs.writeFile(path.join(root, RETIREMENT_RELATIVE), JSON.stringify({
      protocol: "pdf-tools.docling-supervisor-calibration-retirement.v1",
      retired: true,
      retired_on: "2026-07-31",
      retires_attestation: { sha256: sha256(bytes), bytes: bytes.length },
      reason: "synthetic retirement for the corruption-boundary bank",
      ...overrides,
    }));
    return bytes;
  }

  async function syntheticRepo({ attestation, source, controller } = {}) {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-calibration-status-")),
    );
    temporaryRoots.push(root);
    if (source !== null) {
      const file = path.join(root, SOURCE_RELATIVE);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, source ?? "int main(void) { return 0; }\n");
    }
    if (controller !== null) {
      const file = path.join(root, CONTROLLER_RELATIVE);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, controller ?? "export {};\n");
    }
    if (attestation !== undefined && attestation !== null) {
      const file = path.join(root, ATTESTATION_RELATIVE);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        typeof attestation === "string" ? attestation : JSON.stringify(attestation),
      );
    } else {
      await fs.mkdir(path.dirname(path.join(root, ATTESTATION_RELATIVE)), { recursive: true });
    }
    return root;
  }

  async function matchingAttestation(root) {
    const source = await fs.readFile(path.join(root, SOURCE_RELATIVE));
    const controller = await fs.readFile(path.join(root, CONTROLLER_RELATIVE));
    return {
      supervisor: {
        source: { sha256: sha256(source), bytes: source.length },
        controller: { sha256: sha256(controller), bytes: controller.length },
      },
    };
  }

  it("reports current when the attestation matches both sources", async () => {
    const root = await syntheticRepo();
    await fs.writeFile(
      path.join(root, ATTESTATION_RELATIVE),
      JSON.stringify(await matchingAttestation(root)),
    );
    expect(doclingCalibrationStatus(root)).toEqual({ current: true, reason: null });
  });

  it("reports drift as a named non-current status, not a throw", async () => {
    const root = await syntheticRepo();
    const attestation = await matchingAttestation(root);
    await fs.writeFile(
      path.join(root, ATTESTATION_RELATIVE),
      JSON.stringify(attestation),
    );
    await fs.appendFile(path.join(root, SOURCE_RELATIVE), "/* drifted */\n");
    const status = doclingCalibrationStatus(root);
    expect(status.current).toBe(false);
    expect(status.reason).toMatch(/stale for supervisor source/);
    expect(status.reason).toMatch(/not a product defect/);
  });

  it("reports an exact-bound retirement as a retired skip, superseding drift", async () => {
    const root = await syntheticRepo();
    const attestation = await matchingAttestation(root);
    const bytes = await writeRetirement(root, attestation);
    await fs.writeFile(path.join(root, ATTESTATION_RELATIVE), bytes);
    // Drift the source too: retirement must win over the drift comparison.
    await fs.appendFile(path.join(root, SOURCE_RELATIVE), "/* drifted */\n");
    const status = doclingCalibrationStatus(root);
    expect(status).toMatchObject({ current: false, retired: true });
    expect(status.reason).toMatch(/retired on 2026-07-31/);
    expect(status.reason).toMatch(/not a product defect/);
  });

  it("throws when the retirement record does not bind the exact attestation", async () => {
    const root = await syntheticRepo();
    const attestation = await matchingAttestation(root);
    await writeRetirement(root, attestation, {
      retires_attestation: { sha256: "a".repeat(64), bytes: 1 },
    });
    await fs.writeFile(path.join(root, ATTESTATION_RELATIVE), JSON.stringify(attestation));
    expect(() => doclingCalibrationStatus(root))
      .toThrow(/does not bind the exact attestation/);
  });

  it("throws on a malformed retirement record instead of skipping", async () => {
    const root = await syntheticRepo();
    const attestation = await matchingAttestation(root);
    const bytes = await writeRetirement(root, attestation, { retired: false });
    await fs.writeFile(path.join(root, ATTESTATION_RELATIVE), bytes);
    expect(() => doclingCalibrationStatus(root)).toThrow(/retirement record is malformed/);
  });

  it("throws when a retirement record dangles without its attestation", async () => {
    const root = await syntheticRepo({ attestation: null });
    await writeRetirement(root, { synthetic: true });
    expect(() => doclingCalibrationStatus(root)).toThrow(/ENOENT/);
  });

  it("throws on a missing attestation instead of skipping", async () => {
    const root = await syntheticRepo({ attestation: null });
    expect(() => doclingCalibrationStatus(root)).toThrow(/ENOENT/);
  });

  it("throws on unparseable attestation JSON instead of skipping", async () => {
    const root = await syntheticRepo({ attestation: "{ not json" });
    expect(() => doclingCalibrationStatus(root)).toThrow();
  });

  it("throws on a structurally hollow attestation instead of reporting drift", async () => {
    const root = await syntheticRepo({ attestation: {} });
    expect(() => doclingCalibrationStatus(root)).toThrow(/malformed/);
  });

  it("throws when a bound source file is missing instead of skipping", async () => {
    const root = await syntheticRepo();
    const attestation = await matchingAttestation(root);
    await fs.writeFile(
      path.join(root, ATTESTATION_RELATIVE),
      JSON.stringify(attestation),
    );
    await fs.rm(path.join(root, SOURCE_RELATIVE));
    expect(() => doclingCalibrationStatus(root)).toThrow(/ENOENT/);
  });
});
