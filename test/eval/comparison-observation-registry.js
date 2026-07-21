import { createHash } from "node:crypto";

const CONTROLLER_RECORDS = new WeakMap();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

export function registerControllerObservationRecords(report, records) {
  if (!report || typeof report !== "object" || !Array.isArray(records)) {
    throw new Error("report and controller observation records are required");
  }
  CONTROLLER_RECORDS.set(report, structuredClone(records));
  return report;
}

export function copyControllerObservationRecords(source, target, additionalRecords = []) {
  const records = CONTROLLER_RECORDS.get(source);
  if (!records) throw new Error("source report has no independently retained controller records");
  return registerControllerObservationRecords(target, [...records, ...additionalRecords]);
}

export function buildControllerObservationRegistry(report, controller = {}) {
  const retainedRecords = CONTROLLER_RECORDS.get(report);
  if (!retainedRecords) {
    throw new Error("report has no independently retained controller observation records");
  }
  const recordsByPair = new Map();
  for (const record of retainedRecords) {
    if (!recordsByPair.has(record.pair_id)) recordsByPair.set(record.pair_id, []);
    recordsByPair.get(record.pair_id).push(record);
  }
  return {
    schema_version: 1,
    report_sha256: digest(report),
    allowed_directory_evidence_sha256: report.isolation.allowed_directory_evidence_sha256,
    controller: {
      producer: controller.producer ?? "comparison-controller",
      truth_loaded_after_report_freeze: controller.truth_loaded_after_report_freeze ?? false,
      network_enforcement: controller.network_enforcement ?? "not_enforced",
      attestation_status: "unsigned",
      claim_boundary: controller.claim_boundary
        ?? "Controller registry freezes candidate observations but has no external attestation signature.",
    },
    pairs: report.pairs.map(pair => ({
      pair_id: pair.pair_id,
      source_immutable: pair.source_immutable,
      undeclared_requests: structuredClone(pair.undeclared_requests),
      observations: structuredClone(pair.observations),
      retained_raw_results: structuredClone(recordsByPair.get(pair.pair_id) ?? []),
    })),
  };
}

export function validateControllerObservationRegistry(report, registry) {
  const errors = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return ["controller observation registry is required"];
  }
  if (registry.schema_version !== 1) errors.push("registry.schema_version must equal 1");
  if (registry.report_sha256 !== digest(report)) errors.push("registry.report_sha256 does not bind the frozen report");
  if (registry.allowed_directory_evidence_sha256 !== report.isolation.allowed_directory_evidence_sha256) {
    errors.push("registry.allowed_directory_evidence_sha256 does not bind report isolation evidence");
  }
  if (!registry.controller || typeof registry.controller !== "object") {
    errors.push("registry.controller is required");
  } else {
    if (typeof registry.controller.producer !== "string" || !registry.controller.producer) {
      errors.push("registry.controller.producer must be non-empty");
    }
    if (typeof registry.controller.truth_loaded_after_report_freeze !== "boolean") {
      errors.push("registry.controller.truth_loaded_after_report_freeze must be boolean");
    }
    if (!new Set(["denied", "not_enforced"]).has(registry.controller.network_enforcement)) {
      errors.push("registry.controller.network_enforcement is invalid");
    }
    if (registry.controller.attestation_status !== "unsigned") {
      errors.push("registry.controller.attestation_status must remain unsigned until a verifier is implemented");
    }
    if (typeof registry.controller.claim_boundary !== "string" || !registry.controller.claim_boundary) {
      errors.push("registry.controller.claim_boundary must be non-empty");
    }
  }
  if (!Array.isArray(registry.pairs)) return [...errors, "registry.pairs must be an array"];
  const reportByPair = new Map(report.pairs.map(pair => [pair.pair_id, pair]));
  const seen = new Set();
  for (const pair of registry.pairs) {
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
      errors.push("registry pair must be an object");
      continue;
    }
    const reportPair = reportByPair.get(pair.pair_id);
    if (!reportPair) {
      errors.push(`registry pair ${pair.pair_id} is unknown`);
      continue;
    }
    if (seen.has(pair.pair_id)) errors.push(`registry pair ${pair.pair_id} is duplicated`);
    seen.add(pair.pair_id);
    if (pair.source_immutable !== reportPair.source_immutable) {
      errors.push(`registry pair ${pair.pair_id} source immutability does not match`);
    }
    if (canonical(pair.undeclared_requests) !== canonical(reportPair.undeclared_requests)) {
      errors.push(`registry pair ${pair.pair_id} request ledger does not match`);
    }
    if (canonical(pair.observations) !== canonical(reportPair.observations)) {
      errors.push(`registry pair ${pair.pair_id} observations do not match retained controller records`);
    }
    if (!Array.isArray(pair.retained_raw_results)) {
      errors.push(`registry pair ${pair.pair_id} retained raw results must be an array`);
    } else {
      const retainedByObservation = new Map();
      for (const record of pair.retained_raw_results) {
        if (!record || typeof record !== "object" || Array.isArray(record)
          || canonical(Object.keys(record).sort()) !== canonical([
            "capture", "observation_id", "pair_id", "raw_result_sha256",
          ])) {
          errors.push(`registry pair ${pair.pair_id} has an invalid retained raw-result record`);
          continue;
        }
        if (record.pair_id !== pair.pair_id) {
          errors.push(`registry pair ${pair.pair_id} retained raw-result pair binding is invalid`);
        }
        if (retainedByObservation.has(record.observation_id)) {
          errors.push(`registry pair ${pair.pair_id} duplicates retained raw result ${record.observation_id}`);
        }
        retainedByObservation.set(record.observation_id, record);
      }
      for (const observation of reportPair.observations) {
        const retained = retainedByObservation.get(observation.id);
        if (!retained || retained.raw_result_sha256 !== observation.raw_result_sha256
          || retained.capture !== observation.capture) {
          errors.push(`registry pair ${pair.pair_id} observation ${observation.id} is not bound to an independently retained raw result`);
        }
      }
      if (retainedByObservation.size !== reportPair.observations.length) {
        errors.push(`registry pair ${pair.pair_id} retained raw results must cover every observation exactly once`);
      }
    }
  }
  if (seen.size !== report.pairs.length) errors.push("registry.pairs must cover every report pair exactly once");
  return errors;
}
