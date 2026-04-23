#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument, degrees as pdfDegrees } from "pdf-lib";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync, realpathSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { homedir, platform as osPlatform } from "os";
import { spawn } from "child_process";
import { createScopedStderrSuppressor } from "./stderr-suppression.js";

const _require = createRequire(import.meta.url);

// Polyfill browser globals that pdfjs-dist v5 expects but Node.js lacks
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      const v = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
      this.a = v[0]; this.b = v[1]; this.c = v[2];
      this.d = v[3]; this.e = v[4]; this.f = v[5];
      this.is2D = true; this.isIdentity = v[0] === 1 && v[1] === 0 && v[2] === 0 && v[3] === 1 && v[4] === 0 && v[5] === 0;
    }
    multiplySelf() { return this; }
    preMultiplySelf() { return this; }
    translateSelf() { return this; }
    scaleSelf() { return this; }
    rotateSelf() { return this; }
    invertSelf() { return this; }
    static fromMatrix(m) { return new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]); }
    static fromFloat32Array(a) { return new DOMMatrix(Array.from(a)); }
    static fromFloat64Array(a) { return new DOMMatrix(Array.from(a)); }
  };
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D { constructor() {} addPath() {} closePath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} };
}
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
}

// Lazy load heavy dependencies only when needed
let pdfjsLib = null;
let createCanvas = null;
let _pdfjsLoading = null;

// Load pdfjs-dist only (for text extraction — no canvas needed)
async function loadPdfjs() {
  if (pdfjsLib) return;
  if (_pdfjsLoading) return _pdfjsLoading;
  _pdfjsLoading = (async () => {
    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib = pdfjs.default || pdfjs;
      // Disable worker threads — not needed for server-side, avoids spawn issues
      pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
        _require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
      ).href;
      pdfjsLib.GlobalWorkerOptions.isEvalSupported = false;
      console.error("[PDF Tools] pdfjs-dist loaded successfully");
    } catch (error) {
      _pdfjsLoading = null;
      console.error("[PDF Tools] Failed to load pdfjs-dist:", error.message);
      throw new Error("PDF text extraction is not available: " + error.message);
    }
  })();
  return _pdfjsLoading;
}

// Load pdfjs-dist + canvas (for image rendering / OCR fallback)
async function loadImageDependencies() {
  await loadPdfjs();
  if (createCanvas) return;
  try {
    const canvas = await import("@napi-rs/canvas");
    createCanvas = canvas.createCanvas;
    // When native canvas bindings are available, prefer their DOM-like types
    // over our minimal JS fallbacks so pdfjs rendering can hand real Path2D /
    // ImageData objects to the rasterizer.
    if (canvas.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
    if (canvas.Path2D) globalThis.Path2D = canvas.Path2D;
    if (canvas.ImageData) globalThis.ImageData = canvas.ImageData;
    console.error("[PDF Tools] Canvas loaded successfully");
  } catch (error) {
    console.error("[PDF Tools] Failed to load canvas:", error.message);
    throw new Error("Image extraction is not available. Canvas dependency could not be loaded: " + error.message);
  }
}

function expandUserPath(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizeUserPath(inputPath) {
  const expanded = expandUserPath(inputPath);
  return path.resolve(expanded);
}

function canonicalizePathForPolicy(resolvedPath) {
  const absolutePath = path.resolve(resolvedPath);
  if (existsSync(absolutePath)) {
    return realpathSync.native(absolutePath);
  }

  let ancestor = absolutePath;
  const missingParts = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    missingParts.unshift(path.basename(ancestor));
    ancestor = parent;
  }

  const canonicalAncestor = existsSync(ancestor)
    ? realpathSync.native(ancestor)
    : ancestor;
  return path.join(canonicalAncestor, ...missingParts);
}

function isPathInsideDirectory(candidatePath, directoryPath) {
  const relative = path.relative(directoryPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathAllowed(resolvedPath) {
  const canonicalPath = canonicalizePathForPolicy(resolvedPath);
  const isAllowed = ALLOWED_DIRECTORIES.some((directory) =>
    isPathInsideDirectory(canonicalPath, directory.canonical)
  );

  if (!isAllowed) {
    const allowed = ALLOWED_DIRECTORIES.map((directory) => directory.display).join(", ");
    throw new Error(
      `This extension is only allowed to access: ${allowed}. ` +
      `Tried to access: ${resolvedPath}. ` +
      "Update allowed_directories in the Claude Desktop extension settings to include this folder."
    );
  }

  return resolvedPath;
}

// Helper function to resolve paths and enforce the extension filesystem sandbox.
function resolvePath(inputPath) {
  if (!inputPath) return inputPath;
  return assertPathAllowed(normalizeUserPath(inputPath));
}

const stderrSuppressor = createScopedStderrSuppressor();

async function withSuppressedStderr(action) {
  return await stderrSuppressor.run(action);
}

// Helper function to convert PDF page to image
async function convertPdfPageToImage(pdfBuffer, pageNumber = 1, scale = 1.0, password = null) {
  try {
    return await withSuppressedStderr(async () => {
      // Load dependencies only when needed
      await loadImageDependencies();
      // Load the PDF
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
        password: password || undefined,
        useSystemFonts: true,
        disableFontFace: true,
        disableAutoFetch: true,
        useWorkerFetch: false,
        isEvalSupported: false,
        verbosity: 0
      });
      const pdfDocument = await loadingTask.promise;
      
      // Validate page number
      const numPages = pdfDocument.numPages;
      if (pageNumber < 1 || pageNumber > numPages) {
        throw new Error(`Invalid page number. PDF has ${numPages} pages.`);
      }
      
      // Get the page
      const page = await pdfDocument.getPage(pageNumber);
      
      // Set up the canvas with proper dimensions
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');
      
      // Set white background
      context.fillStyle = 'white';
      context.fillRect(0, 0, viewport.width, viewport.height);
      
      // Render the page
      await page.render({
        canvasContext: context,
        viewport: viewport
      }).promise;
      
      // Cleanup
      await pdfDocument.destroy();
      
      // Return as PNG buffer
      return canvas.toBuffer('image/png');
    });
  } catch (error) {
    console.error('Error converting PDF to image:', error);
    throw error;
  }
}

async function convertPdfRegionToImage(pdfBuffer, {
  pageNumber = 1,
  scale = 1.0,
  x,
  y,
  width,
  height,
  password = null,
}) {
  try {
    return await withSuppressedStderr(async () => {
      await loadImageDependencies();
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
        password: password || undefined,
        useSystemFonts: true,
        disableFontFace: true,
        disableAutoFetch: true,
        useWorkerFetch: false,
        isEvalSupported: false,
        verbosity: 0
      });
      const pdfDocument = await loadingTask.promise;
      const numPages = pdfDocument.numPages;
      if (pageNumber < 1 || pageNumber > numPages) {
        throw new Error(`Invalid page number. PDF has ${numPages} pages.`);
      }

      const page = await pdfDocument.getPage(pageNumber);
      // render_pdf_region uses the toolkit's native top-left PDF coordinate
      // system, which matches signing / zone-detection math before any page
      // rotation is applied. Force rotation=0 so cropping stays aligned.
      const viewport = page.getViewport({ scale, rotation: 0 });
      const fullCanvas = createCanvas(viewport.width, viewport.height);
      const fullContext = fullCanvas.getContext("2d");
      fullContext.fillStyle = "white";
      fullContext.fillRect(0, 0, viewport.width, viewport.height);
      await page.render({
        canvasContext: fullContext,
        viewport,
      }).promise;

      const crop = getRegionPixelRect({ x, y, width, height, scale });
      const cropCanvas = createCanvas(crop.width, crop.height);
      const cropContext = cropCanvas.getContext("2d");
      cropContext.fillStyle = "white";
      cropContext.fillRect(0, 0, crop.width, crop.height);
      cropContext.drawImage(
        fullCanvas,
        crop.left, crop.top, crop.width, crop.height,
        0, 0, crop.width, crop.height
      );

      await pdfDocument.destroy();
      return cropCanvas.toBuffer("image/png");
    });
  } catch (error) {
    console.error("Error converting PDF region to image:", error);
    throw error;
  }
}

// Extract text from all pages of a PDF using pdfjs-dist
async function extractPdfText(pdfBuffer, maxPages) {
  await loadPdfjs();
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0
  }).promise;

  const totalPages = doc.numPages;
  const pagesToRead = maxPages ? Math.min(maxPages, totalPages) : totalPages;
  const pages = [];
  for (let i = 1; i <= pagesToRead; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str).join("");
    pages.push({ page: i, text });
  }
  await doc.destroy();
  return {
    text: pages.map(page => page.text).join("\n\n"),
    pages,
    pagesRead: pagesToRead,
    totalPages,
  };
}

// Helper: load a PDF from disk with password support and clear error messages
async function loadPdf(inputPath, password = null) {
  const resolvedPath = resolvePath(inputPath);
  const pdfBytes = await fs.readFile(resolvedPath);
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, password ? { password } : {});
  } catch (error) {
    if (error.message?.includes("password") || error.message?.includes("encrypt")) {
      throw new Error("PDF is password-protected. Please provide the correct password using the 'password' parameter.");
    }
    throw new Error(`Failed to load PDF: ${error.message}`);
  }
  return { pdfDoc, resolvedPath, pdfBytes };
}

// Import helpers extracted for testability
import {
  getPageDisplayMetrics,
  parsePageRanges,
  downloadPdfFromUrl,
  findUniquePath,
  validateSignatureName,
  parseImageDataUrl,
  validateSigningIntent,
  stampSignatureOnPage,
  stampTextOnPage,
  drawSignatureFieldOnPage,
  formatSigningAuditLine,
  detectExistingSignatures,
  detectXfaForm,
  assertXfaMutationAllowed,
  detectSignatureZones,
  computeIoU,
  extractPdfTextWithBounds,
  buildPageTextSegments,
  getPageRenderScale,
  getRegionPixelRect,
  searchPageTexts,
  validatePdfRegionBox,
} from "./helpers.js";

// Helper: validate profile name to prevent path traversal
function validateProfileName(name) {
  if (!name || typeof name !== "string") throw new Error("Profile name is required.");
  if (!/^[\w\-. ]+$/.test(name)) {
    throw new Error("Profile name may only contain letters, numbers, hyphens, underscores, spaces, and dots.");
  }
  return name;
}

const server = new Server(
  {
    name: "pdf-tools",
    version: "0.8.1",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Default directories - use environment variables from manifest or fallback to defaults
// Defensive env read — if Claude Desktop couldn't substitute a user_config
// template (MCPB version mismatch, missing config), the raw literal
// "${user_config.X}" would reach us and break readdir. Treat any template-
// shaped value as unset and fall through to the safe home-dir default.
function envPathOrDefault(name, fallback) {
  const val = process.env[name];
  if (!val) return fallback;
  if (val.includes("${")) return fallback;
  return val;
}
const DEFAULT_PDF_DIR = envPathOrDefault("DEFAULT_PDF_DIR", path.join(homedir(), "Documents"));
const DEFAULT_DOWNLOAD_DIR = envPathOrDefault("DEFAULT_DOWNLOAD_DIR", path.join(homedir(), "Downloads"));
// Keep in sync with manifest.json and share bundle defaults
const PROFILES_DIR = envPathOrDefault("DEFAULT_PROFILES_DIR", path.join(homedir(), ".pdf-toolkit-files"));
const SIGNATURES_DIR = path.join(PROFILES_DIR, "signatures");
const BACKUPS_DIR = path.join(PROFILES_DIR, "backups");
const OLD_PROFILES_DIR = path.join(homedir(), ".pdf-filler-profiles");
const DEFAULT_ALLOWED_DIRECTORIES = [
  path.join(homedir(), "Documents"),
  path.join(homedir(), "Downloads"),
  path.join(homedir(), "Desktop"),
];

function parsePathListValue(value) {
  if (!value || value.includes("${")) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(item => typeof item === "string");
    } catch {}
  }

  const delimiters = [
    "\n",
    path.delimiter,
    ",",
  ].filter((delimiter, index, all) => delimiter && all.indexOf(delimiter) === index);
  const delimiter = delimiters.find((candidate) => trimmed.includes(candidate));
  if (!delimiter) return [trimmed];
  return trimmed
    .split(delimiter)
    .map(item => item.trim())
    .filter(Boolean);
}

function envPathListOrDefault(name, fallbackPaths) {
  return parsePathListValue(process.env[name]) || fallbackPaths;
}

