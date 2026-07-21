import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { validatePdfFormFields } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_W9 = path.join(REPO_ROOT, "example-fw9.pdf");
const RUNTIMES = [
  { name: "source", root: REPO_ROOT },
  { name: "share", root: path.join(REPO_ROOT, "pdf-toolkit-mcp-share") },
];

async function startRuntime(runtimeRoot, stateRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(runtimeRoot, "server", "index.js")],
    cwd: runtimeRoot,
    env: {
      ALLOWED_DIRECTORIES: [REPO_ROOT, stateRoot].join(path.delimiter),
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "pdf-tools-validation-truth-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function createSyntheticForm(pdfPath, { fillRequired = false } = {}) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();

  const requiredText = form.createTextField("required_text");
  requiredText.enableRequired();
  requiredText.addToPage(page, { x: 20, y: 700, width: 160, height: 20 });
  if (fillRequired) requiredText.setText("observed");

  const optionalText = form.createTextField("optional_text");
  optionalText.addToPage(page, { x: 20, y: 660, width: 160, height: 20 });
  optionalText.setText("   ");

  const requiredConsent = form.createCheckBox("consent_checkbox");
  requiredConsent.enableRequired();
  requiredConsent.addToPage(page, { x: 20, y: 620, width: 18, height: 18 });
  if (fillRequired) requiredConsent.check();

  const optionalChecked = form.createCheckBox("optional_checked");
  optionalChecked.addToPage(page, { x: 60, y: 620, width: 18, height: 18 });
  optionalChecked.check();

  const requiredRadio = form.createRadioGroup("required_radio");
  requiredRadio.enableRequired();
  requiredRadio.addOptionToPage("alpha", page, { x: 20, y: 580, width: 18, height: 18 });
  requiredRadio.addOptionToPage("beta", page, { x: 60, y: 580, width: 18, height: 18 });
  if (fillRequired) requiredRadio.select("alpha");

  const requiredDropdown = form.createDropdown("required_dropdown");
  requiredDropdown.enableRequired();
  requiredDropdown.setOptions(["alpha", "beta"]);
  requiredDropdown.addToPage(page, { x: 20, y: 540, width: 160, height: 20 });
  requiredDropdown.select("beta");

  const optionalList = form.createOptionList("optional_list");
  optionalList.setOptions(["alpha", "beta"]);
  optionalList.addToPage(page, { x: 20, y: 460, width: 160, height: 60 });

  await fs.writeFile(pdfPath, await document.save());
}

