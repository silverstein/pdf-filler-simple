import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";
import { extractComparisonText, renderComparisonPage } from "./comparison-observations.js";

const runFile = promisify(execFile);
const METADATA_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function refId(context, value) {
  const direct = value?.toString?.() ?? null;
  if (direct && /^\d+ \d+ R$/.test(direct)) return direct;
  return context.getObjectRef(value instanceof PDFDict ? value : value?.dict)?.toString?.() ?? direct;
}

function decodeString(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return value?.toString?.() ?? null;
}

function number(context, value) {
  return context.lookup(value, PDFNumber)?.asNumber() ?? null;
}

function numberArray(context, value) {
  const array = context.lookup(value, PDFArray);
  if (!array) return null;
  return array.asArray().map(item => number(context, item));
}

function topLeftRegion(page, rectangle) {
  if (!rectangle || rectangle.length !== 4 || rectangle.some(value => !Number.isFinite(value))) return null;
  const media = page.getMediaBox();
  return [
    rectangle[0] - media.x,
    media.height - (rectangle[3] - media.y),
    rectangle[2] - rectangle[0],
    rectangle[3] - rectangle[1],
  ];
}

function fieldValue(field) {
  if (typeof field.getText === "function") return field.getText() ?? "";
  if (typeof field.isChecked === "function") return field.isChecked();
  if (typeof field.getSelected === "function") return field.getSelected();
  return null;
}

function widgetInventory(pdf, field, pagesByWidget) {
  return field.acroField.getWidgets().map(widget => {
    const reference = refId(pdf.context, widget.dict);
    const rectangle = widget.getRectangle();
    const pages = pagesByWidget.get(reference) ?? [];
    const page = pages.length === 1 ? pdf.getPages()[pages[0] - 1] : null;
    return {
      ref: reference,
      pages,
      region: page ? topLeftRegion(page, [rectangle.x, rectangle.y, rectangle.x + rectangle.width, rectangle.y + rectangle.height]) : null,
      appearance_state: widget.getAppearanceState?.()?.toString?.() ?? null,
      has_normal_appearance: widget.getNormalAppearance?.() !== undefined,
    };
  });
}

function catalogPresence(pdf) {
  const keys = ["AcroForm", "Metadata", "Names", "Outlines", "StructTreeRoot", "MarkInfo", "PageLabels", "ViewerPreferences", "OpenAction"];
  return Object.fromEntries(keys.map(key => [key, pdf.catalog.has(PDFName.of(key))]));
}

