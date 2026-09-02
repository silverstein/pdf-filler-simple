import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, degrees } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PRIVATE_VALUE = "PRIVATE-ACCOUNT-4471";
const RUNTIMES = [
  { name: "source runtime", root: REPO_ROOT },
  { name: "share runtime", root: path.join(REPO_ROOT, "pdf-toolkit-mcp-share") },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function createSigningFixture(filename) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  page.setMediaBox(40, 60, 612, 792);
  page.setCropBox(52, 72, 588, 756);
  page.setRotation(degrees(90));
  const field = document.getForm().createTextField("account_number");
  field.addToPage(page, { x: 90, y: 690, width: 180, height: 20 });
  await fs.writeFile(filename, await document.save({ useObjectStreams: false }));
}

async function expectMissing(filename) {
  await expect(fs.access(filename)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.each(RUNTIMES)("$name provider-neutral signing preparation receipt", ({ root }) => {
  let client;
  let fixturePath;
  let oversizedPageFixture;
  let stateRoot;
  let transport;

  beforeAll(async () => {
    stateRoot = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-signing-receipt-")),
    );
    fixturePath = path.join(stateRoot, "source.pdf");
    await createSigningFixture(fixturePath);
    oversizedPageFixture = path.join(stateRoot, "too-many-pages.pdf");
    const oversized = await PDFDocument.create();
    for (let page = 0; page < 1001; page += 1) oversized.addPage([72, 72]);
    await fs.writeFile(oversizedPageFixture, await oversized.save({ useObjectStreams: false }));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "server", "index.js")],
      cwd: root,
      env: {
        ALLOWED_DIRECTORIES: stateRoot,
        DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      },
      stderr: "ignore",
    });
    client = new Client({ name: "signing-preparation-receipt-test", version: "1.0.0" });
    await client.connect(transport);
    await client.listTools();
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("binds a provider-ready local artifact without exposing field values", async () => {
    const outputPath = path.join(stateRoot, "ready.pdf");
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: fixturePath,
        output_path: outputPath,
        field_values: { account_number: PRIVATE_VALUE },
        require_provider_ready: true,
        signature_locations: [{
          zone_id: "applicant-signature",
          field_type: "signature",
          participant_id: "applicant-1",
          participant_role: "applicant",
          evidence_source: "detect_signature_zones",
          label: "Applicant signature",
          page: 1,
          x: 72,
          y: 600,
          width: 180,
          height: 40,
        }],
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const receipt = result.structuredContent.preparation_receipt;
    const canonicalFixturePath = await fs.realpath(fixturePath);
    const canonicalOutputPath = await fs.realpath(outputPath);
    expect(receipt).toMatchObject({
      schema_version: "1.0",
      preparation_engine: "pdf-tools.prepare-signing-packet.v1",
      source_document: {
        canonical_path: canonicalFixturePath,
        sha256: sha256(await fs.readFile(fixturePath)),
        identity_method: "race_aware_descriptor_sha256",
      },
      prepared_document: {
        canonical_path: canonicalOutputPath,
        sha256: sha256(await fs.readFile(outputPath)),
        identity_method: "race_aware_descriptor_sha256",
      },
      source_preservation: {
        mode: "source_path_unchanged",
        source_path_reverified_after_commit: true,
        backup_identity_verified_after_commit: false,
        backup_path: null,
        backup_document: null,
      },
      output_commit: {
        status: "committed",
        target_mode: "new_path",
        source_binding_verified_at_commit: true,
        prepared_identity_verified_after_commit: true,
      },
      page_count: 1,
      field_outcomes: [{
        field_name: "account_number",
        status: "written",
        reason_code: null,
      }],
      zones: [{
        zone_id: "applicant-signature",
        field_type: "signature",
        participant_binding: {
          status: "bound",
          participant_id: "applicant-1",
          participant_role: "applicant",
        },
        native_region: { x: 72, y: 600, width: 180, height: 40 },
        display_region: { x: 140, y: 60, width: 40, height: 180 },
        visibility_status: "visible",
        evidence_binding_status: "caller_declared",
      }],
      handoff_status: "ready_for_provider_mapping",
      missing_inputs: [],
      provider_execution_status: "not_requested",
    });
    expect(receipt.pages[0]).toEqual({
      page: 1,
      rotation_degrees: 90,
      media_box: { origin_x: 40, origin_y: 60, width: 612, height: 792 },
      crop_box: { origin_x: 52, origin_y: 72, width: 588, height: 756 },
    });
    expect(JSON.stringify(receipt)).not.toContain(PRIVATE_VALUE);
    const { receipt_sha256: observedDigest, ...digestInput } = receipt;
    expect(observedDigest).toBe(sha256(Buffer.from(
      `pdf-tools.signing-preparation-receipt.v1\0${canonicalJson(digestInput)}`,
      "utf8",
    )));
    expect(result.structuredContent.pending_signatures).toEqual([{
      label: "Applicant signature",
      page: 1,
      x: 72,
      y: 600,
      width: 180,
      height: 40,
    }]);
  }, 30_000);

  it("keeps legacy locations compatible while reporting an incomplete handoff", async () => {
    const outputPath = path.join(stateRoot, "legacy.pdf");
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: fixturePath,
        output_path: outputPath,
        signature_locations: [{ page: 1, x: 72, y: 600, width: 180, height: 40 }],
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent.preparation_receipt).toMatchObject({
      handoff_status: "incomplete",
      provider_execution_status: "not_requested",
      zones: [{
        zone_id: expect.stringMatching(/^zone-[a-f0-9]{64}$/),
        field_type: "unspecified",
        participant_binding: { status: "unbound" },
      }],
      missing_inputs: expect.arrayContaining([
        { code: "ZONE_TYPE_UNSPECIFIED", zone_id: expect.any(String), field_name: null },
        { code: "ZONE_PARTICIPANT_BINDING_MISSING", zone_id: expect.any(String), field_name: null },
      ]),
    });
  }, 30_000);

  it("binds same-document preparation to the immutable-original backup path", async () => {
    const samePath = path.join(stateRoot, "same-document.pdf");
    await fs.copyFile(fixturePath, samePath);
    const sourceSha256 = sha256(await fs.readFile(samePath));
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: samePath,
        output_path: samePath,
        signature_locations: [{ page: 1, x: 72, y: 600, width: 180, height: 40 }],
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const receipt = result.structuredContent.preparation_receipt;
    const canonicalSamePath = await fs.realpath(samePath);
    expect(receipt).toMatchObject({
      source_document: { canonical_path: canonicalSamePath, sha256: sourceSha256 },
      prepared_document: {
        canonical_path: canonicalSamePath,
        sha256: sha256(await fs.readFile(samePath)),
      },
      source_preservation: {
        mode: "same_document_immutable_original_backup",
        source_path_reverified_after_commit: false,
        backup_identity_verified_after_commit: true,
        backup_path: expect.any(String),
        backup_document: {
          canonical_path: expect.any(String),
          size_bytes: expect.any(Number),
          sha256: sourceSha256,
          identity_method: "immutable_original_backup_record_sha256",
        },
      },
      output_commit: { target_mode: "same_document" },
    });
    await expect(fs.stat(receipt.source_preservation.backup_path)).resolves.toMatchObject({
      size: expect.any(Number),
    });
    expect(receipt.source_preservation.backup_document.canonical_path)
      .toBe(receipt.source_preservation.backup_path);
    expect(receipt.source_preservation.backup_document.size_bytes)
      .toBe((await fs.stat(receipt.source_preservation.backup_path)).size);
    expect(sha256(await fs.readFile(receipt.source_preservation.backup_path))).toBe(sourceSha256);
  }, 30_000);

  it("retains a typed crop-visibility gap for legacy preparation", async () => {
    const outputPath = path.join(stateRoot, "legacy-clipped.pdf");
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: fixturePath,
        output_path: outputPath,
        signature_locations: [{
          zone_id: "crop-clipped",
          field_type: "signature",
          participant_id: "applicant-1",
          participant_role: "applicant",
          page: 1,
          x: 0,
          y: 0,
          width: 20,
          height: 20,
        }],
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent.preparation_receipt).toMatchObject({
      handoff_status: "incomplete",
      zones: [{
        zone_id: "crop-clipped",
        visibility_status: "outside_crop_box",
      }],
      missing_inputs: [{
        code: "ZONE_OUTSIDE_CROP_BOX",
        zone_id: "crop-clipped",
        field_name: null,
      }],
    });
  }, 30_000);

  it("fails closed on unbound readiness, duplicate zones, unknown keys, and out-of-bounds geometry", async () => {
    const cases = [
      {
        name: "unbound",
        arguments: {
          require_provider_ready: true,
          signature_locations: [{ page: 1, x: 72, y: 600, width: 180, height: 40 }],
        },
      },
      {
        name: "duplicate",
        arguments: {
          signature_locations: [
            { zone_id: "same", page: 1, x: 72, y: 600, width: 180, height: 40 },
            { zone_id: "same", page: 1, x: 20, y: 20, width: 100, height: 30 },
          ],
        },
      },
      {
        name: "duplicate-binding",
        arguments: {
          signature_locations: [
            { zone_id: "first", page: 1, x: 72, y: 600, width: 180, height: 40 },
            { zone_id: "second", page: 1, x: 72, y: 600, width: 180, height: 40 },
          ],
        },
      },
      {
        name: "partial-participant",
        arguments: {
          require_provider_ready: true,
          signature_locations: [{
            zone_id: "partial",
            field_type: "signature",
            participant_id: "applicant-1",
            page: 1,
            x: 72,
            y: 600,
            width: 180,
            height: 40,
          }],
        },
      },
      {
        name: "unknown",
        arguments: {
          signature_locations: [{ page: 1, x: 72, y: 600, width: 180, height: 40, provider_field: true }],
        },
      },
      {
        name: "unknown-top-level",
        arguments: {
          provider_transport: true,
          signature_locations: [],
        },
      },
      {
        name: "malformed-id",
        arguments: {
          signature_locations: [{
            zone_id: "person@example.com",
            page: 1,
            x: 72,
            y: 600,
            width: 180,
            height: 40,
          }],
        },
      },
      {
        name: "unsupported-type",
        arguments: {
          signature_locations: [{
            field_type: "cryptographic_signature",
            page: 1,
            x: 72,
            y: 600,
            width: 180,
            height: 40,
          }],
        },
      },
      {
        name: "outside",
        arguments: {
          signature_locations: [{ page: 1, x: 590, y: 760, width: 100, height: 40 }],
        },
      },
      {
        name: "crop-clipped-readiness",
        arguments: {
          require_provider_ready: true,
          signature_locations: [{
            zone_id: "clipped",
            field_type: "signature",
            participant_id: "applicant-1",
            participant_role: "applicant",
            page: 1,
            x: 0,
            y: 0,
            width: 20,
            height: 20,
          }],
        },
      },
    ];
    for (const testCase of cases) {
      const outputPath = path.join(stateRoot, `${testCase.name}.pdf`);
      const result = await client.callTool({
        name: "prepare_signing_packet",
        arguments: {
          pdf_path: fixturePath,
          output_path: outputPath,
          ...testCase.arguments,
        },
      });
      expect(result.isError, testCase.name).toBe(true);
      await expectMissing(outputPath);
    }
  }, 30_000);

  it("does not commit a provider-ready packet when a requested field write fails", async () => {
    const outputPath = path.join(stateRoot, "failed-field.pdf");
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: fixturePath,
        output_path: outputPath,
        field_values: { missing_field: PRIVATE_VALUE },
        require_provider_ready: true,
        signature_locations: [{
          zone_id: "applicant-signature",
          field_type: "signature",
          participant_id: "applicant-1",
          participant_role: "applicant",
          page: 1,
          x: 72,
          y: 600,
          width: 180,
          height: 40,
        }],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    await expectMissing(outputPath);
  }, 30_000);

  it("rejects a packet beyond the page-accounting limit before committing output", async () => {
    const outputPath = path.join(stateRoot, "too-many-pages-output.pdf");
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: oversizedPageFixture,
        output_path: outputPath,
        signature_locations: [],
      },
    });
    expect(result.isError).toBe(true);
    await expectMissing(outputPath);
  }, 30_000);
});