describe("validatePdfFormFields adversarial semantics", () => {
  it("cannot pass a missing required field by inflating observed counts", () => {
    class PDFTextField {
      constructor(name, value, required = false) {
        this.name = name;
        this.value = value;
        this.required = required;
      }
      getName() { return this.name; }
      getText() { return this.value; }
      isRequired() { return this.required; }
    }

    const fields = Array.from(
      { length: 50 },
      (_, index) => new PDFTextField(`optional_${index}`, "observed"),
    );
    fields.push(new PDFTextField("legal_name", "", true));

    const result = validatePdfFormFields(fields);
    expect(result).toMatchObject({
      observed_count: 50,
      filled_count: 50,
      missing_required_count: 1,
      required_fields_complete: false,
      validation_status: "incomplete",
      required_field_validation_status: "incomplete",
      can_claim_required_fields_complete: false,
      can_claim_form_ready: false,
    });
  });

  it("keeps name hints advisory and reports field read failures as indeterminate", () => {
    class PDFTextField {
      constructor(name, { text = "", required = false, failValue = false, failRequired = false } = {}) {
        this.name = name;
        this.text = text;
        this.required = required;
        this.failValue = failValue;
        this.failRequired = failRequired;
      }
      getName() { return this.name; }
      getText() {
        if (this.failValue) throw new Error("sensitive parser detail");
        return this.text;
      }
      isRequired() {
        if (this.failRequired) throw new Error("corrupt flags");
        return this.required;
      }
    }

    const result = validatePdfFormFields([
      new PDFTextField("required_by_name_only", { text: "", required: false }),
      new PDFTextField("actual_required_unreadable", { required: true, failValue: true }),
      new PDFTextField("unknown_requiredness", { text: "observed", failRequired: true }),
    ]);

    expect(result.heuristic_required_candidates).toEqual(expect.arrayContaining(["required_by_name_only"]));
    expect(result.missing_required_fields).not.toContain("required_by_name_only");
    expect(result).toMatchObject({
      validation_status: "indeterminate",
      required_field_validation_status: "indeterminate",
      validation_conclusive: false,
      required_fields_complete: null,
      read_error_count: 1,
      requiredness_unknown_count: 1,
      can_claim_required_fields_complete: false,
      error_codes: ["FIELD_READ_FAILED", "REQUIRED_FLAG_READ_FAILED"],
    });
    expect(JSON.stringify(result)).not.toContain("sensitive parser detail");
  });

  it("does not guess whether a signature or unknown field contains a value", () => {
    class PDFSignature {
      getName() { return "required_signature"; }
      isRequired() { return true; }
    }
    class VendorSpecificField {
      getName() { return "vendor_value"; }
      isRequired() { return false; }
    }

    const result = validatePdfFormFields([new PDFSignature(), new VendorSpecificField()]);
    expect(result).toMatchObject({
      validation_status: "indeterminate",
      required_field_validation_status: "indeterminate",
      unknown_count: 2,
      indeterminate_required_count: 1,
      required_fields_complete: null,
      all_value_fields_filled: null,
      can_claim_required_fields_complete: false,
      error_codes: ["VALUE_STATUS_UNAVAILABLE"],
    });
    expect(result.fields).toEqual([
      expect.objectContaining({ kind: "signature", value_status: "unknown", required_status: "unknown" }),
      expect.objectContaining({ kind: "unknown", value_status: "unknown", required_status: "not_required" }),
    ]);
  });

  it("does not call unreadable required flags absent", () => {
    class PDFTextField {
      getName() { return "opaque_flags"; }
      getText() { return "observed"; }
      isRequired() { throw new Error("bad flags"); }
    }
    const result = validatePdfFormFields([new PDFTextField()]);
    expect(result).toMatchObject({
      validation_status: "indeterminate",
      required_field_validation_status: "indeterminate",
      required_field_count: 0,
      requiredness_unknown_count: 1,
      required_fields_complete: null,
      can_claim_required_fields_complete: false,
    });
    expect(result.limitations.join(" ")).not.toContain("marks no fields Required");
  });
});

