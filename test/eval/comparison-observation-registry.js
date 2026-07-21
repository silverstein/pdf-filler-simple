import { createHash } from "node:crypto";

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

export function buildControllerObservationRegistry(report, controller = {}) {
  return {
    schema_version: 1,
    report_sha256: digest(report),
    allowed_directory_evidence_sha256: report.isolation.allowed_directory_evidence_sha256,
    controller: {
      producer: controller.producer ?? "comparison-controller",
      truth_loaded_after_report_freeze: controller.truth_loaded_after_report_freeze ?? false,
      network_enforcement: controller.network_enforcement ?? "not_enforced",
      claim_boundary: controller.claim_boundary
        ?? "Controller registry freezes candidate observations but has no external attestation signature.",
    },
    pairs: report.pairs.map(pair => ({
      pair_id: pair.pair_id,
      source_immutable: pair.source_immutable,
      undeclared_requests: structuredClone(pair.undeclared_requests),
      observations: structuredClone(pair.observations),
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
  }
  if (seen.size !== report.pairs.length) errors.push("registry.pairs must cover every report pair exactly once");
  return errors;
}