function buildAllowedDirectories() {
  const configuredDirectories = envPathListOrDefault("ALLOWED_DIRECTORIES", DEFAULT_ALLOWED_DIRECTORIES);
  const directories = [
    ...configuredDirectories,
    PROFILES_DIR,
  ];

  const seen = new Set();
  return directories
    .map((directory) => normalizeUserPath(directory))
    .map((directory) => ({
      display: directory,
      canonical: canonicalizePathForPolicy(directory),
    }))
    .filter((directory) => {
      const key = directory.canonical;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const ALLOWED_DIRECTORIES = buildAllowedDirectories();

function tempOutputPath(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function writePdfOutputAtomic(targetPath, bytes) {
  const tmpPath = tempOutputPath(targetPath);
  try {
    await fs.writeFile(tmpPath, bytes);
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    try { await fs.unlink(tmpPath); } catch {}
    throw error;
  }
}

const backupPathByCanonical = new Map();
const activeDocumentState = {
  activePath: null,
  backupPath: null,
  lastOpenedAt: null,
  lastMutationTool: null,
  lastMutationAt: null,
};

function backupFileNameFor(pdfPath) {
  const ext = path.extname(pdfPath) || ".pdf";
  const base = path.basename(pdfPath, ext).replace(/[^\w.-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}__${stamp}${ext}`;
}

async function ensureBackupForCanonicalPath(pdfPath) {
  const resolvedPath = resolvePath(pdfPath);
  const existing = backupPathByCanonical.get(resolvedPath);
  if (existing) {
    try {
      await fs.access(existing);
      return existing;
    } catch {
      // Fall through and recreate the missing backup.
    }
  }

  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  const target = await findUniquePath(path.join(BACKUPS_DIR, backupFileNameFor(resolvedPath)));
  await fs.copyFile(resolvedPath, target);
  backupPathByCanonical.set(resolvedPath, target);
  return target;
}

function noteDocumentOpened(pdfPath) {
  const resolvedPath = resolvePath(pdfPath);
  activeDocumentState.activePath = resolvedPath;
  activeDocumentState.backupPath = backupPathByCanonical.get(resolvedPath) || null;
  activeDocumentState.lastOpenedAt = new Date().toISOString();
}

function syncActiveDocumentState({ pdfPath, backupPath = null, lastMutationTool = null, lastMutationAt = null }) {
  const resolvedPath = resolvePath(pdfPath);
  const resolvedBackupPath = backupPath ? resolvePath(backupPath) : null;
  activeDocumentState.activePath = resolvedPath;
  activeDocumentState.backupPath = resolvedBackupPath;
  activeDocumentState.lastOpenedAt = new Date().toISOString();
  if (resolvedBackupPath) {
    backupPathByCanonical.set(resolvedPath, resolvedBackupPath);
  }
  if (lastMutationTool) {
    activeDocumentState.lastMutationTool = lastMutationTool;
  }
  if (lastMutationAt) {
    activeDocumentState.lastMutationAt = lastMutationAt;
  }
}

async function buildPdfLoadPayload(pdfPath, initialPage = 1, extra = {}) {
  const stats = await fs.stat(pdfPath);
  return {
    pdfPath,
    totalBytes: stats.size,
    initialPage,
    fields: [],
    fieldCount: 0,
    hasFormFields: false,
    ...extra,
  };
}

async function buildActiveDocumentPayload(pdfPath, initialPage = 1, extra = {}) {
  const resolvedPath = resolvePath(pdfPath);
  let defaultFormInfo = {};
  if (extra.fields === undefined && extra.fieldCount === undefined && extra.hasFormFields === undefined) {
    try {
      const { pdfDoc } = await loadPdf(resolvedPath);
      defaultFormInfo = getFormFieldInfo(pdfDoc);
    } catch {
      defaultFormInfo = { fields: [], fieldCount: 0, hasFormFields: false };
    }
  }
  const payload = await buildPdfLoadPayload(resolvedPath, initialPage, {
    ...defaultFormInfo,
    ...extra,
  });
  const backupPath = backupPathByCanonical.get(resolvedPath) || null;
  return {
    ...payload,
    active_path: resolvedPath,
    backup_path: backupPath,
    last_mutation_tool: activeDocumentState.activePath === resolvedPath ? activeDocumentState.lastMutationTool : null,
    last_mutation_at: activeDocumentState.activePath === resolvedPath ? activeDocumentState.lastMutationAt : null,
  };
}

async function persistPdfMutation({
  pdfDoc,
  inputPath,
  outputPath,
  toolName,
  initialPage = 1,
  extraPayload = {},
}) {
  const resolvedInputPath = resolvePath(inputPath);
  const resolvedOutputPath = resolvePath(outputPath);
  let backupPath = backupPathByCanonical.get(resolvedOutputPath) || null;
  if (resolvedInputPath === resolvedOutputPath) {
    backupPath = await ensureBackupForCanonicalPath(resolvedOutputPath);
  }

  const bytes = await pdfDoc.save();
  await writePdfOutputAtomic(resolvedOutputPath, bytes);

  activeDocumentState.activePath = resolvedOutputPath;
  activeDocumentState.backupPath = backupPath;
  activeDocumentState.lastMutationTool = toolName;
  activeDocumentState.lastMutationAt = new Date().toISOString();

  const payload = await buildActiveDocumentPayload(resolvedOutputPath, initialPage, {
    ...getFormFieldInfo(pdfDoc),
    ...extraPayload,
  });
  return { payload, backupPath };
}

function getFormFieldInfo(pdfDoc) {
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    const fieldInfo = fields.map(field => {
      const name = field.getName();
      let type = "unknown";
      let options = [];
      let currentValue = "";
      try {
        if (field.constructor.name.includes("TextField")) {
          type = "text";
          currentValue = field.getText() || "";
        } else if (field.constructor.name.includes("CheckBox")) {
          type = "checkbox";
          currentValue = field.isChecked();
        } else if (field.constructor.name.includes("RadioGroup")) {
          type = "radio";
          currentValue = field.getSelected() || "";
        } else if (field.constructor.name.includes("Dropdown")) {
          type = "dropdown";
          options = field.getOptions();
          currentValue = field.getSelected() || "";
        }
      } catch {}
      return { name, type, options, currentValue };
    });
    return {
      fields: fieldInfo,
      fieldCount: fieldInfo.length,
      hasFormFields: fieldInfo.length > 0,
    };
  } catch {
    return {
      fields: [],
      fieldCount: 0,
      hasFormFields: false,
    };
  }
}

// Helper function to parse CSV
function parseCSV(content) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  let wasQuoted = false;

  const pushValue = () => {
    row.push(wasQuoted ? value : value.trim());
    value = "";
    wasQuoted = false;
  };

  const pushRow = () => {
    pushValue();
    if (row.some(cell => cell !== "")) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"' && value.trim() === "") {
      inQuotes = true;
      wasQuoted = true;
      value = "";
    } else if (char === ",") {
      pushValue();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      if (content[i + 1] === "\n") i++;
      pushRow();
    } else {
      value += char;
    }
  }

  if (inQuotes) {
    throw new Error("Malformed CSV: unterminated quoted field");
  }

  if (value !== "" || row.length > 0) {
    pushRow();
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((header, index) => {
    const normalized = index === 0 ? header.replace(/^\uFEFF/, "").trim() : header.trim();
    if (!normalized) {
      throw new Error(`Malformed CSV: blank header at column ${index + 1}`);
    }
    return normalized;
  });
  const duplicateHeader = headers.find((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeader) {
    throw new Error(`Malformed CSV: duplicate header "${duplicateHeader}"`);
  }

  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(
        `Malformed CSV: row ${rowIndex + 2} has ${values.length} values, expected ${headers.length}`
      );
    }
    return headers.reduce((obj, header, index) => {
      obj[header] = values[index] || "";
      return obj;
    }, {});
  });
}

function formatCSVValue(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

// Helper function to fill PDF fields
async function fillPdfFields(pdfPath, fieldData, password = null) {
  const { pdfDoc } = await loadPdf(pdfPath, password);

  const form = pdfDoc.getForm();
  const filledFields = [];
  const errors = [];
  
  for (const [fieldName, value] of Object.entries(fieldData)) {
    try {
      const field = form.getField(fieldName);
      
      if (field.constructor.name.includes('TextField')) {
        field.setText(String(value));
      } else if (field.constructor.name.includes('CheckBox')) {
        if (value === true || value === 'true' || value === 'yes' || value === '1') {
          field.check();
        } else {
          field.uncheck();
        }
      } else if (field.constructor.name.includes('RadioGroup')) {
        field.select(String(value));
      } else if (field.constructor.name.includes('Dropdown')) {
        field.select(String(value));
      }
      filledFields.push(fieldName);
    } catch (e) {
      if (e.message?.includes('No field')) {
        errors.push(`Field '${fieldName}' not found in PDF. Check field name or use 'read_pdf_fields' to see available fields.`);
      } else {
        errors.push(`Field '${fieldName}': ${e.message}`);
      }
    }
  }
  
  return { pdfDoc, filledFields, errors };
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_pdfs",
        description: "List all PDF files in a directory. This tool operates on the user's local filesystem — all paths must be absolute paths on the user's machine (e.g. /Users/name/Documents/), NOT paths on Claude's container (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            directory: {
              type: "string",
              description: "Directory path to search for PDFs (default: ~/Documents). Must be a local filesystem path."
            }
          }
        },
        annotations: {
          title: "List PDF Files",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_fields",
        description: "Read all form fields from a PDF file and display them in an interactive viewer. Returns field names, types, and current values. Also renders the PDF visually — no need to also call display_pdf. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Read PDF Form Fields",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "fill_pdf",
        description: "Fill a PDF form with provided data and save it. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the filled PDF will be saved"
            },
            field_data: {
              type: "object",
              description: "Object with field names as keys and values to fill"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA layer will be stripped by pdf-lib."
            }
          },
          required: ["pdf_path", "output_path", "field_data"]
        },
        annotations: {
          title: "Fill PDF Form",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "bulk_fill_from_csv",
        description: "Fill multiple PDFs using data from a CSV file",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the template PDF file"
            },
            csv_path: {
              type: "string",
              description: "Path to CSV file with data (first row should be field names)"
            },
            output_directory: {
              type: "string",
              description: "Directory where filled PDFs will be saved"
            },
            filename_column: {
              type: "string",
              description: "CSV column to use for output filenames (optional)"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA layer will be stripped by pdf-lib."
            }
          },
          required: ["pdf_path", "csv_path", "output_directory"]
        },
        annotations: {
          title: "Bulk Fill PDFs from CSV",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "save_profile",
        description: "Save form data as a reusable profile",
        inputSchema: {
          type: "object",
          properties: {
            profile_name: {
              type: "string",
              description: "Name for the profile (e.g., 'work', 'personal')"
            },
            field_data: {
              type: "object",
              description: "Object with field names and values to save"
            }
          },
          required: ["profile_name", "field_data"]
        },
        annotations: {
          title: "Save Form Profile",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "load_profile",
        description: "Load a saved profile",
        inputSchema: {
          type: "object",
          properties: {
            profile_name: {
              type: "string",
              description: "Name of the profile to load"
            }
          },
          required: ["profile_name"]
        },
        annotations: {
          title: "Load Form Profile",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "list_profiles",
        description: "List all saved profiles",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: {
          title: "List Saved Profiles",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "fill_with_profile",
        description: "Fill a PDF using a saved profile",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the filled PDF will be saved"
            },
            profile_name: {
              type: "string",
              description: "Name of the profile to use"
            },
            additional_data: {
              type: "object",
              description: "Additional fields to fill/override (optional)"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["pdf_path", "output_path", "profile_name"]
        },
        annotations: {
          title: "Fill PDF with Profile",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "extract_to_csv",
        description: "Extract form data from filled PDFs to a CSV file",
        inputSchema: {
          type: "object",
          properties: {
            pdf_paths: {
              type: "array",
              items: { type: "string" },
              description: "Array of PDF file paths to extract data from"
            },
            output_csv: {
              type: "string",
              description: "Path where the CSV file will be saved"
            }
          },
          required: ["pdf_paths", "output_csv"]
        },
        annotations: {
          title: "Extract PDF Data to CSV",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "validate_pdf",
        description: "Validate a fillable PDF and report whether required fields are complete. Use this before submission or signing to catch empty required fields without mutating the original document.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the fillable PDF on the user's machine."
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Validate PDF Form",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_content",
        description: "Read PDF text for broad understanding of the document. Best for full-document summarization, question answering, and exploratory analysis when you want a single text-oriented view of the file. If you need page-bounded excerpts or keyword search results, prefer read_pdf_pages or search_pdf_text. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            max_pages: {
              type: "number",
              description: "Maximum number of pages to extract. Useful for very large PDFs when you only need the opening section."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/contract.pdf",
              max_pages: 12
            }
          ]
        },
        annotations: {
          title: "Read PDF Content",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_pages",
        description: "Read a specific page range from a PDF with page-numbered structured output. Use this when the model should inspect or quote a bounded slice of the document instead of loading the whole thing at once. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            start_page: {
              type: "number",
              description: "First page to read (1-indexed, default: 1)."
            },
            end_page: {
              type: "number",
              description: "Last page to read (1-indexed, inclusive, default: start_page)."
            },
            max_chars_per_page: {
              type: "number",
              description: "Maximum characters to return per page in the structured output (default: 4000)."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/nda.pdf",
              start_page: 4,
              end_page: 6
            }
          ]
        },
        annotations: {
          title: "Read PDF Pages",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "render_pdf_page",
        description: "Render one PDF page to a PNG image for visual reasoning. Use this when text extraction is weak, the PDF is scanned/image-only, or the model needs to inspect layout, signatures, handwriting, or tables visually. Returns the rendered page as image content plus page metadata. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            page: {
              type: "number",
              description: "Page number to render (1-indexed, default: 1)."
            },
            max_dimension_px: {
              type: "number",
              description: "Maximum width or height in rendered pixels (default: 1800). Use smaller values for lighter previews."
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/scanned-invoice.pdf",
              page: 1,
              max_dimension_px: 1600
            }
          ]
        },
        annotations: {
          title: "Render PDF Page",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "render_pdf_region",
        description: "Render a rectangular region from one PDF page to a PNG image using the toolkit's top-left point coordinate system. Use this for signatures, handwritten notes, stamps, tables, or any small visual area where the full page is too broad. Coordinates are in PDF points (72 pt = 1 inch) with a TOP-LEFT origin, matching detect_signature_zones and the signing tools. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            page: {
              type: "number",
              description: "Page number to render (1-indexed)."
            },
            x: {
              type: "number",
              description: "Left edge of the region, in points from the left side of the page."
            },
            y: {
              type: "number",
              description: "Top edge of the region, in points from the TOP of the page."
            },
            width: {
              type: "number",
              description: "Width of the region in points."
            },
            height: {
              type: "number",
              description: "Height of the region in points."
            },
            max_dimension_px: {
              type: "number",
              description: "Maximum width or height in rendered pixels for the cropped region (default: 1400)."
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)."
            }
          },
          required: ["pdf_path", "page", "x", "y", "width", "height"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/contract.pdf",
              page: 8,
              x: 72,
              y: 620,
              width: 220,
              height: 80,
              max_dimension_px: 1200
            }
          ]
        },
        annotations: {
          title: "Render PDF Region",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "search_pdf_text",
        description: "Search extracted PDF text for a literal phrase and return page-numbered snippets. Use this when you need to find mentions of a clause, person, amount, or keyword before deciding which pages to inspect more deeply. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            query: {
              type: "string",
              description: "Literal text to search for, such as \"indemnification\" or \"governing law\"."
            },
            max_results: {
              type: "number",
              description: "Maximum number of matching snippets to return (default: 10)."
            },
            context_chars: {
              type: "number",
              description: "Approximate number of surrounding characters to include around each match (default: 160)."
            }
          },
          required: ["pdf_path", "query"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/master-services-agreement.pdf",
              query: "indemnification",
              max_results: 5
            }
          ]
        },
        annotations: {
          title: "Search PDF Text",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "get_pdf_resource_uri",
        description: "Return the PDF's `pdf://...` resource URI so Claude-compatible MCP hosts can reference the binary directly through this server's Resources API. Use this when the host supports MCP resources and you want to hand Claude the document itself rather than only extracted text.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/report.pdf"
            }
          ]
        },
        annotations: {
          title: "Get PDF Resource URI",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "display_pdf",
        description: "Open the interactive PDF viewer with page navigation, zoom, in-document search, text selection, form-field sidebar, and Sign mode. This is the primary tool for visually working with a PDF. If the user gave you a URL instead of a local path, call fetch_pdf_from_url first, then pass the downloaded local path here. Automatically detects form fields, so you usually do not need to also call read_pdf_fields. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            page: {
              type: "number",
              description: "Initial page number to display (default: 1)."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/w9.pdf",
              page: 2
            }
          ]
        },
        annotations: {
          title: "Display PDF Viewer",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "get_active_document",
        description: "Return the toolkit's current active PDF document, including its canonical active_path, any backup_path created on first mutation, and the last mutation metadata. Use this when an agent needs to resume work on the current document without guessing which file is canonical.",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: {
          title: "Get Active Document",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "set_active_document",
        description: "Set or rehydrate the toolkit's active document state from a viewer session. Intended for the viewer to resync the canonical active_path and optional backup_path after MCP/server restarts.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Canonical active PDF path currently shown in the viewer."
            },
            backup_path: {
              type: "string",
              description: "Optional backup path previously created for this document."
            },
            last_mutation_tool: {
              type: "string",
              description: "Optional last mutation tool name to preserve across rehydration."
            },
            last_mutation_at: {
              type: "string",
              description: "Optional ISO-8601 timestamp of the last mutation."
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Set Active Document",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_bytes",
        description: "Read PDF file bytes in chunks (for UI rendering)",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            offset: {
              type: "number",
              description: "Byte offset to start reading from"
            },
            byteCount: {
              type: "number",
              description: "Number of bytes to read (max 524288)"
            }
          },
          required: ["pdf_path", "offset", "byteCount"]
        },
        annotations: {
          title: "Read PDF Bytes",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            visibility: ["app"]
          }
        }
      },
      {
        name: "merge_pdfs",
        description: "Merge multiple PDF files into a single PDF. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_paths: {
              type: "array",
              items: { type: "string" },
              description: "Array of PDF file paths to merge (in order)"
            },
            output_path: {
              type: "string",
              description: "Path where the merged PDF will be saved"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional, applied to all inputs)"
            }
          },
          required: ["input_paths", "output_path"]
        },
        annotations: {
          title: "Merge PDFs",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "split_pdf",
        description: "Split a PDF into multiple files by page ranges (e.g. '1-5,6-10') or at regular intervals (e.g. 'every 5'). All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the PDF file to split"
            },
            page_ranges: {
              type: "string",
              description: "Page ranges: '1-5,6-10,11-15' or 'every 5' for uniform splits"
            },
            output_directory: {
              type: "string",
              description: "Directory where split PDFs will be saved"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["input_path", "page_ranges", "output_directory"]
        },
        annotations: {
          title: "Split PDF",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "rotate_pdf_pages",
        description: "Rotate pages in a PDF by 90, 180, or 270 degrees. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the rotated PDF will be saved"
            },
            pages: {
              type: "array",
              items: { type: "number" },
              description: "Array of 1-based page numbers to rotate (omit or empty array for all pages)"
            },
            degrees: {
              type: "number",
              description: "Rotation angle: 90, 180, or 270"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["input_path", "output_path", "degrees"]
        },
        annotations: {
          title: "Rotate PDF Pages",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "reorder_pdf_pages",
        description: "Rearrange the pages of a PDF in a new order. All pages must be included exactly once (strict permutation). All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the reordered PDF will be saved"
            },
            page_order: {
              type: "array",
              items: { type: "number" },
              description: "Array of 1-based page numbers in desired order, e.g. [3, 1, 2, 4]"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["input_path", "output_path", "page_order"]
        },
        annotations: {
          title: "Reorder PDF Pages",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "get_pdf_info",
        description: "Get metadata about a PDF file: page count, file size, page dimensions, form field count, and whether it is encrypted. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Get PDF Info",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "apply_page_plan",
        description: "Apply a page plan to a PDF: reorder, rotate, and delete pages in one pass. Pages not listed in page_order are excluded (deleted). Writes a new file — original is never modified. All paths must be absolute.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the new PDF will be saved (must differ from input_path)"
            },
            plan: {
              type: "object",
              description: "Page plan object",
              properties: {
                page_order: {
                  type: "array",
                  items: { type: "integer" },
                  description: "1-indexed page numbers in desired order. Pages not listed are excluded (deleted)."
                },
                rotations: {
                  type: "object",
                  description: "Map of original page number (string) to rotation degrees (90, 180, or 270). Entries for excluded pages are silently ignored.",
                  additionalProperties: { type: "number" }
                }
              },
              required: ["page_order"]
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA layer will be stripped by pdf-lib."
            }
          },
          required: ["input_path", "output_path", "plan"]
        },
        annotations: {
          title: "Apply Page Plan",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "get_page_analysis",
        description: "Analyze a PDF and return per-page metadata: text length, text snippet, image presence, dimensions, and orientation. Use this to identify blank pages, sideways pages, and potential duplicates. All paths must be absolute.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            password: {
              type: "string",
              description: "Password for encrypted PDFs (optional)"
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Get Page Analysis",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "create_signature",
        description: "Save a reusable signature the user can apply to PDFs. Two styles: 'typed' uses the user's display name rendered in italic script on apply, 'image' uses a PNG/JPEG the user provides (a scan or photo of their actual signature, or a drawn signature as a data URL). Signatures are stored locally at ~/.pdf-toolkit-files/signatures/. This tool is agent-safe — it does NOT sign any document; it just saves the signature asset for later use by apply_signature.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short identifier for this signature (letters, numbers, hyphens, underscores, spaces, dots). Used to look it up later — e.g. 'mat-default', 'business'."
            },
            display_name: {
              type: "string",
              description: "The user's name as it should appear in attestations, e.g. 'Mat Silverstein'. If provided without an image source, creates a typed signature. If provided with image_path or image_data_url, it is stored as metadata alongside the image signature."
            },
            image_path: {
              type: "string",
              description: "[Image style] Local path to a PNG or JPEG image of the signature (a scan/photo of a handwritten signature). Must be an absolute path on the user's machine."
            },
            image_data_url: {
              type: "string",
              description: "[Image style] Base64 data URL of the signature image, e.g. 'data:image/png;base64,iVBOR...'. Use when the signature was drawn in the viewer or captured from another source."
            },
            overwrite: {
              type: "boolean",
              description: "If a signature with this name already exists, overwrite it (default: false)."
            }
          },
          required: ["name"]
        },
        annotations: {
          title: "Create Signature",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "list_signatures",
        description: "List all saved signatures in ~/.pdf-toolkit-files/signatures/. Returns each signature's name, style (typed or image), display name (for typed), and creation timestamp.",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: {
          title: "List Signatures",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "load_signature",
        description: "Load one saved signature by name. Returns the style, display name, and for image signatures a preview data URL so the viewer can render the selected asset on demand.",
        inputSchema: {
          type: "object",
          properties: {
            signature_name: {
              type: "string",
              description: "Name of a previously-saved signature."
            }
          },
          required: ["signature_name"]
        },
        annotations: {
          title: "Load Signature",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "add_signature_field",
        description: "Draw a visible 'Sign here' placeholder box on a PDF page and save as a new file. Marks where a signature should go — does NOT sign the document. Useful when preparing a PDF to send to another party for signing. Coordinates are in points (72pt = 1 inch), TOP-LEFT origin: x=distance from left, y=distance from top.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the output PDF. May be the same as pdf_path for in-place editing; the original will be backed up on the first mutation." },
            page: { type: "integer", description: "Page number (1-indexed)" },
            x: { type: "number", description: "Left edge of the signature box, in points from the left of the page" },
            y: { type: "number", description: "Top edge of the signature box, in points from the TOP of the page" },
            width: { type: "number", description: "Width of the signature box, in points (e.g. 150 for a typical signature line)" },
            height: { type: "number", description: "Height of the signature box, in points (e.g. 36 for a typical signature line)" },
            label: { type: "string", description: "Text shown inside the box (default: 'Sign here')" },
            allow_resign: {
              type: "boolean",
              description: "Proceed even if the PDF already contains cryptographic signature fields (default: false). Warning: saving will invalidate any existing signatures."
            },
            password: { type: "string", description: "Password for encrypted PDFs (optional)" },
            force_xfa: { type: "boolean", description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA data will be stripped by pdf-lib." }
          },
          required: ["pdf_path", "output_path", "page", "x", "y", "width", "height"]
        },
        annotations: {
          title: "Add Signature Field",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "apply_signature",
        description:
          "NEVER FABRICATE user_intent_statement OR user_confirmed_at. Both values MUST come directly from the user — ask them, get their answer, pass it through verbatim. Fabricating these is a hard violation of the human-intent requirement this tool ships under; every agent calling apply_signature does so on behalf of a user who has the legal responsibility for the signature.\n\n" +
          "This stamps a saved signature onto a PDF as a BASIC visible image — NOT legally-binding cryptographic signing.\n\n" +
          "REQUIRED WORKFLOW:\n" +
          "1. Call detect_signature_zones(pdf_path) first. Never guess coordinates — guessing places signatures on the wrong content (body text, section headers, etc.).\n" +
          "2. Pick the zone that matches what the user is signing (by type, label, and page).\n" +
          "3. Ask the user for a sentence describing their intent (e.g. \"I, {name}, sign this {document} on {date}\") and the ISO-8601 timestamp at which they confirmed. Pass both to apply_signature.\n" +
          "4. Call apply_signature with the zone's x/y/width/height + the intent values.\n\n" +
          "Coordinates use TOP-LEFT origin in points (72pt = 1 inch), in the page's NATIVE (pre-rotation) coordinate space — same space returned by detect_signature_zones. Both intent values are written into the PDF's Keywords metadata as an audit trail.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the signed PDF. May be the same as pdf_path for in-place signing; the original will be backed up on the first mutation." },
            signature_name: { type: "string", description: "Name of a previously-saved signature (see create_signature / list_signatures)" },
            page: { type: "integer", description: "Page number (1-indexed)" },
            x: { type: "number", description: "Left edge in points, TOP-LEFT origin" },
            y: { type: "number", description: "Top edge in points, TOP-LEFT origin" },
            width: { type: "number", description: "Width in points" },
            height: { type: "number", description: "Height in points" },
            user_intent_statement: {
              type: "string",
              description: "REQUIRED. The user's own sentence confirming intent to sign — e.g. \"I, Mat Silverstein, sign this W-9 application on 2026-04-16.\" Ask the user for this verbatim; do not invent it."
            },
            user_confirmed_at: {
              type: "string",
              description: "REQUIRED. ISO-8601 timestamp of when the user confirmed signing, e.g. \"2026-04-16T19:32:00Z\". Must be within the last 24 hours. Ask the user; do not fabricate."
            },
            draw_audit_line: {
              type: "boolean",
              description: "Also draw a small visible timestamp/signer line below the signature (default: false). Useful for printable audit trails."
            },
            signing_mode: {
              type: "string",
              enum: ["signature", "initials"],
              description: "Optional semantic label for the visible mark. Use 'initials' when applying a mark to an initials zone so results and audit metadata say 'initialed' instead of 'signed'."
            },
            allow_resign: {
              type: "boolean",
              description: "Proceed even if the PDF already contains cryptographic signature fields (default: false). Warning: saving will invalidate any existing signatures. Only enable if the user explicitly wants to re-sign a previously-signed document."
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA layer will be stripped by pdf-lib."
            },
            overwrite: {
              type: "boolean",
              description: "Legacy no-op. Same-path in-place signing is allowed and creates a backup on the first mutation."
            },
            password: { type: "string", description: "Password for encrypted PDFs (optional)" }
          },
          required: ["pdf_path", "output_path", "signature_name", "page", "x", "y", "width", "height", "user_intent_statement", "user_confirmed_at"]
        },
        annotations: {
          title: "Apply Signature",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "prepare_signing_packet",
        description: "One-shot workflow: fill form fields AND add 'Sign here' placeholder boxes to a PDF in a single pass, saving as a new file. Returns a manifest of all pending signature locations (named by label). Does NOT apply any signatures — that still requires apply_signature with human intent. Use this when an agent has filled out everything it can and is preparing the PDF for the user (or another party) to sign.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the prepared PDF. May be the same as pdf_path for in-place editing; the original will be backed up on the first mutation." },
            field_values: {
              type: "object",
              description: "Optional map of AcroForm field name → value. Same shape as fill_pdf's 'fields' argument.",
              additionalProperties: true
            },
            signature_locations: {
              type: "array",
              description: "Sign-here boxes to add. Coordinates use TOP-LEFT origin in points.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Label shown in the box, e.g. 'Signature (Applicant)'" },
                  page: { type: "integer" },
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" }
                },
                required: ["page", "x", "y", "width", "height"]
              }
            },
            allow_resign: {
              type: "boolean",
              description: "Proceed even if the PDF already contains cryptographic signature fields (default: false). Warning: saving will invalidate any existing signatures."
            },
            password: { type: "string", description: "Password for encrypted PDFs (optional)" },
            force_xfa: { type: "boolean", description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA layer will be stripped." }
          },
          required: ["pdf_path", "output_path"]
        },
        annotations: {
          title: "Prepare Signing Packet",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "apply_text",
        description: "Stamp a plain text string at a location on a PDF, saving the result as a new file. Use this for date zones (stamp today's date), or any other \"put these characters here\" operation that isn't a signature. NO user_intent_statement required — text is not a signature. Coordinates use TOP-LEFT origin in points, same as apply_signature. Writes a one-line audit entry to the PDF's Keywords metadata.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the stamped PDF. May be the same as pdf_path for in-place editing; the original will be backed up on the first mutation." },
            page: { type: "integer", description: "Page number (1-indexed)" },
            x: { type: "number", description: "Left edge in points, TOP-LEFT origin" },
            y: { type: "number", description: "Top edge in points, TOP-LEFT origin" },
            width: { type: "number", description: "Width in points" },
            height: { type: "number", description: "Height in points" },
            text: { type: "string", description: "Text to stamp (max 200 chars)" },
            font_style: { type: "string", enum: ["normal", "italic"], description: "Font style (default: normal)" },
            allow_resign: { type: "boolean", description: "Proceed even if the PDF has existing cryptographic signatures (default: false — saving would invalidate them)" },
            force_xfa: { type: "boolean", description: "Proceed even if the PDF uses XFA forms (default: false — the XFA layer will be stripped)" },
            overwrite: {
              type: "boolean",
              description: "Legacy no-op. Same-path in-place stamping is allowed and creates a backup on the first mutation."
            },
            password: { type: "string", description: "Password for encrypted PDFs (optional)" }
          },
          required: ["pdf_path", "output_path", "page", "x", "y", "width", "height", "text"]
        },
        annotations: {
          title: "Apply Text",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "detect_signature_zones",
        description: "Find every place in a PDF where a signature, initials, or date should go. Returns a typed list of zones with coordinates (top-left origin, points). Use this BEFORE apply_signature — never guess coordinates, always apply at a returned zone. Detection layers: (1) AcroForm signature fields (confidence 0.99), (2) AcroForm fields named 'signature' / 'initials' (0.85), (3) text patterns like 'Signature of…', 'Sign Here', 'Initials:' (0.70-0.92). Each zone includes: type (signature/initials/date), label, page, x/y/width/height, confidence, source. Multi-page forms return zones for every page. If nothing is detected (flat scans, unusual forms), the agent should ask the user to pick a location in the viewer rather than guess.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the PDF file" },
            password: { type: "string", description: "Password for encrypted PDFs (optional)" }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Detect Signature Zones",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "fetch_pdf_from_url",
        description: "Download a PDF from any URL — the PREFERRED way to grab any PDF from a URL for the user. **Always use this for PDF URLs; do NOT use bash, curl, wget, or WebFetch first.** Those run in Claude's sandbox and fail on many domains (gov sites, enterprise, auth-required URLs); this tool runs on the user's machine with full network access and succeeds where they don't. Returns a local file path that plugs into every other PDF tool here (display_pdf, read_pdf_fields, fill_pdf, validate_pdf, detect_signature_zones, apply_signature, merge_pdfs, etc.). If the user mentions a PDF URL in any way — \"download this,\" \"open this link,\" \"sign this,\" \"fill out\" — this is your first move before any other tool.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "HTTP or HTTPS URL of a PDF to download"
            },
            filename: {
              type: "string",
              description: "Optional filename for the saved PDF (default: derived from the URL and sanitized; '.pdf' appended if missing)"
            },
            destination_dir: {
              type: "string",
              description: "Optional local directory to save into (default: ~/Downloads/). Must be a local path on the user's machine — NOT a Claude container path like /mnt/..."
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite if a file with the same name exists (default: false — appends ' (2)', ' (3)', etc.)"
            },
            max_size_mb: {
              type: "number",
              description: "Maximum download size in MB (default: 100). Raise for larger PDFs."
            },
            headers: {
              type: "object",
              description: "Optional HTTP headers, e.g. { \"Authorization\": \"Bearer ...\" } for authenticated URLs.",
              additionalProperties: { type: "string" }
            },
            allow_private_hosts: {
              type: "boolean",
              description: "Allow downloads from localhost / private IP ranges. Default false for safety. Only enable for trusted intranet PDFs."
            }
          },
          required: ["url"]
        },
        annotations: {
          title: "Fetch PDF from URL",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true
        }
      },
      {
        name: "reveal_in_finder",
        description: "Open the OS file manager with the given file selected (macOS: Finder → Reveal; Windows: Explorer → select; Linux: opens the enclosing folder). Used by the viewer to surface the active PDF or its backup so the user can immediately see the relevant file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file to reveal." }
          },
          required: ["path"]
        },
        annotations: {
          title: "Reveal File in Finder",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      }
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_pdfs": {
        const directory = resolvePath(args.directory || DEFAULT_PDF_DIR);
        const files = await fs.readdir(directory);
        const pdfFiles = files
          .filter(file => file.toLowerCase().endsWith('.pdf'))
          .map(file => path.join(directory, file));
        
        return {
          content: [
            {
              type: "text",
              text: `Found ${pdfFiles.length} PDF files:\n${pdfFiles.join('\n')}`
            }
          ],
        };
      }

      case "read_pdf_fields": {
        const { pdf_path, password } = args;
        const { pdfDoc, resolvedPath } = await loadPdf(pdf_path, password);
        noteDocumentOpened(resolvedPath);

        const form = pdfDoc.getForm();
        const fields = form.getFields();
        
        const fieldInfo = fields.map(field => {
          const name = field.getName();
          let type = "unknown";
          let options = [];
          let currentValue = "";
          
          try {
            if (field.constructor.name.includes('TextField')) {
              type = "text";
              currentValue = field.getText() || "";
            } else if (field.constructor.name.includes('CheckBox')) {
              type = "checkbox";
              currentValue = field.isChecked();
            } else if (field.constructor.name.includes('RadioGroup')) {
              type = "radio";
              currentValue = field.getSelected() || "";
            } else if (field.constructor.name.includes('Dropdown')) {
              type = "dropdown";
              options = field.getOptions();
              currentValue = field.getSelected() || "";
            }
          } catch (e) {
            // Field type detection failed
          }
          
          return { name, type, options, currentValue };
        });
        
        const payload = await buildActiveDocumentPayload(resolvedPath, 1, {
          fields: fieldInfo,
          fieldCount: fields.length,
          hasFormFields: fields.length > 0,
        });
        return {
          content: [
            {
              type: "text",
              text: `PDF has ${fields.length} form fields:\n${JSON.stringify(fieldInfo, null, 2)}`
            }
          ],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            viewUUID: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ...payload,
          }
        };
      }

      case "fill_pdf": {
        const { pdf_path, output_path, field_data, password, force_xfa = false } = args;
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedOutputPath = resolvePath(output_path);
        const rawPdfBytes = await fs.readFile(resolvedPdfPath);
        assertXfaMutationAllowed(rawPdfBytes, { forceXfa: force_xfa });
        const { pdfDoc, filledFields, errors } = await fillPdfFields(resolvedPdfPath, field_data, password);
        const { payload, backupPath } = await persistPdfMutation({
          pdfDoc,
          inputPath: resolvedPdfPath,
          outputPath: resolvedOutputPath,
          toolName: "fill_pdf",
          extraPayload: {
            filled_fields: filledFields,
            fill_errors: errors,
          },
        });
        
        let message = `PDF filled successfully and saved to: ${output_path}\n`;
        message += `Fields filled: ${filledFields.length}`;
        if (backupPath) {
          message += `\nOriginal backed up to: ${backupPath}`;
        }
        if (errors.length > 0) {
          message += `\nErrors:\n${errors.join('\n')}`;
        }
        
        return {
          content: [{
            type: "text",
            text: message
          }],
          structuredContent: payload,
        };
      }

      case "bulk_fill_from_csv": {
        const { pdf_path, csv_path, output_directory, filename_column, password, force_xfa = false } = args;
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedCsvPath = resolvePath(csv_path);
        const resolvedOutputDir = resolvePath(output_directory);
        const rawPdfBytes = await fs.readFile(resolvedPdfPath);
        assertXfaMutationAllowed(rawPdfBytes, { forceXfa: force_xfa });
        
        // Read CSV
        const csvContent = await fs.readFile(resolvedCsvPath, 'utf8');
        const records = parseCSV(csvContent);
        
        // Ensure output directory exists
        await fs.mkdir(resolvedOutputDir, { recursive: true });
        
        const results = [];
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          let rawName = filename_column && record[filename_column]
            ? record[filename_column]
            : `filled_${i + 1}`;
          // Sanitize filename to prevent path traversal
          rawName = path.basename(rawName).replace(/[/\\]/g, "_");
          const filename = `${rawName}.pdf`;
          const outputPath = path.join(resolvedOutputDir, filename);
          
          try {
            const { pdfDoc, filledFields, errors } = await fillPdfFields(resolvedPdfPath, record, password);
            const filledPdfBytes = await pdfDoc.save();
            await fs.writeFile(outputPath, filledPdfBytes);
            results.push({
              filename,
              output_path: outputPath,
              fields_filled: filledFields.length,
              errors,
              status: errors.length > 0 ? "warning" : "ok",
            });
          } catch (e) {
            results.push({
              filename,
              output_path: outputPath,
              fields_filled: 0,
              errors: [e.message],
              status: "error",
            });
          }
        }

        const resultLines = results.map(result => {
          const marker = result.status === "error" ? "✗" : result.status === "warning" ? "!" : "✓";
          const suffix = result.errors.length > 0 ? ` (${result.errors.length} warnings/errors)` : "";
          return `${marker} ${result.filename}: ${result.fields_filled} fields filled${suffix}`;
        });
        
        return {
          content: [{
            type: "text",
            text: `Bulk fill complete!\n${resultLines.join('\n')}`
          }],
          structuredContent: {
            row_count: records.length,
            results,
            preview_records: records.slice(0, 3),
          },
        };
      }

      case "save_profile": {
        const { profile_name, field_data } = args;
        validateProfileName(profile_name);
        const profilePath = path.join(PROFILES_DIR, `${profile_name}.json`);
        
        await fs.writeFile(profilePath, JSON.stringify(field_data, null, 2));
        
        return {
          content: [{
            type: "text",
            text: `Profile '${profile_name}' saved successfully!`
          }],
        };
      }

      case "load_profile": {
        const { profile_name } = args;
        validateProfileName(profile_name);
        const profilePath = path.join(PROFILES_DIR, `${profile_name}.json`);
        
        const profileData = await fs.readFile(profilePath, 'utf8');
        
        return {
          content: [{
            type: "text",
            text: `Profile '${profile_name}' loaded:\n${profileData}`
          }],
        };
      }

      case "list_profiles": {
        const files = await fs.readdir(PROFILES_DIR);
        const profiles = files
          .filter(file => file.endsWith('.json'))
          .map(file => file.replace('.json', ''));
        
        return {
          content: [{
            type: "text",
            text: profiles.length > 0 
              ? `Available profiles:\n${profiles.join('\n')}`
              : "No profiles saved yet"
          }],
        };
      }

      case "fill_with_profile": {
        const { pdf_path, output_path, profile_name, additional_data = {}, password } = args;
        validateProfileName(profile_name);
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedOutputPath = resolvePath(output_path);

        // Load profile
        const profilePath = path.join(PROFILES_DIR, `${profile_name}.json`);
        const profileData = JSON.parse(await fs.readFile(profilePath, 'utf8'));
        
        // Merge profile data with additional data
        const mergedData = { ...profileData, ...additional_data };
        
        const { pdfDoc, filledFields, errors } = await fillPdfFields(resolvedPdfPath, mergedData, password);
        const { payload, backupPath } = await persistPdfMutation({
          pdfDoc,
          inputPath: resolvedPdfPath,
          outputPath: resolvedOutputPath,
          toolName: "fill_with_profile",
          extraPayload: {
            profile_name,
            filled_fields: filledFields,
            fill_errors: errors,
          },
        });
        
        return {
          content: [{
            type: "text",
            text:
              `PDF filled with profile '${profile_name}' and saved to: ${output_path}\nFields filled: ${filledFields.length}` +
              (backupPath ? `\nOriginal backed up to: ${backupPath}` : "")
          }],
          structuredContent: payload,
        };
      }

      case "extract_to_csv": {
        const { pdf_paths, output_csv } = args;
        const resolvedOutputCsv = resolvePath(output_csv);
        const allData = [];
        const allFieldNames = new Set();
        
        // Extract data from each PDF
        for (const pdfPath of pdf_paths) {
          const resolvedPdfPath = resolvePath(pdfPath);
          const pdfBytes = await fs.readFile(resolvedPdfPath);
          const pdfDoc = await PDFDocument.load(pdfBytes);
          const form = pdfDoc.getForm();
          const fields = form.getFields();
          
          const rowData = { _filename: path.basename(pdfPath) };
          
          for (const field of fields) {
            const fieldName = field.getName();
            allFieldNames.add(fieldName);
            
            try {
              if (field.constructor.name.includes('TextField')) {
                rowData[fieldName] = field.getText() || "";
              } else if (field.constructor.name.includes('CheckBox')) {
                rowData[fieldName] = field.isChecked() ? "yes" : "no";
              } else if (field.constructor.name.includes('RadioGroup') || 
                         field.constructor.name.includes('Dropdown')) {
                rowData[fieldName] = field.getSelected() || "";
              }
            } catch (e) {
              rowData[fieldName] = "";
            }
          }
          
          allData.push(rowData);
        }
        
        // Create CSV
        const headers = ['_filename', ...Array.from(allFieldNames).sort()];
        const csvLines = [headers.map(formatCSVValue).join(',')];
        
        for (const row of allData) {
          const values = headers.map(h => row[h] || "");
          csvLines.push(values.map(formatCSVValue).join(','));
        }
        
        await fs.writeFile(resolvedOutputCsv, csvLines.join('\n'));
        
        return {
          content: [{
            type: "text",
            text: `Extracted data from ${pdf_paths.length} PDFs to: ${output_csv}\nFields extracted: ${allFieldNames.size}\nPreview rows returned in structuredContent.`
          }],
          structuredContent: {
            output_csv: resolvedOutputCsv,
            source_pdf_count: pdf_paths.length,
            field_count: allFieldNames.size,
            row_count: allData.length,
            preview_row_count: Math.min(allData.length, 3),
            headers,
            preview_rows: allData.slice(0, 3),
          },
        };
      }

      case "validate_pdf": {
        const { pdf_path, password } = args;
        const { pdfDoc } = await loadPdf(pdf_path, password);

        const form = pdfDoc.getForm();
        const fields = form.getFields();
        
        const validation = {
          total: fields.length,
          filled: 0,
          empty: 0,
          required: [],
          emptyFields: []
        };
        
        for (const field of fields) {
          const fieldName = field.getName();
          let isEmpty = true;
          
          try {
            if (field.constructor.name.includes('TextField')) {
              isEmpty = !field.getText() || field.getText().trim() === "";
            } else if (field.constructor.name.includes('CheckBox')) {
              isEmpty = false; // Checkboxes are either checked or not
            } else if (field.constructor.name.includes('RadioGroup') || 
                       field.constructor.name.includes('Dropdown')) {
              isEmpty = !field.getSelected();
            }
            
            // Check if field is required (common patterns)
            const isRequired = fieldName.toLowerCase().includes('required') ||
                             fieldName.includes('*') ||
                             fieldName.toLowerCase().includes('must');
            
            if (isEmpty) {
              validation.empty++;
              validation.emptyFields.push(fieldName);
              if (isRequired) {
                validation.required.push(fieldName);
              }
            } else {
              validation.filled++;
            }
          } catch (e) {
            validation.empty++;
            validation.emptyFields.push(`${fieldName} (error reading)`);
          }
        }
        
        let message = `PDF Validation Report for: ${path.basename(pdf_path)}\n`;
        message += `Total fields: ${validation.total}\n`;
        message += `Filled: ${validation.filled}\n`;
        message += `Empty: ${validation.empty}\n`;
        
        if (validation.required.length > 0) {
          message += `\n⚠️  Required fields that are empty:\n`;
          message += validation.required.join('\n');
        }
        
        if (validation.emptyFields.length > 0 && validation.emptyFields.length <= 10) {
          message += `\n\nEmpty fields:\n`;
          message += validation.emptyFields.join('\n');
        } else if (validation.emptyFields.length > 10) {
          message += `\n\nFirst 10 empty fields:\n`;
          message += validation.emptyFields.slice(0, 10).join('\n');
          message += `\n... and ${validation.emptyFields.length - 10} more`;
        }
        
        return {
          content: [{
            type: "text",
            text: message
          }],
        };
      }

      case "read_pdf_content": {
        const { pdf_path, max_pages } = args;
        const resolvedPath = resolvePath(pdf_path);
        const MAX_CHARS = 50000;
        const PREVIEW_MAX_CHARS = 12000;

        try {
          // Verify the file exists
          await fs.access(resolvedPath);

          // Get file info
          const stats = await fs.stat(resolvedPath);
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (stats.size / 1024).toFixed(2);

          // Read the PDF buffer
          const pdfBuffer = await fs.readFile(resolvedPath);

          // Extract text content using pdfjs-dist
          const result = await withSuppressedStderr(() => extractPdfText(pdfBuffer, max_pages));
          let extractedText = result.text;
          const pageCount = result.totalPages;
          const pagesRead = result.pagesRead;
          const pagePreview = buildPageTextSegments(result.pages, {
            startPage: 1,
            endPage: pagesRead,
            maxCharsPerPage: 2000,
            maxTotalChars: PREVIEW_MAX_CHARS,
          });

          // Prepare the response
          let response = `PDF Content Extracted Successfully!\n\n`;
          response += `File: ${fileName}\n`;
          response += `Size: ${fileSizeKB} KB\n`;
          response += `Pages: ${pageCount}`;
          if (pagesRead < pageCount) {
            response += ` (extracted ${pagesRead} of ${pageCount})`;
          }
          response += `\n`;
          response += `Text Length: ${extractedText.length} characters\n`;

          // Truncate if too large for context window
          let truncated = false;
          if (extractedText.length > MAX_CHARS) {
            extractedText = extractedText.substring(0, MAX_CHARS);
            truncated = true;
            response += `\n⚠️ Output truncated to ${MAX_CHARS} characters. Use max_pages to limit extraction scope.\n`;
          }

          response += `\n${"=".repeat(50)}\n`;
          response += `EXTRACTED TEXT:\n`;
          response += `${"=".repeat(50)}\n\n`;
          response += extractedText;

          if (truncated) {
            response += `\n\n... [TRUNCATED — ${MAX_CHARS} char limit reached] ...`;
          }

          // Check if text was extracted
          if (!extractedText || extractedText.trim().length === 0) {
            // No text found - try to extract first page as image
            try {
              response = `No text could be extracted from this PDF (likely a scanned document).\n`;
              response += `Converting page 1 to image for visual analysis...\n\n`;
              response += `File: ${fileName}\n`;
              response += `Size: ${fileSizeKB} KB\n`;
              response += `Pages: ${pageCount}\n`;
              
              // Calculate scale to keep image size reasonable
              // Target ~500KB after base64 encoding (roughly 375KB raw)
              const targetSizeKB = 375;
              const scaleFactor = Math.min(1.5, Math.sqrt(targetSizeKB / parseFloat(fileSizeKB)));
              
              // Convert first page to image
              const imageBuffer = await convertPdfPageToImage(pdfBuffer, 1, scaleFactor);
              const imageSizeKB = (imageBuffer.length / 1024).toFixed(2);
              
              response += `\nPage 1 extracted as image (${imageSizeKB} KB, scale: ${scaleFactor.toFixed(2)})\n`;
              
              // Return as image content
              return {
                content: [{
                  type: "text",
                  text: response
                }, {
                  type: "image",
                  data: imageBuffer.toString("base64"),
                  mimeType: "image/png"
                }],
                structuredContent: {
                  pdf_path: resolvedPath,
                  file_name: fileName,
                  total_pages: pageCount,
                  pages_read: pagesRead,
                  text_length: 0,
                  text_truncated: false,
                  text_found: false,
                  page_previews: [],
                  preview_truncated: false,
                  extraction_mode: "image-fallback",
                },
              };
            } catch (imageError) {
              // If image extraction also fails, return error message
              response += `\n\nNote: No text could be extracted from this PDF, and image extraction also failed.\n`;
              response += `Error: ${imageError.message}\n`;
              response += `This might be because:\n`;
              response += `- The PDF is encrypted or has restrictions\n`;
              response += `- The PDF is corrupted\n`;
              response += `- Memory limitations\n`;
            }
          }
          
          return {
            content: [{
              type: "text",
              text: response
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              total_pages: pageCount,
              pages_read: pagesRead,
              text_length: result.text.length,
              text_truncated: truncated,
              text_found: extractedText.trim().length > 0,
              page_previews: pagePreview.pages,
              preview_truncated: pagePreview.truncated,
              extraction_mode: "text",
            },
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error reading PDF file: ${error.message}\n\nPlease ensure the file path is correct and the file exists.`
            }],
          };
        }
      }

      case "read_pdf_pages": {
        const {
          pdf_path,
          start_page = 1,
          end_page = start_page || 1,
          max_chars_per_page = 4000,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          await fs.access(resolvedPath);

          const stats = await fs.stat(resolvedPath);
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (stats.size / 1024).toFixed(2);
          const pdfBuffer = await fs.readFile(resolvedPath);
          const requestedStart = Math.max(1, Number(start_page) || 1);
          const requestedEnd = Math.max(requestedStart, Number(end_page) || requestedStart);

          const result = await withSuppressedStderr(() => extractPdfText(pdfBuffer, requestedEnd));
          if (requestedStart > result.totalPages) {
            throw new Error(`start_page ${requestedStart} is out of range (1-${result.totalPages}).`);
          }
          if (requestedEnd > result.totalPages) {
            throw new Error(`end_page ${requestedEnd} is out of range (1-${result.totalPages}).`);
          }

          const segments = buildPageTextSegments(result.pages, {
            startPage: requestedStart,
            endPage: requestedEnd,
            maxCharsPerPage: Number(max_chars_per_page) || 4000,
            maxTotalChars: 16000,
          });

          let response =
            `Read pages ${requestedStart}-${requestedEnd} from ${fileName}\n` +
            `Size: ${fileSizeKB} KB\n` +
            `Document pages: ${result.totalPages}\n` +
            `Returned pages: ${segments.pages.length}\n`;

          if (segments.truncated) {
            response += `\nSome page text was truncated to keep the result bounded. Use a narrower page range if you need more detail.\n`;
          }

          const nonEmptyPages = segments.pages.filter(page => page.text.trim().length > 0);
          if (nonEmptyPages.length === 0) {
            response += `\nNo extractable text was found on the requested pages. The document may be scanned or image-only.`;
          } else {
            response += `\n`;
            for (const page of segments.pages) {
              response += `\n${"=".repeat(20)} PAGE ${page.page} ${"=".repeat(20)}\n`;
              response += page.text || "[No extractable text]";
              if (page.truncated) {
                response += `\n\n...[PAGE ${page.page} TRUNCATED]...`;
              }
              response += `\n`;
            }
          }

          return {
            content: [{
              type: "text",
              text: response.trimEnd(),
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              total_pages: result.totalPages,
              start_page: requestedStart,
              end_page: requestedEnd,
              pages: segments.pages,
              text_found: nonEmptyPages.length > 0,
              truncated: segments.truncated,
            },
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error reading PDF pages: ${error.message}\n\nPlease ensure the file path is correct and the requested page range is valid.`
            }],
          };
        }
      }

      case "render_pdf_page": {
        const {
          pdf_path,
          page = 1,
          max_dimension_px = 1800,
          password = null,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          await fs.access(resolvedPath);

          const { pdfDoc, pdfBytes } = await loadPdf(resolvedPath, password);
          const totalPages = pdfDoc.getPageCount();
          const targetPage = Math.max(1, Number(page) || 1);
          if (targetPage > totalPages) {
            throw new Error(`Page ${targetPage} is out of range (1-${totalPages}).`);
          }

          const targetPdfPage = pdfDoc.getPages()[targetPage - 1];
          const { width, height } = targetPdfPage.getSize();
          const scale = getPageRenderScale({
            width,
            height,
            maxDimensionPx: Number(max_dimension_px) || 1800,
          });
          const imageBuffer = await convertPdfPageToImage(pdfBytes, targetPage, scale, password);
          const renderedWidth = Math.round(width * scale);
          const renderedHeight = Math.round(height * scale);
          const fileName = path.basename(resolvedPath);

          return {
            content: [{
              type: "text",
              text:
                `Rendered page ${targetPage} of ${fileName} as PNG.\n` +
                `Document pages: ${totalPages}\n` +
                `Rendered size: ${renderedWidth} x ${renderedHeight} px\n` +
                `Scale: ${scale.toFixed(2)}x`
            }, {
              type: "image",
              data: imageBuffer.toString("base64"),
              mimeType: "image/png",
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              page: targetPage,
              total_pages: totalPages,
              width_points: Math.round(width),
              height_points: Math.round(height),
              rendered_width_px: renderedWidth,
              rendered_height_px: renderedHeight,
              scale,
              mime_type: "image/png",
            },
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error rendering PDF page: ${error.message}\n\nPlease ensure the file path is correct and the requested page can be rendered.`
            }],
          };
        }
      }

      case "render_pdf_region": {
        const {
          pdf_path,
          page,
          x,
          y,
          width,
          height,
          max_dimension_px = 1400,
          password = null,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          await fs.access(resolvedPath);

          const { pdfDoc, pdfBytes } = await loadPdf(resolvedPath, password);
          const totalPages = pdfDoc.getPageCount();
          const targetPage = Math.max(1, Number(page) || 1);
          if (targetPage > totalPages) {
            throw new Error(`Page ${targetPage} is out of range (1-${totalPages}).`);
          }

          const targetPdfPage = pdfDoc.getPages()[targetPage - 1];
          const { width: pageWidth, height: pageHeight } = targetPdfPage.getSize();
          const region = {
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height),
          };
          validatePdfRegionBox({
            pageWidth,
            pageHeight,
            ...region,
          });

          const scale = getPageRenderScale({
            width: region.width,
            height: region.height,
            maxDimensionPx: Number(max_dimension_px) || 1400,
            minScale: 0.1,
            maxScale: 4,
          });
          const crop = getRegionPixelRect({
            ...region,
            scale,
          });
          const imageBuffer = await convertPdfRegionToImage(pdfBytes, {
            pageNumber: targetPage,
            scale,
            ...region,
            password,
          });
          const fileName = path.basename(resolvedPath);

          return {
            content: [{
              type: "text",
              text:
                `Rendered region from page ${targetPage} of ${fileName} as PNG.\n` +
                `Region (pt): (${region.x}, ${region.y}, ${region.width} x ${region.height})\n` +
                `Rendered crop: ${crop.width} x ${crop.height} px\n` +
                `Scale: ${scale.toFixed(2)}x`
            }, {
              type: "image",
              data: imageBuffer.toString("base64"),
              mimeType: "image/png",
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              page: targetPage,
              total_pages: totalPages,
              region_points: region,
              rendered_width_px: crop.width,
              rendered_height_px: crop.height,
              scale,
              mime_type: "image/png",
            },
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error rendering PDF region: ${error.message}\n\nPlease ensure the file path, page, and region coordinates are valid.`
            }],
          };
        }
      }

      case "search_pdf_text": {
        const {
          pdf_path,
          query,
          max_results = 10,
          context_chars = 160,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          await fs.access(resolvedPath);

          const stats = await fs.stat(resolvedPath);
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (stats.size / 1024).toFixed(2);
          const pdfBuffer = await fs.readFile(resolvedPath);

          const result = await withSuppressedStderr(() => extractPdfText(pdfBuffer));
          const matches = searchPageTexts(result.pages, query, {
            maxResults: Number(max_results) || 10,
            contextChars: Number(context_chars) || 160,
          });

          let response =
            `Search results for "${matches.query}" in ${fileName}\n` +
            `Size: ${fileSizeKB} KB\n` +
            `Document pages: ${result.totalPages}\n` +
            `Matches returned: ${matches.matchCount}\n`;

          if (matches.matchCount === 0) {
            response += `\nNo matches found.`;
          } else {
            if (matches.truncated) {
              response += `\nShowing the first ${matches.matchCount} matches. Narrow the query or increase max_results for more.\n`;
            }
            response += `\n`;
            for (const match of matches.matches) {
              response += `\n- Page ${match.page}: ${match.snippet}\n`;
            }
          }

          return {
            content: [{
              type: "text",
              text: response.trimEnd(),
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              total_pages: result.totalPages,
              query: matches.query,
              match_count: matches.matchCount,
              truncated: matches.truncated,
              matches: matches.matches,
            },
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error searching PDF text: ${error.message}\n\nPlease ensure the file path is correct and the query is valid.`
            }],
          };
        }
      }

      case "get_pdf_resource_uri": {
        const { pdf_path } = args;
        const resolvedPath = resolvePath(pdf_path);
        
        try {
          // Verify the file exists
          await fs.access(resolvedPath);
          
          // Get file info
          const stats = await fs.stat(resolvedPath);
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (stats.size / 1024).toFixed(2);
          
          // Create the resource URI
          const resourceUri = `pdf://${resolvedPath}`;
          
          return {
            content: [{
              type: "text",
              text: `Resource URI created: ${resourceUri}\n\nFile: ${fileName}\nSize: ${fileSizeKB} KB\n\nClaude can now read this PDF through the Resources API using this URI.`
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error accessing PDF file: ${error.message}\n\nPlease ensure the file path is correct and the file exists.`
            }],
          };
        }
      }

      case "display_pdf": {
        const { pdf_path, page } = args;
        const resolvedPath = resolvePath(pdf_path);
        const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

        await fs.access(resolvedPath);
        const stats = await fs.stat(resolvedPath);

        if (stats.size > MAX_FILE_SIZE) {
          return {
            content: [{ type: "text", text: `PDF exceeds 100MB limit (${(stats.size / 1024 / 1024).toFixed(1)}MB). Use read_pdf_content for text extraction instead.` }],
            isError: true,
          };
        }

        const fileName = path.basename(resolvedPath);
        const initialPage = Math.max(1, page || 1);
        noteDocumentOpened(resolvedPath);

        // Detect and extract form fields
        let hasFormFields = false;
        let fieldCount = 0;
        let fieldInfo = [];
        try {
          const pdfBytes = await fs.readFile(resolvedPath);
          const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const form = pdfDoc.getForm();
          const fields = form.getFields();
          fieldCount = fields.length;
          hasFormFields = fieldCount > 0;

          if (hasFormFields) {
            fieldInfo = fields.map(field => {
              const name = field.getName();
              let type = "unknown";
              let options = [];
              let currentValue = "";
              try {
                if (field.constructor.name.includes("TextField")) {
                  type = "text";
                  currentValue = field.getText() || "";
                } else if (field.constructor.name.includes("CheckBox")) {
                  type = "checkbox";
                  currentValue = field.isChecked();
                } else if (field.constructor.name.includes("RadioGroup")) {
                  type = "radio";
                  currentValue = field.getSelected() || "";
                } else if (field.constructor.name.includes("Dropdown")) {
                  type = "dropdown";
                  options = field.getOptions();
                  currentValue = field.getSelected() || "";
                }
              } catch {}
              return { name, type, options, currentValue };
            });
          }
        } catch {
          // Not a form PDF or encrypted — that's fine
        }

        let text = `Displaying: ${fileName} (${(stats.size / 1024).toFixed(0)} KB)`;
        if (hasFormFields) {
          text += `\n${fieldCount} form fields detected.`;
        }

        const payload = await buildActiveDocumentPayload(resolvedPath, initialPage, {
          hasFormFields,
          fieldCount,
          fields: fieldInfo,
        });
        return {
          content: [{ type: "text", text }],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            viewUUID: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ...payload,
          },
        };
      }

      case "get_active_document": {
        if (!activeDocumentState.activePath) {
          return {
            content: [{
              type: "text",
              text: "No active document yet. Open a PDF with display_pdf or read_pdf_fields, or fetch one with fetch_pdf_from_url first."
            }],
            structuredContent: {
              active_path: null,
              backup_path: null,
              last_mutation_tool: null,
              last_mutation_at: null,
            },
          };
        }

        const payload = await buildActiveDocumentPayload(activeDocumentState.activePath);
        return {
          content: [{
            type: "text",
            text:
              `Active document: ${payload.active_path}\n` +
              (payload.backup_path ? `Backup: ${payload.backup_path}\n` : "Backup: none\n") +
              (payload.last_mutation_tool ? `Last mutation: ${payload.last_mutation_tool} at ${payload.last_mutation_at}` : "Last mutation: none")
          }],
          structuredContent: payload,
        };
      }

      case "set_active_document": {
        const { pdf_path, backup_path = null, last_mutation_tool = null, last_mutation_at = null } = args;
        if (!pdf_path || typeof pdf_path !== "string") {
          throw new Error("'pdf_path' is required and must be a string.");
        }
        syncActiveDocumentState({
          pdfPath: pdf_path,
          backupPath: backup_path,
          lastMutationTool: last_mutation_tool,
          lastMutationAt: last_mutation_at,
        });
        const payload = await buildActiveDocumentPayload(pdf_path);
        return {
          content: [{
            type: "text",
            text: `Active document synced: ${payload.active_path}`
          }],
          structuredContent: payload,
        };
      }

      case "read_pdf_bytes": {
        const { pdf_path, offset, byteCount } = args;
        const resolvedPath = resolvePath(pdf_path);
        const MAX_CHUNK = 524288; // 512KB max per chunk
        const clampedByteCount = Math.min(byteCount || MAX_CHUNK, MAX_CHUNK);

        const stats = await fs.stat(resolvedPath);
        const totalBytes = stats.size;
        const clampedOffset = Math.min(offset || 0, totalBytes);
        const end = Math.min(clampedOffset + clampedByteCount, totalBytes);

        let fileHandle;
        try {
          fileHandle = await fs.open(resolvedPath, "r");
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error opening file: ${err.message}` }],
            isError: true,
          };
        }
        const buffer = Buffer.alloc(end - clampedOffset);
        await fileHandle.read(buffer, 0, buffer.length, clampedOffset);
        await fileHandle.close();

        const bytes = buffer.toString("base64");
        const hasMore = end < totalBytes;

        return {
          content: [{
            type: "text",
            text: `${buffer.length} bytes at ${clampedOffset}/${totalBytes}`
          }],
          structuredContent: {
            pdfPath: resolvedPath,
            bytes,
            offset: clampedOffset,
            byteCount: buffer.length,
            totalBytes,
            hasMore,
          },
        };
      }

      case "merge_pdfs": {
        const { input_paths, output_path, password } = args;
        if (!input_paths || input_paths.length === 0) {
          throw new Error("input_paths must be a non-empty array of PDF file paths.");
        }
        const resolvedOutputPath = resolvePath(output_path);

        // Check no input path equals output path
        const resolvedInputPaths = input_paths.map(p => resolvePath(p));
        if (resolvedInputPaths.includes(resolvedOutputPath)) {
          throw new Error("output_path must be different from all input paths to prevent file corruption.");
        }

        // Memory guard: check total file size
        let totalSize = 0;
        for (const rp of resolvedInputPaths) {
          const s = await fs.stat(rp);
          totalSize += s.size;
        }
        const MAX_MERGE_SIZE = 500 * 1024 * 1024;
        if (totalSize > MAX_MERGE_SIZE) {
          throw new Error(`Total input size (${(totalSize / 1024 / 1024).toFixed(1)}MB) exceeds 500MB limit.`);
        }

        const mergedDoc = await PDFDocument.create();
        let totalPageCount = 0;
        for (let fi = 0; fi < resolvedInputPaths.length; fi++) {
          const rp = resolvedInputPaths[fi];
          let srcDoc;
          try {
            ({ pdfDoc: srcDoc } = await loadPdf(rp, password));
          } catch (err) {
            throw new Error(`File ${fi + 1} (${path.basename(rp)}): ${err.message}`);
          }
          const pageIndices = srcDoc.getPageIndices();
          const copiedPages = await mergedDoc.copyPages(srcDoc, pageIndices);
          for (const page of copiedPages) {
            mergedDoc.addPage(page);
          }
          totalPageCount += pageIndices.length;
        }

        const mergedBytes = await mergedDoc.save();
        await fs.writeFile(resolvedOutputPath, mergedBytes);
        const outputStats = await fs.stat(resolvedOutputPath);

        return {
          content: [{
            type: "text",
            text: `Merged ${input_paths.length} PDFs into: ${output_path}\nTotal pages: ${totalPageCount}\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB`
          }],
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            pdfPath: resolvedOutputPath,
            totalBytes: outputStats.size,
            initialPage: 1,
            hasFormFields: false,
            fieldCount: 0,
            fields: [],
          },
        };
      }

      case "split_pdf": {
        const { input_path, page_ranges, output_directory, password } = args;
        const { pdfDoc, resolvedPath: resolvedInputPath } = await loadPdf(input_path, password);
        const resolvedOutputDir = resolvePath(output_directory);
        await fs.mkdir(resolvedOutputDir, { recursive: true });

        const totalPages = pdfDoc.getPageCount();
        const ranges = parsePageRanges(page_ranges, totalPages);
        const baseName = path.basename(resolvedInputPath, ".pdf");

        const results = [];
        for (let ri = 0; ri < ranges.length; ri++) {
          const [start, end] = ranges[ri];
          const newDoc = await PDFDocument.create();
          const pageIndices = [];
          for (let i = start - 1; i <= end - 1; i++) {
            pageIndices.push(i);
          }
          const copiedPages = await newDoc.copyPages(pdfDoc, pageIndices);
          for (const page of copiedPages) {
            newDoc.addPage(page);
          }

          const suffix = ranges.length > 1 ? `_${ri + 1}` : "";
          const filename = `${baseName}_pages_${start}-${end}${suffix}.pdf`;
          const outputPath = path.join(resolvedOutputDir, filename);
          const savedBytes = await newDoc.save();
          await fs.writeFile(outputPath, savedBytes);
          results.push(`${filename} (${end - start + 1} pages)`);
        }

        return {
          content: [{
            type: "text",
            text: `Split ${path.basename(resolvedInputPath)} into ${results.length} files:\n${results.join("\n")}\nSaved to: ${output_directory}`
          }],
        };
      }

      case "rotate_pdf_pages": {
        const { input_path, output_path, pages, degrees, password } = args;
        if (![90, 180, 270].includes(degrees)) {
          throw new Error(`Invalid rotation angle: ${degrees}. Must be 90, 180, or 270.`);
        }
        const resolvedInputPath = resolvePath(input_path);
        const resolvedOutputPath = resolvePath(output_path);
        if (resolvedInputPath === resolvedOutputPath) {
          throw new Error("output_path must be different from input_path to prevent file corruption.");
        }

        const { pdfDoc } = await loadPdf(input_path, password);
        const allPages = pdfDoc.getPages();
        const totalPages = allPages.length;

        // Determine which pages to rotate
        const targetPages = (!pages || pages.length === 0)
          ? allPages
          : pages.map(p => {
              if (p < 1 || p > totalPages) throw new Error(`Page ${p} is out of range (1-${totalPages}).`);
              return allPages[p - 1];
            });

        for (const page of targetPages) {
          const currentRotation = page.getRotation().angle;
          page.setRotation(pdfDegrees((currentRotation + degrees) % 360));
        }

        const rotatedBytes = await pdfDoc.save();
        await fs.writeFile(resolvedOutputPath, rotatedBytes);
        const outputStats = await fs.stat(resolvedOutputPath);

        return {
          content: [{
            type: "text",
            text: `Rotated ${targetPages.length} page(s) by ${degrees}° and saved to: ${output_path}\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB`
          }],
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            pdfPath: resolvedOutputPath,
            totalBytes: outputStats.size,
            initialPage: 1,
            hasFormFields: false,
            fieldCount: 0,
            fields: [],
          },
        };
      }

      case "reorder_pdf_pages": {
        const { input_path, output_path, page_order, password } = args;
        if (!page_order || page_order.length === 0) {
          throw new Error("page_order must be a non-empty array of page numbers.");
        }
        const resolvedInputPath = resolvePath(input_path);
        const resolvedOutputPath = resolvePath(output_path);
        if (resolvedInputPath === resolvedOutputPath) {
          throw new Error("output_path must be different from input_path to prevent file corruption.");
        }

        const { pdfDoc } = await loadPdf(input_path, password);
        const totalPages = pdfDoc.getPageCount();

        // Validate strict permutation
        const sorted = [...page_order].sort((a, b) => a - b);
        const expected = Array.from({ length: totalPages }, (_, i) => i + 1);
        if (sorted.length !== expected.length || !sorted.every((v, i) => v === expected[i])) {
          throw new Error(`page_order must be a permutation of all pages (1-${totalPages}). Got: [${page_order.join(", ")}]`);
        }

        const newDoc = await PDFDocument.create();
        const pageIndices = page_order.map(p => p - 1);
        const copiedPages = await newDoc.copyPages(pdfDoc, pageIndices);
        for (const page of copiedPages) {
          newDoc.addPage(page);
        }

        const reorderedBytes = await newDoc.save();
        await fs.writeFile(resolvedOutputPath, reorderedBytes);
        const outputStats = await fs.stat(resolvedOutputPath);

        return {
          content: [{
            type: "text",
            text: `Reordered ${totalPages} pages and saved to: ${output_path}\nNew order: [${page_order.join(", ")}]\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB`
          }],
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            pdfPath: resolvedOutputPath,
            totalBytes: outputStats.size,
            initialPage: 1,
            hasFormFields: false,
            fieldCount: 0,
            fields: [],
          },
        };
      }

      case "get_pdf_info": {
        const { pdf_path, password } = args;
        const resolvedPath = resolvePath(pdf_path);
        const stats = await fs.stat(resolvedPath);
        const fileName = path.basename(resolvedPath);
        const fileSizeKB = (stats.size / 1024).toFixed(2);

        let pageCount = 0;
        let hasFormFields = false;
        let fieldCount = 0;
        let isEncrypted = false;
        let pageDimensions = null;

        try {
          const pdfBytes = await fs.readFile(resolvedPath);
          const loadOpts = password ? { password } : { ignoreEncryption: true };
          const pdfDoc = await PDFDocument.load(pdfBytes, loadOpts);
          const pages = pdfDoc.getPages();
          pageCount = pages.length;

          if (pages.length > 0) {
            const firstPage = pages[0];
            const { width, height } = firstPage.getSize();
            pageDimensions = { width: Math.round(width), height: Math.round(height) };
          }

          try {
            const form = pdfDoc.getForm();
            const fields = form.getFields();
            fieldCount = fields.length;
            hasFormFields = fieldCount > 0;
          } catch {
            // No form or encrypted form — fine
          }
        } catch (error) {
          if (error.message?.includes("password") || error.message?.includes("encrypt")) {
            isEncrypted = true;
          } else {
            throw error;
          }
        }

        let info = `File: ${fileName}\n`;
        info += `Size: ${fileSizeKB} KB\n`;
        info += `Pages: ${pageCount}\n`;
        if (pageDimensions) {
          info += `Page size: ${pageDimensions.width} x ${pageDimensions.height} pts\n`;
        }
        info += `Form fields: ${hasFormFields ? fieldCount : "none"}\n`;
        info += `Encrypted: ${isEncrypted ? "yes" : "no"}`;

        return {
          content: [{ type: "text", text: info }],
        };
      }

      case "apply_page_plan": {
        const { input_path, output_path, plan, password, force_xfa = false } = args;
        const { page_order, rotations = {} } = plan;

        if (!page_order || page_order.length === 0) {
          throw new Error("plan.page_order must be a non-empty array of page numbers.");
        }

        const resolvedInputPath = resolvePath(input_path);
        const resolvedOutputPath = resolvePath(output_path);
        if (resolvedInputPath === resolvedOutputPath) {
          throw new Error("output_path must be different from input_path to prevent file corruption.");
        }

        const rawPdfBytes = await fs.readFile(resolvedInputPath);
        assertXfaMutationAllowed(rawPdfBytes, { forceXfa: force_xfa });
        const { pdfDoc } = await loadPdf(input_path, password);
        const totalPages = pdfDoc.getPageCount();

        // Validate page numbers
        const seen = new Set();
        for (const p of page_order) {
          if (!Number.isInteger(p) || p < 1 || p > totalPages) {
            throw new Error(`Page ${p} is invalid (must be integer 1-${totalPages}).`);
          }
          if (seen.has(p)) {
            throw new Error(`Duplicate page number in page_order: ${p}`);
          }
          seen.add(p);
        }

        // Validate rotation degrees
        const validDegrees = [0, 90, 180, 270];
        for (const [pageStr, deg] of Object.entries(rotations)) {
          if (!validDegrees.includes(deg)) {
            throw new Error(`Invalid rotation ${deg}° for page ${pageStr}. Must be 0, 90, 180, or 270.`);
          }
        }

        // Build the new PDF
        const newDoc = await PDFDocument.create();
        const pageIndices = page_order.map(p => p - 1);
        const copiedPages = await newDoc.copyPages(pdfDoc, pageIndices);

        for (let i = 0; i < copiedPages.length; i++) {
          const page = copiedPages[i];
          const originalPageNum = page_order[i];
          const rotationDeg = rotations[String(originalPageNum)];

          if (rotationDeg) {
            const currentRotation = page.getRotation().angle;
            page.setRotation(pdfDegrees((currentRotation + rotationDeg) % 360));
          }

          newDoc.addPage(page);
        }

        const newBytes = await newDoc.save();
        let outputStats;
        try {
          await fs.writeFile(resolvedOutputPath, newBytes);
          outputStats = await fs.stat(resolvedOutputPath);
        } catch (writeErr) {
          // Clean up partial file if it exists
          try { await fs.unlink(resolvedOutputPath); } catch {}
          throw new Error(`Failed to save PDF: ${writeErr.message}. Check that the output directory exists and is writable.`);
        }

        const deletedCount = totalPages - page_order.length;
        const rotatedCount = Object.keys(rotations).filter(k => seen.has(Number(k))).length;
        let summary = `Saved ${page_order.length}-page PDF to: ${output_path}\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB`;
        if (deletedCount > 0) summary += `\n${deletedCount} page(s) removed`;
        if (rotatedCount > 0) summary += `\n${rotatedCount} page(s) rotated`;

        return {
          content: [{ type: "text", text: summary }],
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            pdfPath: resolvedOutputPath,
            totalBytes: outputStats.size,
            initialPage: 1,
            hasFormFields: false,
            fieldCount: 0,
            fields: [],
          },
        };
      }

      case "get_page_analysis": {
        const { pdf_path, password } = args;
        // Use pdf-lib for fast dimension extraction, keep pdfBytes for pdfjs-dist reuse
        const { pdfDoc, pdfBytes } = await loadPdf(pdf_path, password);
        const pdfLibPages = pdfDoc.getPages();
        const totalPages = pdfLibPages.length;

        // Pre-extract dimensions from pdf-lib (instant)
        const pageMeta = pdfLibPages.map((page, i) => {
          const { width, height } = page.getSize();
          const metrics = getPageDisplayMetrics({ width, height, rotation: page.getRotation().angle });
          return {
            page: i + 1,
            width: metrics.width,
            height: metrics.height,
            display_width: metrics.display_width,
            display_height: metrics.display_height,
            rotation: metrics.rotation,
            orientation: metrics.orientation,
            text_length: 0,
            text_snippet: "",
            has_images: false,
          };
        });

        // Use pdfjs-dist for text extraction (slower — only first 100 chars per page)
        try {
          await loadPdfjs();
          const pdfjsDoc = await pdfjsLib.getDocument({
            data: new Uint8Array(pdfBytes),
            password: password || undefined,
            useSystemFonts: true,
            disableFontFace: true,
            verbosity: 0
          }).promise;

          const maxPages = Math.min(totalPages, 200);
          for (let i = 0; i < maxPages; i++) {
            try {
              const page = await pdfjsDoc.getPage(i + 1);
              const content = await page.getTextContent();
              const fullText = content.items.map(item => item.str).join("");
              pageMeta[i].text_length = fullText.length;
              pageMeta[i].text_snippet = fullText.slice(0, 100);

              // Check for images via operatorList
              const ops = await page.getOperatorList();
              const imageOps = [
                pdfjsLib.OPS?.paintImageXObject,
                pdfjsLib.OPS?.paintJpegXObject,
                pdfjsLib.OPS?.paintImageMaskXObject,
              ].filter(Boolean);
              pageMeta[i].has_images = ops.fnArray.some(fn => imageOps.includes(fn));
            } catch {
              // Per-page error — leave defaults for this page
            }
          }

          await pdfjsDoc.destroy();
        } catch (textErr) {
          // pdfjs-dist failed entirely — return dimension-only data
          console.error("[get_page_analysis] Text extraction failed:", textErr.message);
        }

        // Compute majority orientation for detecting sideways pages
        const orientationCounts = { portrait: 0, landscape: 0 };
        for (const p of pageMeta) orientationCounts[p.orientation]++;
        const majorityOrientation = orientationCounts.portrait >= orientationCounts.landscape ? "portrait" : "landscape";

        // Only flag blank pages that were actually analyzed (not beyond the 200-page cap)
        const analyzedCount = Math.min(totalPages, 200);
        let summary = `Analyzed ${totalPages} pages`;
        if (totalPages > 200) summary += ` (text extracted from first 200 only)`;
        summary += ".";
        const blankPages = pageMeta.filter(p => p.page <= analyzedCount && p.text_length === 0 && !p.has_images);
        const sidewaysPages = pageMeta.filter(p => p.orientation !== majorityOrientation);
        if (blankPages.length > 0) summary += ` ${blankPages.length} likely blank page(s): ${blankPages.map(p => p.page).join(", ")}.`;
        if (sidewaysPages.length > 0) summary += ` ${sidewaysPages.length} page(s) in ${sidewaysPages[0].orientation} orientation (majority is ${majorityOrientation}): ${sidewaysPages.map(p => p.page).join(", ")}.`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            total_pages: totalPages,
            majority_orientation: majorityOrientation,
            pages: pageMeta,
          },
        };
      }

      case "create_signature": {
        const { name, display_name, image_path, image_data_url, overwrite = false } = args;
        const cleanName = validateSignatureName(name);
        const cleanDisplayName = typeof display_name === "string" ? display_name.trim() : "";
        if (cleanDisplayName.length > 120) {
          throw new Error("display_name is too long (>120 chars).");
        }
        const imageSourcesProvided = [image_path, image_data_url].filter(Boolean).length;
        const typedOnly = cleanDisplayName.length > 0 && imageSourcesProvided === 0;
        if (!typedOnly && imageSourcesProvided === 0) {
          throw new Error("Provide either display_name for a typed signature, or exactly one image source: image_path or image_data_url.");
        }
        if (imageSourcesProvided > 1) {
          throw new Error("Provide only one image source: image_path or image_data_url.");
        }

        const slug = cleanName.replace(/\s+/g, "-");
        const sigPath = path.join(SIGNATURES_DIR, `${slug}.json`);

        if (!overwrite) {
          let alreadyExists = false;
          try {
            await fs.access(sigPath);
            alreadyExists = true;
          } catch (err) {
            if (err.code !== "ENOENT") throw err;
          }
          if (alreadyExists) {
            throw new Error(`Signature "${cleanName}" already exists. Use overwrite=true to replace it.`);
          }
        }

        let signatureRecord;
        if (typedOnly) {
          signatureRecord = {
            name: cleanName,
            style: "typed",
            display_name: cleanDisplayName,
            created_at: new Date().toISOString(),
          };
        } else if (image_path) {
          const resolvedImgPath = resolvePath(image_path);
          const imgBytes = await fs.readFile(resolvedImgPath);
          const ext = path.extname(resolvedImgPath).toLowerCase();
          let mime;
          if (ext === ".png" || imgBytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") mime = "image/png";
          else if (ext === ".jpg" || ext === ".jpeg" || imgBytes.subarray(0, 3).toString("hex") === "ffd8ff") mime = "image/jpeg";
          else throw new Error(`Unsupported image format: "${ext}". Use PNG or JPEG.`);
          signatureRecord = {
            name: cleanName,
            style: "image",
            image_mime: mime,
            image_data_b64: imgBytes.toString("base64"),
            ...(cleanDisplayName ? { display_name: cleanDisplayName } : {}),
            source_path: resolvedImgPath,
            created_at: new Date().toISOString(),
          };
        } else {
          const { mime, bytes } = parseImageDataUrl(image_data_url);
          signatureRecord = {
            name: cleanName,
            style: "image",
            image_mime: mime,
            image_data_b64: bytes.toString("base64"),
            ...(cleanDisplayName ? { display_name: cleanDisplayName } : {}),
            created_at: new Date().toISOString(),
          };
        }

        await fs.writeFile(sigPath, JSON.stringify(signatureRecord, null, 2));
        const bytesOnDisk = (await fs.stat(sigPath)).size;
        return {
          content: [{
            type: "text",
            text:
              `Signature saved: "${cleanName}" (${signatureRecord.style})\n` +
              `Location: ${sigPath}\n` +
              `Use apply_signature with signature_name="${cleanName}" to stamp it onto a PDF.`
          }],
          structuredContent: {
            name: cleanName,
            style: signatureRecord.style,
            path: sigPath,
            bytes: bytesOnDisk,
          },
        };
      }

      case "list_signatures": {
        let files;
        try {
          files = await fs.readdir(SIGNATURES_DIR);
        } catch (err) {
          if (err.code === "ENOENT") {
            return { content: [{ type: "text", text: "No signatures yet. Use create_signature to save one." }] };
          }
          throw err;
        }
        const entries = [];
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          try {
            const raw = await fs.readFile(path.join(SIGNATURES_DIR, file), "utf8");
            const rec = JSON.parse(raw);
            if (typeof rec.name === "string" && rec.name.startsWith("__pdf-tools-quick-")) {
              continue;
            }
            entries.push({
              name: rec.name,
              style: rec.style,
              display_name: rec.display_name || null,
              created_at: rec.created_at,
            });
          } catch {
            // Skip malformed files
          }
        }
        entries.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No signatures yet. Use create_signature to save one." }] };
        }
        const lines = entries.map(e =>
          `  • ${e.name} (${e.style}${e.display_name ? ` — "${e.display_name}"` : ""}) — ${e.created_at}`
        );
        return {
          content: [{
            type: "text",
            text: `Saved signatures (${entries.length}):\n${lines.join("\n")}`
          }],
          structuredContent: { signatures: entries },
        };
      }

      case "load_signature": {
        const { signature_name } = args;
        const cleanSigName = validateSignatureName(signature_name);
        const sigSlug = cleanSigName.replace(/\s+/g, "-");
        const sigPath = path.join(SIGNATURES_DIR, `${sigSlug}.json`);
        let rec;
        try {
          rec = JSON.parse(await fs.readFile(sigPath, "utf8"));
        } catch (err) {
          if (err.code === "ENOENT") {
            throw new Error(`Signature "${cleanSigName}" not found. Use create_signature to save it first, or list_signatures to see available ones.`);
          }
          throw err;
        }
        const previewDataUrl = rec.style === "image" && rec.image_data_b64 && rec.image_mime
          ? `data:${rec.image_mime};base64,${rec.image_data_b64}`
          : null;
        return {
          content: [{
            type: "text",
            text: `Loaded signature "${cleanSigName}" (${rec.style}).`
          }],
          structuredContent: {
            name: rec.name,
            style: rec.style,
            display_name: rec.display_name || null,
            preview_data_url: previewDataUrl,
            created_at: rec.created_at,
          },
        };
      }

      case "add_signature_field": {
        const { pdf_path, output_path, page, x, y, width, height, label, allow_resign = false, password, force_xfa = false } = args;
        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);
        const { pdfDoc, pdfBytes } = await loadPdf(pdf_path, password);
        const existingSigs = detectExistingSignatures(pdfDoc);
        if (existingSigs.present && !allow_resign) {
          throw new Error(
            `This PDF already contains ${existingSigs.fieldNames.length} cryptographic signature field(s) ` +
            `(${existingSigs.fieldNames.slice(0, 3).join(", ")}${existingSigs.fieldNames.length > 3 ? "..." : ""}). ` +
            `Saving would invalidate those signatures. Pass allow_resign=true if you intend to modify a signed PDF.`
          );
        }
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });
        await drawSignatureFieldOnPage(pdfDoc, { page, x, y, width, height, label });
        const { payload, backupPath } = await persistPdfMutation({
          pdfDoc,
          inputPath: resolvedInput,
          outputPath: resolvedOutput,
          toolName: "add_signature_field",
          initialPage: page,
        });
        return {
          content: [{
            type: "text",
            text:
              `Added signature field to page ${page} at (${x}, ${y}) — ${width}x${height} pts\n` +
              `Output: ${resolvedOutput}\n` +
              (backupPath ? `Original backed up to: ${backupPath}\n` : "") +
              `The field is a visible placeholder; use apply_signature to stamp a signature there.`
          }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            page, x, y, width, height,
            label: label || "Sign here",
          },
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          }
        };
      }

      case "apply_signature": {
        const {
          pdf_path, output_path, signature_name,
          page, x, y, width, height,
          user_intent_statement, user_confirmed_at,
          draw_audit_line = false,
          signing_mode = "signature",
          allow_resign = false,
          force_xfa = false,
          password,
        } = args;

        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);

        // 1. Validate intent — rejects missing/stale/invented intent signals
        const { statement, confirmedAt } = validateSigningIntent({ user_intent_statement, user_confirmed_at });

        // 2. Load the signature record
        const cleanSigName = validateSignatureName(signature_name);
        const sigSlug = cleanSigName.replace(/\s+/g, "-");
        const sigPath = path.join(SIGNATURES_DIR, `${sigSlug}.json`);
        let signatureRecord;
        try {
          signatureRecord = JSON.parse(await fs.readFile(sigPath, "utf8"));
        } catch (err) {
          if (err.code === "ENOENT") {
            throw new Error(`Signature "${cleanSigName}" not found. Use create_signature to save it first, or list_signatures to see available ones.`);
          }
          throw err;
        }

        // 3. Load the PDF
        const { pdfDoc, pdfBytes } = await loadPdf(pdf_path, password);

        // 3a. Refuse to invalidate existing cryptographic signatures (pdf-lib
        // round-trip breaks them). Users opt in with allow_resign=true.
        const existingSigs = detectExistingSignatures(pdfDoc);
        if (existingSigs.present && !allow_resign) {
          throw new Error(
            `This PDF already contains ${existingSigs.fieldNames.length} cryptographic signature field(s) ` +
            `(${existingSigs.fieldNames.slice(0, 3).join(", ")}${existingSigs.fieldNames.length > 3 ? "..." : ""}). ` +
            `Saving would invalidate those signatures. Pass allow_resign=true if you intend to re-sign.`
          );
        }

        // 3b. Refuse to silently strip XFA data.
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });

        // 4. Stamp
        const displayName = signatureRecord.display_name || signatureRecord.name;
        const auditVerb = signing_mode === "initials" ? "Initialed" : "Signed";
        const auditAction = signing_mode === "initials" ? "initialed" : "signed";
        const auditText = draw_audit_line
          ? `${auditVerb} by ${displayName} at ${confirmedAt.toISOString()}`
          : "";
        await stampSignatureOnPage(pdfDoc, signatureRecord, {
          page, x, y, width, height,
          drawAuditLine: draw_audit_line,
          auditText,
        });

        // 5. Write audit trail into PDF metadata (Keywords)
        const auditLine = formatSigningAuditLine({
          display_name: displayName,
          statement,
          confirmedAt,
          action: auditAction,
        });
        const existingKeywords = pdfDoc.getKeywords() || "";
        const mergedKeywords = existingKeywords
          ? `${existingKeywords}\n${auditLine}`
          : auditLine;
        pdfDoc.setKeywords([mergedKeywords]);
        pdfDoc.setModificationDate(new Date());

        // 6. Save
        const { payload, backupPath } = await persistPdfMutation({
          pdfDoc,
          inputPath: resolvedInput,
          outputPath: resolvedOutput,
          toolName: "apply_signature",
          initialPage: page,
        });

        return {
          content: [{
            type: "text",
            text:
              `${auditVerb}: "${displayName}" stamped on page ${page} at (${x}, ${y})\n` +
              `Output: ${resolvedOutput}\n` +
              (backupPath ? `Original backed up to: ${backupPath}\n` : "") +
              `Audit trail: ${auditLine}\n\n` +
              `NOTE: This is a basic visible stamp, not a cryptographic signature. ` +
              `For legally-binding signing, use a compliance-grade service.`
          }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            signature_name: cleanSigName,
            page, x, y, width, height,
            signer: displayName,
            confirmed_at: confirmedAt.toISOString(),
            intent_statement: statement,
            signing_mode,
            tier: "basic-local-stamp",
          },
        };
      }

      case "prepare_signing_packet": {
        const { pdf_path, output_path, field_values, signature_locations = [], allow_resign = false, password, force_xfa = false } = args;
        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);

        const { pdfDoc, pdfBytes } = await loadPdf(pdf_path, password);
        const existingSigs = detectExistingSignatures(pdfDoc);
        if (existingSigs.present && !allow_resign) {
          throw new Error(
            `This PDF already contains ${existingSigs.fieldNames.length} cryptographic signature field(s) ` +
            `(${existingSigs.fieldNames.slice(0, 3).join(", ")}${existingSigs.fieldNames.length > 3 ? "..." : ""}). ` +
            `Saving would invalidate those signatures. Pass allow_resign=true if you intend to modify a signed PDF.`
          );
        }
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });

        // 1. Fill form fields if provided
        let filledCount = 0;
        const fillErrors = [];
        if (field_values && typeof field_values === "object") {
          const form = pdfDoc.getForm();
          for (const [fieldName, value] of Object.entries(field_values)) {
            try {
              const field = form.getField(fieldName);
              const typeName = field.constructor.name;
              if (typeName.includes("TextField")) {
                field.setText(String(value ?? ""));
              } else if (typeName.includes("CheckBox")) {
                if (value === true || value === "true" || value === 1 || value === "1" || value === "yes") field.check();
                else field.uncheck();
              } else if (typeName.includes("RadioGroup")) {
                field.select(String(value));
              } else if (typeName.includes("Dropdown") || typeName.includes("OptionList")) {
                field.select(String(value));
              }
              filledCount++;
            } catch (err) {
              fillErrors.push({ field: fieldName, error: err.message });
            }
          }
        }

        // 2. Add signature fields
        const manifest = [];
        for (const loc of signature_locations) {
          await drawSignatureFieldOnPage(pdfDoc, {
            page: loc.page,
            x: loc.x,
            y: loc.y,
            width: loc.width,
            height: loc.height,
            label: loc.label || "Sign here",
          });
          manifest.push({
            label: loc.label || "Sign here",
            page: loc.page,
            x: loc.x, y: loc.y,
            width: loc.width, height: loc.height,
          });
        }

        const { payload, backupPath } = await persistPdfMutation({
          pdfDoc,
          inputPath: resolvedInput,
          outputPath: resolvedOutput,
          toolName: "prepare_signing_packet",
          initialPage: manifest[0]?.page || 1,
          extraPayload: {
            pending_signatures: manifest,
            filled_count: filledCount,
            fill_errors: fillErrors,
          },
        });

        const summary =
          `Prepared signing packet: ${path.basename(resolvedOutput)}\n` +
          `  Filled: ${filledCount} field${filledCount === 1 ? "" : "s"}\n` +
          (fillErrors.length ? `  Errors: ${fillErrors.length} (${fillErrors.slice(0,3).map(e => e.field).join(", ")})\n` : "") +
          (backupPath ? `  Backup: ${backupPath}\n` : "") +
          `  Signature fields added: ${manifest.length}\n` +
          `  Output: ${resolvedOutput}`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            filled_count: filledCount,
            fill_errors: fillErrors,
            pending_signatures: manifest,
          },
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          }
        };
      }

      case "apply_text": {
        const {
          pdf_path, output_path,
          page, x, y, width, height,
          text, font_style = "normal",
          allow_resign = false,
          force_xfa = false,
          password,
        } = args;

        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);

        const { pdfDoc, pdfBytes } = await loadPdf(pdf_path, password);

        // Same safety rails as apply_signature: refuse to invalidate existing
        // crypto sigs or strip XFA data silently.
        const existingSigs = detectExistingSignatures(pdfDoc);
        if (existingSigs.present && !allow_resign) {
          throw new Error(
            `This PDF already contains ${existingSigs.fieldNames.length} cryptographic signature field(s). ` +
            `Saving would invalidate them. Pass allow_resign=true if you intend to modify a signed PDF.`
          );
        }
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });

        await stampTextOnPage(pdfDoc, { page, x, y, width, height, text, fontStyle: font_style });

        // Short audit line so filling dates/initials shows up in Keywords.
        const auditLine = `stamped text via pdf-toolkit; text="${String(text).replace(/\s+/g, " ").slice(0, 80)}"; at=${new Date().toISOString()}; page=${page}`;
        const existingKeywords = pdfDoc.getKeywords() || "";
        pdfDoc.setKeywords([existingKeywords ? `${existingKeywords}\n${auditLine}` : auditLine]);
        pdfDoc.setModificationDate(new Date());

        const { payload, backupPath } = await persistPdfMutation({
          pdfDoc,
          inputPath: resolvedInput,
          outputPath: resolvedOutput,
          toolName: "apply_text",
          initialPage: page,
        });

        return {
          content: [{
            type: "text",
            text:
              `Stamped text "${text}" on page ${page} at (${x}, ${y}).\n` +
              (backupPath ? `Original backed up to: ${backupPath}\n` : "") +
              `Output: ${resolvedOutput}`
          }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            page, x, y, width, height,
            text,
          },
        };
      }

      case "detect_signature_zones": {
        const { pdf_path, password } = args;
        const { pdfDoc, pdfBytes } = await loadPdf(pdf_path, password);
        await loadPdfjs();
        const zones = await detectSignatureZones({
          pdfDoc,
          pdfBytes,
          pdfjsLib,
          password,
        });

        const byType = zones.reduce((acc, z) => {
          acc[z.type] = (acc[z.type] || 0) + 1;
          return acc;
        }, {});
        const summary = zones.length === 0
          ? `No signature zones detected in ${path.basename(pdf_path)}. The form may be flat/scanned or use an unusual layout — ask the user to pick a signature location in the viewer.`
          : `Found ${zones.length} zone(s) in ${path.basename(pdf_path)}: ` +
            Object.entries(byType).map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`).join(", ") +
            `.\n\nUse apply_signature at one of these zones — do not guess coordinates.`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: { zones },
        };
      }

      case "fetch_pdf_from_url": {
        const {
          url,
          filename,
          destination_dir,
          overwrite = false,
          max_size_mb = 100,
          headers,
          allow_private_hosts = false,
        } = args;

        if (!url || typeof url !== "string") {
          throw new Error("'url' is required and must be a string.");
        }

        // Destination directory priority:
        //   1. caller-supplied destination_dir (one-off override)
        //   2. user_config.download_directory from the extension settings UI
        //   3. helper's internal default (~/Downloads)
        const resolvedDestDir = resolvePath(destination_dir || DEFAULT_DOWNLOAD_DIR);

        const result = await downloadPdfFromUrl(url, {
          filename,
          destinationDir: resolvedDestDir,
          overwrite,
          maxSizeMb: max_size_mb,
          headers: headers || {},
          allowPrivateHosts: allow_private_hosts,
        });
        noteDocumentOpened(result.path);

        const sizeKb = (result.bytes / 1024).toFixed(0);
        const payload = await buildActiveDocumentPayload(result.path);
        return {
          content: [{
            type: "text",
            text:
              `Downloaded ${sizeKb} KB to:\n${result.path}\n\n` +
              `Source: ${result.sourceUrl}\n` +
              `You can now pass this path to read_pdf_fields, fill_pdf, validate_pdf, or any other PDF tool.`
          }],
          structuredContent: {
            ...payload,
            pdf_path: result.path,
            bytes: result.bytes,
            content_type: result.contentType,
            source_url: result.sourceUrl,
          },
        };
      }

      case "reveal_in_finder": {
        const rawPath = args?.path;
        if (!rawPath || typeof rawPath !== "string") {
          throw new Error("'path' is required and must be a string.");
        }
        const resolved = resolvePath(rawPath);
        // Existence check first — better error than spawn failure.
        try { await fs.access(resolved); } catch {
          throw new Error(`File not found: ${resolved}`);
        }

        const plat = osPlatform();
        let cmd, cmdArgs;
        if (plat === "darwin") {
          cmd = "open";
          cmdArgs = ["-R", resolved];
        } else if (plat === "win32") {
          cmd = "explorer.exe";
          // /select, must be a single argv entry with the path joined.
          cmdArgs = [`/select,${resolved}`];
        } else {
          // Linux / other POSIX — best-effort: open the enclosing directory.
          cmd = "xdg-open";
          cmdArgs = [path.dirname(resolved)];
        }

        await new Promise((resolve, reject) => {
          const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
          child.on("error", reject);
          // Detach so the child outlives this handler.
          child.unref();
          // We don't wait for exit on detached GUI launchers (they fork-and-return).
          resolve();
        });

        return {
          content: [{ type: "text", text: `Revealed ${resolved}` }],
          structuredContent: { path: resolved, platform: plat },
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`
        }
      ],
    };
  }
});

