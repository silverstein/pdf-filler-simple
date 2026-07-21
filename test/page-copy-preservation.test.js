import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  copyPdfDocumentMetadata,
  copyPdfPagesPreservingForms,
} from "../server/helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPARISON_FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "synthetic", "comparison-base.pdf");

async function roundTrip(document) {
  return PDFDocument.load(await document.save());
}

describe("page-copy document preservation", () => {
  it("rebinds a copied widget to its reordered output page and preserves metadata", async () => {
    const source = await PDFDocument.load(await fs.readFile(COMPARISON_FIXTURE));
    const target = await PDFDocument.create();
    copyPdfDocumentMetadata(target, source);
    await copyPdfPagesPreservingForms(target, source, [1, 0]);

    const output = await roundTrip(target);
    const fields = output.getForm().getFields();
    expect(fields.map(field => field.getName())).toEqual(["ReviewStatus"]);
    const widgets = fields[0].acroField.getWidgets();
    expect(widgets).toHaveLength(1);
    expect(widgets[0].P()?.toString()).toBe(output.getPage(1).ref.toString());
    expect(output.getTitle()).toBe(source.getTitle());
    expect(output.getAuthor()).toBe(source.getAuthor());
    expect(output.getSubject()).toBe(source.getSubject());
    expect(output.getKeywords()).toBe(source.getKeywords());
    expect(output.getCreator()).toBe(source.getCreator());
    expect(output.getCreationDate().toISOString()).toBe(source.getCreationDate().toISOString());
  });

  it("does not retain a field whose only widget was on an omitted page", async () => {
    const source = await PDFDocument.load(await fs.readFile(COMPARISON_FIXTURE));
    const target = await PDFDocument.create();
    await copyPdfPagesPreservingForms(target, source, [1]);
    const output = await roundTrip(target);
    expect(output.getForm().getFields()).toEqual([]);
  });

  it("prunes omitted widgets and hierarchical sibling fields", async () => {
    const source = await PDFDocument.create();
    const firstPage = source.addPage([400, 500]);
    const secondPage = source.addPage([400, 500]);
    const form = source.getForm();
    const shared = form.createTextField("Shared");
    shared.addToPage(firstPage, { x: 20, y: 420, width: 120, height: 24 });
    shared.addToPage(secondPage, { x: 20, y: 420, width: 120, height: 24 });
    form.createTextField("Group.First").addToPage(firstPage, { x: 20, y: 370, width: 120, height: 24 });
    form.createTextField("Group.Second").addToPage(secondPage, { x: 20, y: 370, width: 120, height: 24 });
    const reloadedSource = await roundTrip(source);

    const target = await PDFDocument.create();
    await copyPdfPagesPreservingForms(target, reloadedSource, [0]);
    const output = await roundTrip(target);
    const fields = output.getForm().getFields();
    expect(fields.map(field => field.getName()).sort()).toEqual(["Group.First", "Shared"]);
    for (const field of fields) {
      expect(field.acroField.getWidgets()).toHaveLength(1);
      expect(field.acroField.getWidgets()[0].P()?.toString()).toBe(output.getPage(0).ref.toString());
    }
  });
});