export async function inspectFidelityDocument(filePath, renderer = { scale: 2 }) {
  const bytes = await fs.readFile(filePath);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const textPages = await extractComparisonText(bytes);
  const pages = pdf.getPages();
  const rawAnnotations = [];
  const pagesByWidget = new Map();
  const duplicatePageWidgetRefs = [];
  for (const [pageIndex, page] of pages.entries()) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    const seenOnPage = new Set();
    for (const item of annots.asArray()) {
      const dictionary = pdf.context.lookup(item, PDFDict);
      if (!dictionary) continue;
      const reference = refId(pdf.context, item) ?? refId(pdf.context, dictionary);
      const subtype = dictionary.get(PDFName.of("Subtype"))?.toString() ?? null;
      if (subtype === "/Widget") {
        if (seenOnPage.has(reference)) duplicatePageWidgetRefs.push(reference);
        seenOnPage.add(reference);
        pagesByWidget.set(reference, [...(pagesByWidget.get(reference) ?? []), pageIndex + 1]);
      }
      const rectangle = numberArray(pdf.context, dictionary.get(PDFName.of("Rect")));
      rawAnnotations.push({
        ref: reference,
        page: pageIndex + 1,
        subtype,
        region: topLeftRegion(page, rectangle),
        flags: number(pdf.context, dictionary.get(PDFName.of("F"))),
        contents: decodeString(dictionary.get(PDFName.of("Contents"))),
        has_appearance: dictionary.has(PDFName.of("AP")),
        action: dictionary.get(PDFName.of("A"))?.toString?.() ?? null,
        destination: dictionary.get(PDFName.of("Dest"))?.toString?.() ?? null,
      });
    }
  }

  const fields = pdf.getForm().getFields().map(field => ({
    name: field.getName(),
    type: field.constructor.name,
    value: fieldValue(field),
    flags: field.acroField.getFlags?.() ?? null,
    widgets: widgetInventory(pdf, field, pagesByWidget),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const fieldWidgetRefs = fields.flatMap(field => field.widgets.map(widget => widget.ref));
  const rawWidgetRefs = rawAnnotations.filter(annotation => annotation.subtype === "/Widget").map(annotation => annotation.ref);
  const orphanRawWidgetRefs = [...new Set(rawWidgetRefs.filter(reference => !fieldWidgetRefs.includes(reference)))];
  const missingFieldWidgetRefs = [...new Set(fieldWidgetRefs.filter(reference => !rawWidgetRefs.includes(reference)))];
  const multiplyPlacedFieldWidgetRefs = [...new Set(fields.flatMap(field => field.widgets)
    .filter(widget => widget.pages.length !== 1).map(widget => widget.ref))];

  const metadata = {
    Title: pdf.getTitle() ?? null,
    Author: pdf.getAuthor() ?? null,
    Subject: pdf.getSubject() ?? null,
    Keywords: pdf.getKeywords() ?? null,
    Creator: pdf.getCreator() ?? null,
    Producer: pdf.getProducer() ?? null,
    CreationDate: pdf.getCreationDate()?.toISOString() ?? null,
    ModDate: pdf.getModificationDate()?.toISOString() ?? null,
  };
  for (const key of METADATA_KEYS) if (!Object.hasOwn(metadata, key)) metadata[key] = null;

  const renders = [];
  for (let pageNumber = 1; pageNumber <= pages.length; pageNumber += 1) {
    renders.push(await renderComparisonPage(bytes, pageNumber, renderer));
  }
  return {
    path: filePath,
    sha256: sha256(bytes),
    size: bytes.length,
    page_count: pages.length,
    pages: pages.map((page, index) => ({
      page: index + 1,
      media_box: Object.values(page.getMediaBox()),
      crop_box: Object.values(page.getCropBox()),
      rotation: page.getRotation().angle,
      user_unit: number(pdf.context, page.node.get(PDFName.of("UserUnit"))) ?? 1,
      marker: textPages[index]?.marker ?? null,
      text: textPages[index]?.text ?? "",
      text_sha256: textPages[index]?.text_sha256 ?? sha256(""),
      text_items: textPages[index]?.items ?? [],
    })),
    fields,
    annotations: rawAnnotations.filter(annotation => annotation.subtype !== "/Widget"),
    raw_annotations: rawAnnotations,
    widget_consistency: {
      passed: orphanRawWidgetRefs.length === 0 && missingFieldWidgetRefs.length === 0
        && multiplyPlacedFieldWidgetRefs.length === 0 && duplicatePageWidgetRefs.length === 0,
      orphan_raw_widget_refs: orphanRawWidgetRefs,
      missing_field_widget_refs: missingFieldWidgetRefs,
      multiply_placed_field_widget_refs: multiplyPlacedFieldWidgetRefs,
      duplicate_page_widget_refs: [...new Set(duplicatePageWidgetRefs)],
    },
    metadata,
    catalog: catalogPresence(pdf),
    renders,
  };
}

export function serializableInspection(inspection) {
  const { renders, ...plain } = inspection;
  return {
    ...plain,
    path: null,
    renders: renders.map(({ rgba, ...render }) => render),
  };
}

export async function popplerFingerprint() {
  try {
    const [{ stdout, stderr }, executable] = await Promise.all([
      runFile("pdftoppm", ["-v"], { maxBuffer: 1024 * 1024 }),
      runFile("sh", ["-c", "command -v pdftoppm"], { maxBuffer: 1024 * 1024 }),
    ]);
    const binaryPath = executable.stdout.trim();
    return {
      family: "poppler",
      available: true,
      version: `${stdout}${stderr}`.trim().split("\n")[0],
      binary_sha256: sha256(await fs.readFile(binaryPath)),
    };
  } catch (error) {
    return { family: "poppler", available: false, error: error.message };
  }
}

export async function renderPopplerPage(filePath, pageNumber, dpi, temporaryDirectory) {
  const prefix = path.join(temporaryDirectory, `poppler-${pageNumber}-${dpi}-${process.pid}-${Date.now()}`);
  const outputPath = `${prefix}.png`;
  try {
    await runFile("pdftoppm", [
      "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-cropbox",
      "-r", String(dpi), "-png", filePath, prefix,
    ], { maxBuffer: 8 * 1024 * 1024 });
    const png = await fs.readFile(outputPath);
    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    const rgba = Buffer.from(context.getImageData(0, 0, image.width, image.height).data);
    return { page: pageNumber, dpi, width: image.width, height: image.height, rgba, rgba_sha256: sha256(rgba) };
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

export function rotateRgba(render, degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) return { ...render, rgba: Buffer.from(render.rgba) };
  if (![90, 180, 270].includes(normalized)) throw new Error(`Unsupported rotation ${degrees}`);
  const width = normalized === 180 ? render.width : render.height;
  const height = normalized === 180 ? render.height : render.width;
  const rgba = Buffer.alloc(render.rgba.length);
  for (let y = 0; y < render.height; y += 1) {
    for (let x = 0; x < render.width; x += 1) {
      let targetX;
      let targetY;
      if (normalized === 90) [targetX, targetY] = [render.height - 1 - y, x];
      else if (normalized === 180) [targetX, targetY] = [render.width - 1 - x, render.height - 1 - y];
      else [targetX, targetY] = [y, render.width - 1 - x];
      render.rgba.copy(rgba, (targetY * width + targetX) * 4, (y * render.width + x) * 4, (y * render.width + x + 1) * 4);
    }
  }
  return { ...render, width, height, rgba, rgba_sha256: sha256(rgba) };
}

function transformPoint(transform, x, y) {
  return [
    transform[0] * x + transform[2] * y + transform[4],
    transform[1] * x + transform[3] * y + transform[5],
  ];
}

export function rasterizeFidelityRegions(width, height, regions, policy, geometry) {
  const mask = new Uint8Array(width * height);
  const media = geometry?.media_box;
  const transform = geometry?.viewport_transform;
  if (!Array.isArray(media) || media.length !== 4 || !Array.isArray(transform) || transform.length !== 6) {
    throw new Error("Fidelity mask geometry requires a four-number MediaBox and six-number viewport transform");
  }
  for (const region of regions) {
    const [x, y, regionWidth, regionHeight] = region;
    const pdfLeft = media[0] + x;
    const pdfRight = pdfLeft + regionWidth;
    const pdfTop = media[1] + media[3] - y;
    const pdfBottom = pdfTop - regionHeight;
    const corners = [
      transformPoint(transform, pdfLeft, pdfTop),
      transformPoint(transform, pdfRight, pdfTop),
      transformPoint(transform, pdfRight, pdfBottom),
      transformPoint(transform, pdfLeft, pdfBottom),
    ];
    const halo = policy.intended_region_halo_pixels;
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map(point => point[0]))) - halo);
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map(point => point[1]))) - halo);
    const x1 = Math.min(width, Math.ceil(Math.max(...corners.map(point => point[0]))) + halo);
    const y1 = Math.min(height, Math.ceil(Math.max(...corners.map(point => point[1]))) + halo);
    for (let rasterY = y0; rasterY < y1; rasterY += 1) {
      mask.fill(1, rasterY * width + x0, rasterY * width + x1);
    }
  }
  return mask;
}

