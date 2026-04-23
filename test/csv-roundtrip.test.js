import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const CSV_FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "claude-batch3-bulk.csv");
const TMP_DIR = path.join(REPO_ROOT, ".test-tmp-csv-roundtrip");
const STREET_FIELD = "topmostSubform[0].Page1[0].Address[0].f1_7[0]";
const CITY_FIELD = "topmostSubform[0].Page1[0].Address[0].f1_8[0]";

describe("CSV form workflows", () => {
  let client;
  let transport;
  let pdfPath;

  beforeAll(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    pdfPath = path.join(TMP_DIR, "w9-form-source.pdf");
    await fs.copyFile(EXAMPLE_PDF, pdfPath);

    client = new Client({ name: "pdf-tools-csv-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: REPO_ROOT,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await transport?.close();
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it("preserves quoted commas through bulk_fill_from_csv and extract_to_csv", async () => {
    const bulk = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: pdfPath,
        csv_path: CSV_FIXTURE,
        output_directory: TMP_DIR,
        force_xfa: true,
      },
    });

    expect(bulk.structuredContent).toMatchObject({
      row_count: 2,
    });
    expect(bulk.structuredContent.preview_records[0][STREET_FIELD]).toBe("789 Comma Blvd, Suite 5");
    expect(bulk.structuredContent.preview_records[0][CITY_FIELD]).toBe("Comma City, CA 90001");

    const extractedPath = path.join(TMP_DIR, "bulk-extracted.csv");
    const extracted = await client.callTool({
      name: "extract_to_csv",
      arguments: {
        pdf_paths: [path.join(TMP_DIR, "filled_1.pdf")],
        output_csv: extractedPath,
      },
    });

    expect(extracted.structuredContent.preview_rows[0][STREET_FIELD]).toBe("789 Comma Blvd, Suite 5");
    expect(extracted.structuredContent.preview_rows[0][CITY_FIELD]).toBe("Comma City, CA 90001");
    expect(extracted.structuredContent.row_count).toBe(1);
    expect(extracted.structuredContent.preview_row_count).toBe(1);
    expect(extracted.structuredContent.rows).toBeUndefined();

    const csv = await fs.readFile(extractedPath, "utf8");
    expect(csv).toContain('"789 Comma Blvd, Suite 5"');
    expect(csv).not.toContain('""789 Comma Blvd"');
    expect(csv).not.toContain('Suite 5""');
  }, 30_000);

  it("handles CRLF and escaped quotes in CSV input and output", async () => {
    const csvPath = path.join(TMP_DIR, "quoted-crlf.csv");
    await fs.writeFile(
      csvPath,
      [
        `\uFEFF"${STREET_FIELD}","${CITY_FIELD}","topmostSubform[0].Page1[0].f1_1[0]"`,
        `"123 ""Quoted"" Lane, Suite 9","Quote City, CA 90002","Acme ""Quoted"" LLC"`,
      ].join("\r\n")
    );

    const bulk = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: pdfPath,
        csv_path: csvPath,
        output_directory: TMP_DIR,
        force_xfa: true,
      },
    });

    expect(bulk.structuredContent.preview_records[0][STREET_FIELD]).toBe('123 "Quoted" Lane, Suite 9');
    expect(bulk.structuredContent.preview_records[0][CITY_FIELD]).toBe("Quote City, CA 90002");

    const extractedPath = path.join(TMP_DIR, "quoted-crlf-extracted.csv");
    await client.callTool({
      name: "extract_to_csv",
      arguments: {
        pdf_paths: [path.join(TMP_DIR, "filled_1.pdf")],
        output_csv: extractedPath,
      },
    });

    const csv = await fs.readFile(extractedPath, "utf8");
    expect(csv).toContain('"123 ""Quoted"" Lane, Suite 9"');
    expect(csv).toContain('"Acme ""Quoted"" LLC"');
  }, 30_000);

  it("rejects malformed CSV rows instead of silently shifting field values", async () => {
    const csvPath = path.join(TMP_DIR, "malformed-width.csv");
    await fs.writeFile(
      csvPath,
      `${STREET_FIELD},${CITY_FIELD}\n789 Comma Blvd, Suite 5,Comma City CA`
    );

    const result = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: pdfPath,
        csv_path: csvPath,
        output_directory: TMP_DIR,
        force_xfa: true,
      },
    });

    expect(result.content[0].text).toContain("Error: Malformed CSV: row 2 has 3 values, expected 2");
  }, 30_000);
});
