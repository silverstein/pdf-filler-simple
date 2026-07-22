#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "partial";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);

function token(value) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function leaves(schema, pointer = "") {
  if (schema.type === "object") {
    return Object.keys(schema.properties).sort().flatMap(name => leaves(schema.properties[name], `${pointer}/${token(name)}`));
  }
  return [pointer || "/"];
}

const requestedLeaves = leaves(request.task.target_schema);
const partialGaps = requestedLeaves
  .filter(fieldPath => fieldPath !== "/vendor")
  .map(fieldPath => ({ field_path: fieldPath, reason: "insufficient_evidence", detail: "Test double intentionally leaves this field unresolved" }));

function baseResponse(overrides = {}) {
  return {
    protocol: request.protocol,
    request_id: request.request_id,
    status: "partial",
    decision: "answer",
    structured_candidate: { vendor: "fixture-value" },
    page_texts: [{
      page: 1,
      text: "candidate text",
      text_kind: "visual_parser",
      source_item_ids: [],
      origin: { engine_id: "phase1-test-double", engine_version: "1.0.0" },
    }],
    tables: [],
    native_evidence: [],
    evidence: [],
    field_evidence: [],
    gaps: partialGaps,
    diagnostics: { code: null, message: String(process.pid) },
    ...overrides,
  };
}

if (mode === "oversize") {
  process.stdout.write("x".repeat(8192));
} else if (mode === "multiple-json") {
  process.stdout.write(`${JSON.stringify(baseResponse())}\n${JSON.stringify(baseResponse())}`);
} else if (mode === "wrong-request") {
  process.stdout.write(JSON.stringify(baseResponse({ request_id: "0".repeat(64) })));
} else if (mode === "born-digital-direct") {
  const response = baseResponse();
  response.page_texts[0].text_kind = "born_digital_text_layer";
  response.page_texts[0].source_item_ids = ["unbound.item"];
  process.stdout.write(JSON.stringify(response));
} else if (mode === "evidence") {
  const response = baseResponse({
    evidence: [{
      id: "evidence.1",
      page: 1,
      coordinate_space: "pdf-tools.display-top-left-points.v1",
      bbox: { x: 10, y: 10, width: 50, height: 12 },
      source_item_ids: ["item.1"],
      quote: "fixture-value",
    }],
    field_evidence: [{ field_path: "/vendor", evidence_ids: ["evidence.1"] }],
  });
  process.stdout.write(JSON.stringify(response));
} else if (mode === "native-evidence") {
  const response = baseResponse({
    native_evidence: [{
      id: "native.1",
      page: 1,
      coordinate_space: "test-engine.bottom-left-points.v1",
      bbox: { x: 10, y: 10, width: 50, height: 12 },
      native_ref: "#/texts/0",
      quote: "fixture-value",
      origin: { engine_id: "phase1-test-double", engine_version: "1.0.0" },
      page_geometry: { width: 612, height: 792, rotation: 0, box_basis: "media_box", user_unit_handling: "unknown" },
    }],
  });
  process.stdout.write(JSON.stringify(response));
} else if (mode === "completed") {
  process.stdout.write(JSON.stringify(baseResponse({
    status: "completed",
    structured_candidate: {
      invoice_id: "candidate-value",
      vendor: "candidate-value",
      invoice_date: "candidate-value",
      total: { currency: "USD", amount: 0 },
    },
    gaps: [],
  })));
} else if (mode === "mutate") {
  fs.chmodSync(request.source.path, 0o644);
  fs.writeFileSync(request.source.path, "changed by test double");
  process.stdout.write(JSON.stringify(baseResponse()));
} else if (mode === "timeout-tree") {
  const sentinelPath = process.argv[3];
  spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{}); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'escaped'), 500); setInterval(()=>{}, 1000)`], {
    stdio: "ignore",
  });
  setInterval(() => {}, 1000);
} else if (mode === "abstain") {
  process.stdout.write(JSON.stringify(baseResponse({
    status: "abstained",
    decision: "abstain",
    structured_candidate: null,
    page_texts: [],
    gaps: requestedLeaves.map(fieldPath => ({ field_path: fieldPath, reason: "unsupported_modality", detail: "Test double abstention" })),
  })));
} else {
  process.stdout.write(JSON.stringify(baseResponse()));
}
