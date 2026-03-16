#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument } from "pdf-lib";
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

const server = new Server(
  {
    name: "pdf-tools",
    version: "0.5.0",
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
  const pdfBytes = await fs.readFile(pdfPath);
  
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { password });
  } catch (error) {
    if (error.message?.includes('password') || error.message?.includes('encrypt')) {
      throw new Error(`PDF is password-protected. Please provide the correct password using the 'password' parameter.`);
    }
    throw new Error(`Failed to load PDF: ${error.message}`);
  }
  
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
      },
      {
        name: "list_profiles",
        description: "List all saved profiles",
        inputSchema: {
          type: "object",
          properties: {}
        },
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
        _meta: {
          ui: {
            visibility: ["app"]
          }
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
        const resolvedPath = resolvePath(pdf_path);
        const pdfBytes = await fs.readFile(resolvedPath);
        
        let pdfDoc;
        try {
          pdfDoc = await PDFDocument.load(pdfBytes, { password });
        } catch (error) {
          if (error.message?.includes('password') || error.message?.includes('encrypt')) {
            throw new Error(`PDF is password-protected. Please provide the correct password using the 'password' parameter.`);
          }
          throw new Error(`Failed to load PDF: ${error.message}`);
        }
        
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
          const filename = filename_column && record[filename_column] 
            ? `${record[filename_column]}.pdf`
            : `filled_${i + 1}.pdf`;
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
        const resolvedPath = resolvePath(pdf_path);
        const pdfBytes = await fs.readFile(resolvedPath);
        
        let pdfDoc;
        try {
          pdfDoc = await PDFDocument.load(pdfBytes, { password });
        } catch (error) {
          if (error.message?.includes('password') || error.message?.includes('encrypt')) {
            throw new Error(`PDF is password-protected. Please provide the correct password using the 'password' parameter.`);
          }
          throw new Error(`Failed to load PDF: ${error.message}`);
        }
        
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
