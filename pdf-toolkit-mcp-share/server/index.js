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
import fs from "fs/promises";
import path from "path";
import { homedir } from "os";

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
    console.error("[PDF Tools] Canvas loaded successfully");
  } catch (error) {
    console.error("[PDF Tools] Failed to load canvas:", error.message);
    throw new Error("Image extraction is not available. Canvas dependency could not be loaded: " + error.message);
  }
}

// Helper function to resolve paths (handles ~, relative paths, etc.)
function resolvePath(inputPath) {
  if (!inputPath) return inputPath;
  
  // Handle ~ for home directory
  if (inputPath.startsWith('~')) {
    return path.join(homedir(), inputPath.slice(1));
  }
  
  // If it's already absolute, return as-is
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  
  // Otherwise, resolve relative to current working directory
  return path.resolve(inputPath);
}

async function withSuppressedStderr(action) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  };

  try {
    return await action();
  } finally {
    process.stderr.write = originalWrite;
  }
}

// Helper function to convert PDF page to image
async function convertPdfPageToImage(pdfBuffer, pageNumber = 1, scale = 1.0) {
  try {
    return await withSuppressedStderr(async () => {
      // Load dependencies only when needed
      await loadImageDependencies();
      // Load the PDF
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
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
    pages.push(text);
  }
  await doc.destroy();
  return { text: pages.join("\n\n"), pagesRead: pagesToRead, totalPages };
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

// Import parsePageRanges from helpers (extracted for testability)
import { parsePageRanges } from "./helpers.js";

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
    version: "0.7.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Default directories - use environment variables from manifest or fallback to defaults
const DEFAULT_PDF_DIR = process.env.DEFAULT_PDF_DIR || path.join(homedir(), "Documents");
// Keep in sync with manifest.json and share bundle defaults
const PROFILES_DIR = process.env.DEFAULT_PROFILES_DIR || path.join(homedir(), ".pdf-toolkit-files");
const OLD_PROFILES_DIR = path.join(homedir(), ".pdf-filler-profiles");

// Helper function to parse CSV
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    return headers.reduce((obj, header, index) => {
      obj[header] = values[index] || '';
      return obj;
    }, {});
  });
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
        description: "Validate if all required fields in a PDF are filled",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file to validate"
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
        description: "Read and analyze the full content of a PDF file. Claude can extract text, summarize, convert to markdown, answer questions, or analyze the document structure. Use this when you need to understand PDF contents beyond just form fields. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            max_pages: {
              type: "number",
              description: "Maximum number of pages to extract (default: all pages, but output is capped at 50000 characters)"
            }
          },
          required: ["pdf_path"]
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
        name: "get_pdf_resource_uri",
        description: "Get a resource URI for a PDF file that can be used with Claude's built-in PDF reading capabilities via the Resources API",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            }
          },
          required: ["pdf_path"]
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
        description: "Display an interactive PDF viewer with page navigation, zoom, search, and text selection. Automatically detects and displays form fields in a sidebar — no need to also call read_pdf_fields. This is the primary tool for viewing any PDF. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            page: {
              type: "number",
              description: "Initial page number to display (default: 1)"
            }
          },
          required: ["pdf_path"]
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
        
        return {
          content: [
            {
              type: "text",
              text: `PDF has ${fields.length} form fields:\n${JSON.stringify(fieldInfo, null, 2)}`
            }
          ],
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            pdfPath: resolvedPath,
            fieldCount: fields.length
          }
        };
      }

      case "fill_pdf": {
        const { pdf_path, output_path, field_data, password } = args;
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedOutputPath = resolvePath(output_path);
        const { pdfDoc, filledFields, errors } = await fillPdfFields(resolvedPdfPath, field_data, password);
        
        const filledPdfBytes = await pdfDoc.save();
        await fs.writeFile(resolvedOutputPath, filledPdfBytes);
        
        let message = `PDF filled successfully and saved to: ${output_path}\n`;
        message += `Fields filled: ${filledFields.length}`;
        if (errors.length > 0) {
          message += `\nErrors:\n${errors.join('\n')}`;
        }
        
        return {
          content: [{
            type: "text",
            text: message
          }],
        };
      }

      case "bulk_fill_from_csv": {
        const { pdf_path, csv_path, output_directory, filename_column, password } = args;
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedCsvPath = resolvePath(csv_path);
        const resolvedOutputDir = resolvePath(output_directory);
        
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
            results.push(`✓ ${filename}: ${filledFields.length} fields filled`);
          } catch (e) {
            results.push(`✗ ${filename}: ${e.message}`);
          }
        }
        
        return {
          content: [{
            type: "text",
            text: `Bulk fill complete!\n${results.join('\n')}`
          }],
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
        
        const filledPdfBytes = await pdfDoc.save();
        await fs.writeFile(resolvedOutputPath, filledPdfBytes);
        
        return {
          content: [{
            type: "text",
            text: `PDF filled with profile '${profile_name}' and saved to: ${output_path}\nFields filled: ${filledFields.length}`
          }],
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
        const csvLines = [headers.join(',')];
        
        for (const row of allData) {
          const values = headers.map(h => row[h] || "");
          csvLines.push(values.map(v => `"${v}"`).join(','));
        }
        
        await fs.writeFile(resolvedOutputCsv, csvLines.join('\n'));
        
        return {
          content: [{
            type: "text",
            text: `Extracted data from ${pdf_paths.length} PDFs to: ${output_csv}\nFields extracted: ${allFieldNames.size}`
          }],
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

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            pdfPath: resolvedPath,
            totalBytes: stats.size,
            initialPage,
            hasFormFields,
            fieldCount,
            fields: fieldInfo,
          },
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            viewUUID: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            pdfPath: resolvedPath,
            totalBytes: stats.size,
            initialPage,
            hasFormFields,
            fieldCount,
            fields: fieldInfo,
          },
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
        const { input_path, output_path, plan, password } = args;
        const { page_order, rotations = {} } = plan;

        if (!page_order || page_order.length === 0) {
          throw new Error("plan.page_order must be a non-empty array of page numbers.");
        }

        const resolvedInputPath = resolvePath(input_path);
        const resolvedOutputPath = resolvePath(output_path);
        if (resolvedInputPath === resolvedOutputPath) {
          throw new Error("output_path must be different from input_path to prevent file corruption.");
        }

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
        const resolvedPath = resolvePath(pdf_path);

        // Use pdf-lib for fast dimension extraction, keep pdfBytes for pdfjs-dist reuse
        const { pdfDoc, pdfBytes } = await loadPdf(pdf_path, password);
        const pdfLibPages = pdfDoc.getPages();
        const totalPages = pdfLibPages.length;

        // Pre-extract dimensions from pdf-lib (instant)
        const pageMeta = pdfLibPages.map((page, i) => {
          const { width, height } = page.getSize();
          return {
            page: i + 1,
            width: Math.round(width),
            height: Math.round(height),
            orientation: width > height ? "landscape" : "portrait",
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
  // Ensure profiles directory exists
  await fs.mkdir(PROFILES_DIR, { recursive: true }).catch(() => {});

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

