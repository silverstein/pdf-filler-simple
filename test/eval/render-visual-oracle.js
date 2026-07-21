import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import { cropComparisonRgba, renderComparisonPage } from "./comparison-observations.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "manifest.v1.json");

export const VISUAL_ORACLE_MAX_MAE = 0.12;
export const VISUAL_ORACLE_MIN_FOREGROUND_IOU = 0.55;
export const VISUAL_ORACLE_MAX_ASPECT_ERROR = 0.03;
export const VISUAL_ORACLE_MIN_DIMENSION = 32;
const NORMALIZED_MAX_DIMENSION = 96;

let manifestPromise;
const referenceCache = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function corpusManifest() {
  manifestPromise ??= fs.readFile(MANIFEST_PATH, "utf8").then(JSON.parse);
  return manifestPromise;
}

async function trustedFixture(sourceSha256) {
  const manifest = await corpusManifest();
  const fixture = manifest.fixtures.find(item => item.sha256 === sourceSha256);
  if (!fixture) throw new Error(`No trusted corpus fixture matches source ${sourceSha256}`);
  const filename = path.join(REPO_ROOT, "test", "fixtures", "eval", fixture.path);
  const bytes = await fs.readFile(filename);
  if (sha256(bytes) !== sourceSha256) throw new Error(`Trusted fixture bytes changed for ${fixture.id}`);
  return { fixture, bytes };
}

async function referenceRender({ sourceSha256, page, scale, region }) {
  const key = JSON.stringify({ sourceSha256, page, scale, region });
  if (!referenceCache.has(key)) {
    referenceCache.set(key, (async () => {
      const { fixture, bytes } = await trustedFixture(sourceSha256);
      const full = await renderComparisonPage(bytes, page, { scale });
      if (!region) return { fixture, render: full };
      const cropped = cropComparisonRgba(full, region, { scale });
      return {
        fixture,
        render: {
          width: cropped.region_pixels[2],
          height: cropped.region_pixels[3],
          rgba: cropped.rgba,
          rgba_sha256: cropped.rgba_sha256,
        },
      };
    })());
  }
  return referenceCache.get(key);
}

function canvasFromRgba(render) {
  const canvas = createCanvas(render.width, render.height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(render.width, render.height);
  image.data.set(render.rgba);
  context.putImageData(image, 0, 0);
  return canvas;
}

function normalizedPixels(source, width, height) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "rgb(255,255,255)";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  return Buffer.from(context.getImageData(0, 0, width, height).data);
}

function foreground(bytes, offset) {
  const red = bytes[offset];
  const green = bytes[offset + 1];
  const blue = bytes[offset + 2];
  return Math.min(red, green, blue) < 245 || Math.max(red, green, blue) - Math.min(red, green, blue) > 10;
}

function comparePixels(host, reference) {
  let absoluteError = 0;
  let foregroundIntersection = 0;
  let foregroundUnion = 0;
  for (let offset = 0; offset < reference.length; offset += 4) {
    absoluteError += Math.abs(host[offset] - reference[offset]);
    absoluteError += Math.abs(host[offset + 1] - reference[offset + 1]);
    absoluteError += Math.abs(host[offset + 2] - reference[offset + 2]);
    const hostForeground = foreground(host, offset);
    const referenceForeground = foreground(reference, offset);
    if (hostForeground && referenceForeground) foregroundIntersection += 1;
    if (hostForeground || referenceForeground) foregroundUnion += 1;
  }
  return {
    meanAbsoluteError: absoluteError / ((reference.length / 4) * 3 * 255),
    foregroundIou: foregroundUnion === 0 ? 0 : foregroundIntersection / foregroundUnion,
  };
}

function rounded(value) {
  return Number(value.toFixed(6));
}

export async function renderTrustedFixturePng({ sourceSha256, page, scale, region = null }) {
  const { fixture, render } = await referenceRender({ sourceSha256, page, scale, region });
  return {
    fixture_id: fixture.id,
    width: render.width,
    height: render.height,
    rgba_sha256: render.rgba_sha256,
    png: canvasFromRgba(render).toBuffer("image/png"),
  };
}

export async function buildTrustedVisualOracle({
  imageBytes, sourceSha256, page, scale, region = null,
}) {
  const decoded = await loadImage(imageBytes);
  const { fixture, render } = await referenceRender({ sourceSha256, page, scale, region });
  const aspectError = Math.abs((decoded.width / decoded.height) - (render.width / render.height))
    / (render.width / render.height);
  const normalizedWidth = render.width >= render.height
    ? NORMALIZED_MAX_DIMENSION
    : Math.max(1, Math.round(NORMALIZED_MAX_DIMENSION * render.width / render.height));
  const normalizedHeight = render.height >= render.width
    ? NORMALIZED_MAX_DIMENSION
    : Math.max(1, Math.round(NORMALIZED_MAX_DIMENSION * render.height / render.width));
  const hostPixels = normalizedPixels(decoded, normalizedWidth, normalizedHeight);
  const referencePixels = normalizedPixels(
    canvasFromRgba(render), normalizedWidth, normalizedHeight,
  );
  const comparison = comparePixels(hostPixels, referencePixels);
  const passed = decoded.width >= VISUAL_ORACLE_MIN_DIMENSION
    && decoded.height >= VISUAL_ORACLE_MIN_DIMENSION
    && aspectError <= VISUAL_ORACLE_MAX_ASPECT_ERROR
    && comparison.meanAbsoluteError <= VISUAL_ORACLE_MAX_MAE
    && comparison.foregroundIou >= VISUAL_ORACLE_MIN_FOREGROUND_IOU;
  const result = {
    oracle_schema_version: 1,
    fixture_id: fixture.id,
    reference_source_sha256: sourceSha256,
    reference_rgba_sha256: render.rgba_sha256,
    normalized_width_px: normalizedWidth,
    normalized_height_px: normalizedHeight,
    host_normalized_rgba_sha256: sha256(hostPixels),
    reference_normalized_rgba_sha256: sha256(referencePixels),
    mean_absolute_error: rounded(comparison.meanAbsoluteError),
    foreground_iou: rounded(comparison.foregroundIou),
    aspect_ratio_error: rounded(aspectError),
    passed,
  };
  if (!passed) {
    throw new Error(`Host-visible PNG failed the trusted visual oracle for ${fixture.id}`);
  }
  return result;
}
