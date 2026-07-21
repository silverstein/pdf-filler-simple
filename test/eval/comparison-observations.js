import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";

const require = createRequire(import.meta.url);
let pdfjs;
let canvasLibrary;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeComparisonText(value) {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

async function loadRenderingDependencies() {
  if (!canvasLibrary) {
    canvasLibrary = await import("@napi-rs/canvas");
    if (canvasLibrary.DOMMatrix) globalThis.DOMMatrix = canvasLibrary.DOMMatrix;
    if (canvasLibrary.Path2D) globalThis.Path2D = canvasLibrary.Path2D;
    if (canvasLibrary.ImageData) globalThis.ImageData = canvasLibrary.ImageData;
  }
  if (!pdfjs) {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
    ).href;
    pdfjs.GlobalWorkerOptions.isEvalSupported = false;
  }
  return { pdfjs, createCanvas: canvasLibrary.createCanvas };
}

function standardFontDataUrl() {
  return `${path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")}${path.sep}`;
}

function pdfjsOptions(bytes) {
  return {
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    useWasm: false,
    disableAutoFetch: true,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  };
}

function textRegion(item, pageHeight) {
  const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
  const fontSize = Math.abs(transform[3]) > 0.01
    ? Math.abs(transform[3])
    : Math.max(Math.hypot(transform[2], transform[3]), 8);
  const width = typeof item.width === "number" && item.width > 0
    ? item.width
    : fontSize * item.str.length * 0.5;
  return [transform[4], pageHeight - transform[5] - fontSize * 0.75, width, fontSize];
}

export async function extractComparisonText(bytes) {
  const { pdfjs: library } = await loadRenderingDependencies();
  const loadingTask = library.getDocument(pdfjsOptions(bytes));
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const content = await page.getTextContent();
      const items = content.items.filter(item => typeof item?.str === "string" && item.str.trim()).map(item => ({
        text: normalizeComparisonText(item.str),
        region: textRegion(item, viewport.height),
      }));
      const text = normalizeComparisonText(items.map(item => item.text).join(" "));
      const marker = items.map(item => item.text).find(value => /^PAGE-ID: [A-Z]+$/.test(value)) ?? null;
      pages.push({
        page: pageNumber,
        width: viewport.width,
        height: viewport.height,
        text,
        text_sha256: sha256(text),
        marker,
        items,
      });
    }
  } finally {
    await document.destroy();
  }
  return pages;
}

export async function renderComparisonPage(bytes, pageNumber, renderer) {
  const { pdfjs: library, createCanvas } = await loadRenderingDependencies();
  const loadingTask = library.getDocument(pdfjsOptions(bytes));
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: renderer.scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: context,
      viewport,
      background: "rgb(255,255,255)",
    }).promise;
    const image = context.getImageData(0, 0, width, height);
    const rgba = Buffer.from(image.data);
    return {
      page: pageNumber,
      width,
      height,
      scale: renderer.scale,
      rgba,
      rgba_sha256: sha256(rgba),
    };
  } finally {
    await document.destroy();
  }
}

export function cropComparisonRgba(render, region, renderer) {
  const x0 = Math.max(0, Math.floor(region[0] * renderer.scale));
  const y0 = Math.max(0, Math.floor(region[1] * renderer.scale));
  const x1 = Math.min(render.width, Math.ceil((region[0] + region[2]) * renderer.scale));
  const y1 = Math.min(render.height, Math.ceil((region[1] + region[3]) * renderer.scale));
  const bytes = Buffer.alloc(Math.max(0, x1 - x0) * Math.max(0, y1 - y0) * 4);
  let offset = 0;
  for (let y = y0; y < y1; y += 1) {
    const start = (y * render.width + x0) * 4;
    const end = (y * render.width + x1) * 4;
    render.rgba.copy(bytes, offset, start, end);
    offset += end - start;
  }
  return {
    region_points: region,
    region_pixels: [x0, y0, x1 - x0, y1 - y0],
    rgba: bytes,
    rgba_sha256: sha256(bytes),
  };
}