describe("validate_pdf truthful MCP contract", () => {
  let stateRoot;
  let partialFormPath;
  let completeRequiredPath;
  const runtimes = new Map();

  beforeAll(async () => {
    stateRoot = await createTestTempDirectory(REPO_ROOT, "validate-pdf");
    partialFormPath = path.join(stateRoot, "synthetic-partial.pdf");
    completeRequiredPath = path.join(stateRoot, "synthetic-required-complete.pdf");
    await createSyntheticForm(partialFormPath);
    await createSyntheticForm(completeRequiredPath, { fillRequired: true });
    for (const runtime of RUNTIMES) {
      runtimes.set(runtime.name, await startRuntime(runtime.root, stateRoot));
    }
  }, 30_000);

  afterAll(async () => {
    for (const runtime of runtimes.values()) {
      await runtime.client.close();
      await runtime.transport.close();
    }
    await removeTestTempDirectory(stateRoot);
  });

  it("keeps source and share results exactly identical", async () => {
    const results = [];
    for (const runtime of runtimes.values()) {
      results.push(await runtime.client.callTool({
        name: "validate_pdf",
        arguments: { pdf_path: partialFormPath },
      }));
    }
    expect(results[1]).toEqual(results[0]);
  });

  it.each(RUNTIMES)("$name honors text, checkbox, radio, dropdown, option-list, and Required flags", async ({ name }) => {
    const result = await runtimes.get(name).client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: partialFormPath },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema_version: "1.0",
      pdf_path: partialFormPath,
      file_name: "synthetic-partial.pdf",
      validation_status: "incomplete",
      required_field_validation_status: "incomplete",
      validation_conclusive: true,
      required_fields_complete: false,
      all_value_fields_filled: false,
      can_claim_required_fields_complete: false,
      can_claim_form_ready: false,
      total_field_count: 7,
      observed_count: 2,
      empty_count: 4,
      unchecked_count: 1,
      required_field_count: 4,
      missing_required_count: 3,
      read_error_count: 0,
    });
    expect(result.structuredContent.missing_required_fields).toEqual([
      "required_text",
      "consent_checkbox",
      "required_radio",
    ]);
    expect(result.structuredContent.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "required_text", kind: "text", value_status: "empty", required_status: "missing" }),
      expect.objectContaining({ name: "consent_checkbox", kind: "checkbox", value_status: "unchecked", required_status: "missing" }),
      expect.objectContaining({ name: "required_radio", kind: "radio", value_status: "empty", required_status: "missing" }),
      expect.objectContaining({ name: "required_dropdown", kind: "dropdown", value_status: "observed", required_status: "satisfied" }),
      expect.objectContaining({ name: "optional_list", kind: "option_list", value_status: "empty", required_status: "not_required" }),
    ]));
    expect(result.content[0].text).toContain("Required fields complete: NO");
    expect(result.content[0].text).toContain("Safe claim unavailable");
    expect(result.content[0].text).toContain("does not prove the form is valid or ready to submit");
  });

  it.each(RUNTIMES)("$name allows only the bounded actual-Required claim", async ({ name }) => {
    const result = await runtimes.get(name).client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: completeRequiredPath },
    });
    expect(result.structuredContent).toMatchObject({
      validation_status: "partial",
      required_field_validation_status: "complete",
      required_fields_complete: true,
      all_value_fields_filled: false,
      can_claim_required_fields_complete: true,
      can_claim_form_ready: false,
      required_field_count: 4,
      missing_required_count: 0,
    });
    expect(result.content[0].text).toContain("Safe claim: all fields marked Required by the PDF are complete.");
  });

  it.each(RUNTIMES)("$name reports the real W-9 without counting unchecked boxes as filled", async ({ name }) => {
    const result = await runtimes.get(name).client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: EXAMPLE_W9 },
    });
    expect(result.structuredContent).toMatchObject({
      total_field_count: 22,
      observed_count: 13,
      filled_count: 13,
      empty_count: 2,
      unchecked_count: 7,
      required_field_count: 0,
      all_value_fields_filled: false,
      validation_status: "partial",
      required_field_validation_status: "no_required_flags",
      required_fields_complete: null,
      can_claim_required_fields_complete: false,
      can_claim_form_ready: false,
    });
    expect(result.content[0].text).toContain("Unchecked boxes: 7");
    expect(result.content[0].text).toContain("marks no fields Required");
  });

  it.each(RUNTIMES)("$name returns a stable failed structure for unreadable PDFs", async ({ name }) => {
    const missingPath = path.join(stateRoot, "missing.pdf");
    const result = await runtimes.get(name).client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: missingPath },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema_version: "1.0",
      validation_status: "failed",
      required_field_validation_status: "failed",
      validation_conclusive: false,
      required_fields_complete: null,
      can_claim_required_fields_complete: false,
      can_claim_form_ready: false,
      error_codes: ["PDF_VALIDATION_FAILED"],
    });
    expect(result.content[0].text).toContain("Do not interpret this as an empty or complete form");
  });

  it.each(RUNTIMES)("$name never reports an empty AcroForm as complete", async ({ name }) => {
    const noFieldsPath = path.join(stateRoot, "no-fields.pdf");
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    await fs.writeFile(noFieldsPath, await document.save());

    const result = await runtimes.get(name).client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: noFieldsPath },
    });
    expect(result.structuredContent).toMatchObject({
      validation_status: "no_fields",
      required_field_validation_status: "no_fields",
      validation_conclusive: false,
      has_form_fields: false,
      required_fields_complete: null,
      all_value_fields_filled: null,
      can_claim_required_fields_complete: false,
      can_claim_form_ready: false,
      total_field_count: 0,
    });
    expect(result.content[0].text).toContain("Field coverage status: NO_FIELDS");
    expect(result.content[0].text).not.toMatch(/Status: COMPLETE/i);
    expect(result.content[0].text).toContain("Safe claim unavailable");
  });
});