// Resource handlers for PDFs
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  console.error(`[Resources] ListResourcesRequest received`);
  return {
    resources: [
      {
        uri: "ui://pdf-toolkit/viewer",
        name: "PDF Form Viewer",
        mimeType: "text/html;profile=mcp-app"
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  console.error(`[Resources] ReadResourceRequest for URI: ${uri}`);

  // Handle UI resource requests (MCP Apps)
  if (uri === "ui://pdf-toolkit/viewer") {
    const htmlPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist-ui",
      "index.html"
    );
    console.error(`[Resources] Reading UI resource from: ${htmlPath}`);
    const html = await fs.readFile(htmlPath, "utf-8");
    return {
      contents: [{
        uri,
        mimeType: "text/html;profile=mcp-app",
        text: html
      }]
    };
  }

  // Check if this is a PDF resource request
  if (!uri.startsWith("pdf://")) {
    console.error(`[Resources] Unsupported URI scheme: ${uri}`);
    throw new Error(`Unsupported resource URI: ${uri}`);
  }
  
  // Extract the file path from the URI
  const pdfPath = uri.replace("pdf://", "");
  const resolvedPath = resolvePath(pdfPath);
  console.error(`[Resources] Reading PDF from path: ${pdfPath} -> ${resolvedPath}`);
  
  try {
    // Read the PDF file
    const pdfBytes = await fs.readFile(resolvedPath);
    const fileName = path.basename(resolvedPath);
    console.error(`[Resources] Successfully read PDF: ${fileName} (${pdfBytes.length} bytes)`);
    
    // Return the PDF as blob content
    const response = {
      contents: [
        {
          uri: uri,
          mimeType: "application/pdf",
          blob: pdfBytes.toString("base64")
        }
      ]
    };
    console.error(`[Resources] Returning blob content with ${response.contents[0].blob.length} base64 chars`);
    return response;
  } catch (error) {
    console.error(`[Resources] Error reading PDF: ${error.message}`);
    throw new Error(`Failed to read PDF: ${error.message}`);
  }
});

