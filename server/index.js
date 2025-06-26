#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { homedir } from "os";

const server = new Server(
  {
    name: "pdf-filler",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Default directories
const DEFAULT_PDF_DIR = path.join(homedir(), "Documents");
const PROFILES_DIR = path.join(homedir(), ".pdf-filler-profiles");

// Ensure profiles directory exists
await fs.mkdir(PROFILES_DIR, { recursive: true }).catch(() => {});

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
async function fillPdfFields(pdfPath, fieldData) {
  const pdfBytes = await fs.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
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
      errors.push(`Field '${fieldName}': ${e.message}`);
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
        description: "List all PDF files in a directory",
        inputSchema: {
          type: "object",
          properties: {
            directory: {
              type: "string",
              description: "Directory path to search for PDFs (default: ~/Documents)"
            }
          }
        },
      },
      {
        name: "read_pdf_fields",
        description: "Read all form fields from a PDF file",
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
        name: "fill_pdf",
        description: "Fill a PDF form with provided data and save it",
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
            }
          },
          required: ["pdf_path"]
        },
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
        const directory = args.directory || DEFAULT_PDF_DIR;
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
        const { pdf_path } = args;
        const pdfBytes = await fs.readFile(pdf_path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
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
        };
      }

      case "fill_pdf": {
        const { pdf_path, output_path, field_data } = args;
        const { pdfDoc, filledFields, errors } = await fillPdfFields(pdf_path, field_data);
        
        const filledPdfBytes = await pdfDoc.save();
        await fs.writeFile(output_path, filledPdfBytes);
        
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
        const { pdf_path, csv_path, output_directory, filename_column } = args;
        
        // Read CSV
        const csvContent = await fs.readFile(csv_path, 'utf8');
        const records = parseCSV(csvContent);
        
        // Ensure output directory exists
        await fs.mkdir(output_directory, { recursive: true });
        
        const results = [];
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          const filename = filename_column && record[filename_column] 
            ? `${record[filename_column]}.pdf`
            : `filled_${i + 1}.pdf`;
          const outputPath = path.join(output_directory, filename);
          
          try {
            const { pdfDoc, filledFields, errors } = await fillPdfFields(pdf_path, record);
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
        const { pdf_path, output_path, profile_name, additional_data = {} } = args;
        
        // Load profile
        const profilePath = path.join(PROFILES_DIR, `${profile_name}.json`);
        const profileData = JSON.parse(await fs.readFile(profilePath, 'utf8'));
        
        // Merge profile data with additional data
        const mergedData = { ...profileData, ...additional_data };
        
        const { pdfDoc, filledFields, errors } = await fillPdfFields(pdf_path, mergedData);
        
        const filledPdfBytes = await pdfDoc.save();
        await fs.writeFile(output_path, filledPdfBytes);
        
        return {
          content: [{
            type: "text",
            text: `PDF filled with profile '${profile_name}' and saved to: ${output_path}\nFields filled: ${filledFields.length}`
          }],
        };
      }

      case "extract_to_csv": {
        const { pdf_paths, output_csv } = args;
        const allData = [];
        const allFieldNames = new Set();
        
        // Extract data from each PDF
        for (const pdfPath of pdf_paths) {
          const pdfBytes = await fs.readFile(pdfPath);
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
        
        await fs.writeFile(output_csv, csvLines.join('\n'));
        
        return {
          content: [{
            type: "text",
            text: `Extracted data from ${pdf_paths.length} PDFs to: ${output_csv}\nFields extracted: ${allFieldNames.size}`
          }],
        };
      }

      case "validate_pdf": {
        const { pdf_path } = args;
        const pdfBytes = await fs.readFile(pdf_path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
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

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("PDF Filler MCP server running...");