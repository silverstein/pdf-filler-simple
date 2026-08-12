import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  verifyRemoteHybridArchitecture,
} from "../scripts/verify-remote-hybrid-architecture.mjs";

const CONTRACT = JSON.parse(await fs.readFile(
  new URL("../config/remote-hybrid-trust-boundary.v1.json", import.meta.url),
  "utf8",
));
const LEDGER = JSON.parse(await fs.readFile(
  new URL(
    "../docs/evidence/remote-hybrid-host-capabilities-2026-07-30.json",
    import.meta.url,
  ),
  "utf8",
));
const ARCHITECTURE_DOCUMENT = await fs.readFile(
  new URL(
    "../docs/REMOTE_HYBRID_ARCHITECTURE_2026-07-30.md",
    import.meta.url,
  ),
  "utf8",
);

function clone(value) {
  return structuredClone(value);
}

const CONTRACT_MUTANTS = [
  ["unknown production authority field", value => {
    value.production_authorized = true;
  }],
  ["Origin required from non-browser clients", value => {
    value.protocol_baselines.remote_target.origin_policy.missing =
      "reject_403";
  }],
  ["contradictory contract claim boundary", value => {
    value.claim_boundary +=
      " This is a deployed service and native-host result.";
  }],
  ["production GO without gates", value => {
    value.decisions.remote_production_service.verdict = "GO";
  }],
  ["erased authentication controls", value => {
    value.required_controls.authentication = [];
  }],
  ["implicit remote upload consent", value => {
    value.modes.find(mode => mode.id === "remote_only")
      .required_consent_event = "implicit";
  }],
  ["erased hybrid shortcuts", value => {
    value.modes.find(mode => mode.id === "hybrid_explicit_handoff")
      .forbidden_shortcuts = [];
  }],
  ["ambient local companion authority", value => {
    value.principals.find(principal => principal.id === "local_companion")
      .must_not = [];
  }],
  ["broad replayable output grant", value => {
    value.required_controls.outputs = ["reusable_download_url"];
  }],
  ["erased content identity", value => {
    value.document_identity.content_identity = [];
  }],
  ["erased operation receipt", value => {
    value.document_identity.output_receipt = [];
  }],
  ["user upload in mock operations", value => {
    value.bounded_vertical_slice.allowed_operations.push(
      "user_document_upload",
    );
  }],
  ["downgraded replay threat gate", value => {
    value.threat_register.find(threat => threat.id === "T09")
      .required_gate = "log_the_download";
  }],
  ["self-attested upload gate", value => {
    value.production_flip_gates.find(gate => gate.id === "G05")
      .evidence = "trust us";
  }],
  ["Tasks treated as universal", value => {
    value.protocol_baselines.tasks_extension.lifecycle_status = "universal";
  }],
  ["MCP Apps granted ambient DOM", value => {
    value.protocol_baselines.apps_extension.portable_bridge = "ambient_dom";
  }],
  ["same key with different arguments reused", value => {
    value.bounded_vertical_slice.idempotency_contract
      .same_key_different_request = "reuse_prior_result";
  }],
  ["empty synthetic input allowlist", value => {
    value.modes.find(mode => mode.id === "remote_only").allowed_inputs = [];
  }],
];

const LEDGER_MUTANTS = [
  ["unknown unreviewed-source authority field", value => {
    value.authoritative_unreviewed_sources = true;
  }],
  ["contradictory ledger claim boundary", value => {
    value.claim_boundary +=
      " Exact PDF Tools works in every listed host.";
  }],
  ["erased primary-source policy", value => {
    value.source_policy =
      "Unreviewed blogs and social posts are authoritative.";
  }],
  ["non-primary capability source", value => {
    value.sources[0].url = "https://example.com/not-primary";
  }],
  ["invented source support", value => {
    value.sources[0].supports = ["exact PDF Tools is production ready"];
  }],
  ["invented host verification", value => {
    value.hosts.find(host => host.id === "claude-cowork-remote-session")
      .status = "exact_pdf_tools_verified";
  }],
  ["laundered cross-host conclusion", value => {
    value.cross_host_conclusions[0].conclusion =
      "One bundle works everywhere.";
  }],
  ["conclusion without sources", value => {
    value.cross_host_conclusions[0].source_ids = [];
  }],
  ["source without a manual review receipt", value => {
    value.manual_review_receipts.pop();
  }],
];