export function diffComparisonRgba(before, after, renderer) {
  if (before.width !== after.width || before.height !== after.height) {
    return {
      dimension_mismatch: true,
      raw_changed_pixels: null,
      changed_pixels: null,
      changed_fraction: null,
      bounds: null,
      components: null,
    };
  }
  const pixelCount = before.width * before.height;
  const thresholdMask = new Uint8Array(pixelCount);
  let rawChangedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    let maximumDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      maximumDelta = Math.max(maximumDelta, Math.abs(before.rgba[offset + channel] - after.rgba[offset + channel]));
    }
    if (maximumDelta <= renderer.pixel_delta_threshold) continue;
    thresholdMask[pixel] = 1;
    rawChangedPixels += 1;
  }

  const radius = renderer.mask_dilation_pixels;
  const dilatedMask = radius === 0 ? thresholdMask : new Uint8Array(pixelCount);
  if (radius > 0) {
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (!thresholdMask[pixel]) continue;
      const x = pixel % before.width;
      const y = Math.floor(pixel / before.width);
      for (let dy = -radius; dy <= radius; dy += 1) {
        const targetY = y + dy;
        if (targetY < 0 || targetY >= before.height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const targetX = x + dx;
          if (targetX >= 0 && targetX < before.width) {
            dilatedMask[targetY * before.width + targetX] = 1;
          }
        }
      }
    }
  }

  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  const neighborOffsets = renderer.connected_components === 8
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const components = [];
  let changedPixels = 0;
  let minX = before.width;
  let minY = before.height;
  let maxX = -1;
  let maxY = -1;
  for (let start = 0; start < pixelCount; start += 1) {
    if (!dilatedMask[start] || visited[start]) continue;
    let stackSize = 0;
    stack[stackSize] = start;
    stackSize += 1;
    visited[start] = 1;
    let area = 0;
    let componentMinX = before.width;
    let componentMinY = before.height;
    let componentMaxX = -1;
    let componentMaxY = -1;
    while (stackSize > 0) {
      stackSize -= 1;
      const pixel = stack[stackSize];
      const x = pixel % before.width;
      const y = Math.floor(pixel / before.width);
      area += 1;
      componentMinX = Math.min(componentMinX, x);
      componentMinY = Math.min(componentMinY, y);
      componentMaxX = Math.max(componentMaxX, x);
      componentMaxY = Math.max(componentMaxY, y);
      for (const [dx, dy] of neighborOffsets) {
        const targetX = x + dx;
        const targetY = y + dy;
        if (targetX < 0 || targetX >= before.width || targetY < 0 || targetY >= before.height) continue;
        const target = targetY * before.width + targetX;
        if (!dilatedMask[target] || visited[target]) continue;
        visited[target] = 1;
        stack[stackSize] = target;
        stackSize += 1;
      }
    }
    if (area < renderer.minimum_component_area_pixels) continue;
    changedPixels += area;
    minX = Math.min(minX, componentMinX);
    minY = Math.min(minY, componentMinY);
    maxX = Math.max(maxX, componentMaxX);
    maxY = Math.max(maxY, componentMaxY);
    components.push({
      area_pixels: area,
      bounds: [
        componentMinX / renderer.scale,
        componentMinY / renderer.scale,
        (componentMaxX - componentMinX + 1) / renderer.scale,
        (componentMaxY - componentMinY + 1) / renderer.scale,
      ],
    });
  }
  components.sort((left, right) => right.area_pixels - left.area_pixels
    || left.bounds[1] - right.bounds[1] || left.bounds[0] - right.bounds[0]);
  return {
    dimension_mismatch: false,
    raw_changed_pixels: rawChangedPixels,
    changed_pixels: changedPixels,
    changed_fraction: changedPixels / pixelCount,
    bounds: changedPixels === 0 ? null : [
      minX / renderer.scale,
      minY / renderer.scale,
      (maxX - minX + 1) / renderer.scale,
      (maxY - minY + 1) / renderer.scale,
    ],
    components,
  };
}

function decodePdfString(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return value?.toString?.() ?? null;
}

function pdfNumberArray(context, value) {
  const array = context.lookup(value, PDFArray);
  if (!array) return null;
  return array.asArray().map(item => context.lookup(item, PDFNumber)?.asNumber());
}

function fieldValue(field) {
  if (typeof field.getText === "function") return field.getText() ?? "";
  if (typeof field.isChecked === "function") return field.isChecked();
  if (typeof field.getSelected === "function") return field.getSelected();
  return null;
}

function fieldLocation(pdf, field) {
  const widget = field.acroField.getWidgets()[0];
  if (!widget) return { page: null, region: null };
  const widgetReference = pdf.context.getObjectRef(widget.dict);
  const rectangle = widget.getRectangle();
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    if (!annots.asArray().some(reference => reference === widgetReference
      || reference?.toString?.() === widgetReference?.toString?.())) continue;
    return {
      page: pageIndex + 1,
      region: [
        rectangle.x,
        page.getHeight() - rectangle.y - rectangle.height,
        rectangle.width,
        rectangle.height,
      ],
    };
  }
  return { page: null, region: null };
}

export async function inspectComparisonDocument(filePath, renderer) {
  const bytes = await fs.readFile(filePath);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = await extractComparisonText(bytes);
  const renders = [];
  for (let pageNumber = 1; pageNumber <= pages.length; pageNumber += 1) {
    renders.push(await renderComparisonPage(bytes, pageNumber, renderer));
  }
  const fields = pdf.getForm().getFields().map(field => {
    const value = fieldValue(field);
    return {
      name: field.getName(),
      type: field.constructor.name,
      value,
      value_sha256: sha256(String(value ?? "")),
      ...fieldLocation(pdf, field),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const annotations = [];
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (const reference of annots.asArray()) {
      const dictionary = pdf.context.lookup(reference, PDFDict);
      if (!dictionary) continue;
      const subtype = dictionary.get(PDFName.of("Subtype"))?.toString() ?? null;
      if (subtype === "/Widget") continue;
      const contents = decodePdfString(dictionary.get(PDFName.of("Contents")));
      const rect = pdfNumberArray(pdf.context, dictionary.get(PDFName.of("Rect")));
      const topLeftRect = rect?.length === 4 ? [
        rect[0],
        page.getHeight() - rect[3],
        rect[2] - rect[0],
        rect[3] - rect[1],
      ] : null;
      annotations.push({
        page: pageIndex + 1,
        subtype,
        contents,
        contents_sha256: sha256(contents ?? ""),
        region: topLeftRect,
      });
    }
  }
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
  return {
    path: filePath,
    sha256: sha256(bytes),
    size: bytes.length,
    pages,
    renders,
    fields,
    annotations,
    metadata,
  };
}

export function rendererFingerprint(renderer) {
  return sha256(JSON.stringify(renderer));
}