// Initialize and start the server
async function main() {
  // Ensure profiles and signatures directories exist
  await fs.mkdir(PROFILES_DIR, { recursive: true }).catch(() => {});
  await fs.mkdir(SIGNATURES_DIR, { recursive: true }).catch(() => {});
  await fs.mkdir(BACKUPS_DIR, { recursive: true }).catch(() => {});

  // Migrate profiles from old directory (~/.pdf-filler-profiles) if it exists
  try {
    const oldFiles = await fs.readdir(OLD_PROFILES_DIR);
    const jsonFiles = oldFiles.filter(f => f.endsWith(".json"));
    if (jsonFiles.length > 0) {
      let migrated = 0;
      for (const file of jsonFiles) {
        const dest = path.join(PROFILES_DIR, file);
        try {
          await fs.access(dest);
          // Already exists in new dir, skip
        } catch {
          await fs.copyFile(path.join(OLD_PROFILES_DIR, file), dest);
          migrated++;
        }
      }
      if (migrated > 0) {
        console.error(`[PDF Tools] Migrated ${migrated} profile(s) from ${OLD_PROFILES_DIR} to ${PROFILES_DIR}`);
      }
    }
  } catch {
    // Old directory doesn't exist — nothing to migrate
  }

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("PDF Tools MCP server running...");
}

// Run the main function
main().catch((error) => {
  console.error("[PDF Tools] Fatal error:", error);
  console.error("[PDF Tools] Stack trace:", error.stack);
  process.exit(1);
});