describe("remote and hybrid architecture contract", () => {
  it("verifies the frozen architecture and preserves its evidence boundary", () => {
    const report = verifyRemoteHybridArchitecture(
      clone(CONTRACT),
      clone(LEDGER),
      ARCHITECTURE_DOCUMENT,
    );

    expect(report).toMatchObject({
      schema_version: "pdf-tools.remote-hybrid-architecture-verification.v1",
      as_of: "2026-07-30",
      verdict: "GO_ARCHITECTURE_WAIT_PRODUCTION",
      verification_scope:
        "normative_contract_and_manually_reviewed_source_ledger_consistency",
      source_truth_automated: false,
      authority_digests: {
        contract:
          "3783deb63beeb1fe48aa545ca58db861864ccb794a2c8fcc156f06a5b3999627",
        ledger:
          "ec610ad00ceabcee3625ba5483e676a55320001cec098f307e2dc078fc34b03e",
        architecture:
          "8be4894f05ad8bdeeb0fac1ed23d8aaf3801166bb0e8bbb5b6d2165122c6b46f",
      },
      negative_claims: {
        deployed_service: false,
        native_host_evidence: false,
        user_document_processing: false,
        universal_host_compatibility: false,
      },
    });
    expect(report.inventory).toEqual({
      modes: CONTRACT.modes.length,
      principals: CONTRACT.principals.length,
      controls: Object.values(CONTRACT.required_controls).flat().length,
      threats: CONTRACT.threat_register.length,
      p0_threats: CONTRACT.threat_register.filter(
        threat => threat.severity === "P0",
      ).length,
      production_flip_gates: CONTRACT.production_flip_gates.length,
      official_sources: LEDGER.sources.length,
      hosts: LEDGER.hosts.length,
    });
  });

  it.each(CONTRACT_MUTANTS)("rejects %s", (_label, mutate) => {
    const candidate = clone(CONTRACT);
    mutate(candidate);
    expect(() =>
      verifyRemoteHybridArchitecture(
        candidate,
        clone(LEDGER),
        ARCHITECTURE_DOCUMENT,
      )).toThrow();
  });

  it.each(LEDGER_MUTANTS)("rejects %s", (_label, mutate) => {
    const candidate = clone(LEDGER);
    mutate(candidate);
    expect(() =>
      verifyRemoteHybridArchitecture(
        clone(CONTRACT),
        candidate,
        ARCHITECTURE_DOCUMENT,
      )).toThrow();
  });

  it("rejects an ADR that weakens upload consent", () => {
    const candidate = ARCHITECTURE_DOCUMENT.replace(
      "Folder access does not imply upload consent.",
      "Folder access permits upload.",
    );
    expect(candidate).not.toBe(ARCHITECTURE_DOCUMENT);
    expect(() =>
      verifyRemoteHybridArchitecture(
        clone(CONTRACT),
        clone(LEDGER),
        candidate,
      )).toThrow(/upload consent/i);
  });

  it("rejects an append-only ADR tranche contradiction", () => {
    const candidate = `${ARCHITECTURE_DOCUMENT}
The team may launch an internet-accessible service and ingest customer documents in this tranche.
`;
    expect(() =>
      verifyRemoteHybridArchitecture(
        clone(CONTRACT),
        clone(LEDGER),
        candidate,
      )).toThrow(/architecture decision digest/i);
  });

  it("rejects an ADR that reverses the mock-only slice", () => {
    const candidate = ARCHITECTURE_DOCUMENT.replace(
      "It explicitly excludes a public listener, provider deployment, OAuth provider\nmutation, real authentication, user files, production storage, external\ndownloads, or local companion installation.",
      "Deploy publicly and accept real user PDFs.",
    );
    expect(candidate).not.toBe(ARCHITECTURE_DOCUMENT);
    expect(() =>
      verifyRemoteHybridArchitecture(
        clone(CONTRACT),
        clone(LEDGER),
        candidate,
      )).toThrow(/unsafe production|mock-only exclusion/i);
  });
});