export function diffFidelityRgba(before, after, regions, policy) {
  const thresholds = policy.pixel_delta_thresholds;
  if (before.width !== after.width || before.height !== after.height) {
    return { dimension_mismatch: true, thresholds, raw_counts: null, inside_counts: null, outside_counts: null, intended_pixels: null };
  }
  const mask = rasterizeFidelityRegions(before.width, before.height, regions, policy, after.mask_geometry);
  const rawCounts = Object.fromEntries(thresholds.map(threshold => [threshold, 0]));
  const insideCounts = Object.fromEntries(thresholds.map(threshold => [threshold, 0]));
  const outsideCounts = Object.fromEntries(thresholds.map(threshold => [threshold, 0]));
  let intendedPixels = 0;
  for (const value of mask) intendedPixels += value;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    let delta = 0;
    for (let channel = 0; channel < 4; channel += 1) delta = Math.max(delta, Math.abs(before.rgba[offset + channel] - after.rgba[offset + channel]));
    for (const threshold of thresholds) {
      if (delta <= threshold) continue;
      rawCounts[threshold] += 1;
      (mask[pixel] ? insideCounts : outsideCounts)[threshold] += 1;
    }
  }
  return {
    dimension_mismatch: false,
    thresholds,
    raw_counts: rawCounts,
    inside_counts: insideCounts,
    outside_counts: outsideCounts,
    intended_pixels: intendedPixels,
    total_pixels: mask.length,
  };
}

function nodeType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isSocket()) return "socket";
  if (stat.isFIFO()) return "fifo";
  if (stat.isCharacterDevice()) return "character";
  if (stat.isBlockDevice()) return "block";
  return "unknown";
}

export async function snapshotFilesystem(root) {
  const entries = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    const type = nodeType(stat);
    const record = { path: relative.split(path.sep).join("/"), type, mode: stat.mode & 0o777 };
    if (type === "file") {
      record.size = stat.size;
      record.sha256 = sha256(await fs.readFile(absolute));
    }
    if (type === "symlink") record.link_target = await fs.readlink(absolute);
    entries.push(record);
    if (type === "directory") {
      const children = await fs.readdir(absolute);
      for (const child of children.sort()) await visit(path.join(relative, child));
    }
  }
  for (const child of (await fs.readdir(root)).sort()) await visit(child);
  return entries;
}

export function diffFilesystem(before, after) {
  const beforeByPath = new Map(before.map(entry => [entry.path, entry]));
  const afterByPath = new Map(after.map(entry => [entry.path, entry]));
  const created = [...afterByPath.keys()].filter(key => !beforeByPath.has(key)).sort();
  const deleted = [...beforeByPath.keys()].filter(key => !afterByPath.has(key)).sort();
  const modified = [...afterByPath.keys()].filter(key => {
    if (!beforeByPath.has(key)) return false;
    return JSON.stringify(beforeByPath.get(key)) !== JSON.stringify(afterByPath.get(key));
  }).sort();
  return { created, deleted, modified };
}
