#!/usr/bin/env node

import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve(process.argv[2] || "macos-claude-host-fixtures");
await mkdir(outputDirectory, { recursive: true });

const textDocument = await PDFDocument.create();
const font = await textDocument.embedFont(StandardFonts.Helvetica);
const firstPage = textDocument.addPage([612, 792]);
firstPage.drawText("PDF Tools macOS host validation", {
  x: 72,
  y: 700,
  size: 22,
  font,
  color: rgb(0.08, 0.2, 0.4),
});
firstPage.drawText("Synthetic text fixture marker: BLUEHARBOR-TEXT-20260721", {
  x: 72,
  y: 650,
  size: 12,
  font,
});
firstPage.drawText("Page 1 of 2. Public-safe generated content only.", {
  x: 72,
  y: 620,
  size: 12,
  font,
});
const secondPage = textDocument.addPage([792, 612]);
secondPage.drawText("Synthetic mutation verification page", {
  x: 72,
  y: 520,
  size: 22,
  font,
});
secondPage.drawText("Marker: BLUEHARBOR-PAGE-TWO", {
  x: 72,
  y: 480,
  size: 12,
  font,
});
await writeFile(
  path.join(outputDirectory, "synthetic-text-two-page.pdf"),
  await textDocument.save(),
);

const canvas = createCanvas(1224, 1584);
const context = canvas.getContext("2d");
context.fillStyle = "#ffffff";
context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = "#17365d";
context.font = "bold 48px sans-serif";
context.fillText("PDF Tools macOS host validation", 120, 220);
context.fillStyle = "#111111";
context.font = "32px sans-serif";
context.fillText("Synthetic raster fixture", 120, 310);
context.fillText("Marker: BLUEHARBOR-RASTER-20260721", 120, 390);
context.fillText("This page intentionally has no PDF text layer.", 120, 470);
context.strokeStyle = "#2673c9";
context.lineWidth = 8;
context.strokeRect(100, 140, 1024, 420);

const rasterDocument = await PDFDocument.create();
const rasterPage = rasterDocument.addPage([612, 792]);
const rasterImage = await rasterDocument.embedPng(canvas.toBuffer("image/png"));
rasterPage.drawImage(rasterImage, { x: 0, y: 0, width: 612, height: 792 });
await writeFile(
  path.join(outputDirectory, "synthetic-raster-only.pdf"),
  await rasterDocument.save(),
);

process.stdout.write(`${outputDirectory}\n`);
