# PDF Tools - Fill, Analyze, Extract, View

The complete PDF toolkit for Claude Desktop. Work with PDFs already on your computer — fill forms, analyze documents, extract data, and view them interactively without uploading.

## Features

### Interactive PDF Viewer
- View any PDF with page navigation, zoom, and fullscreen
- Search text across all pages with highlighted results
- Select and copy text directly from PDFs
- Form field sidebar shows all fields with fill status

### Fill Forms & Automate
- Fill out W-9, 1099, I-9, rental applications, and any fillable PDF
- Bulk fill hundreds of PDFs from CSV data
- Save reusable profiles for common forms
- Validate required fields before submission

### Analyze & Extract
- Analyze research papers and academic documents
- Extract tables and structured data to CSV
- Compare contract versions
- Summarize 300+ page reports
- OCR support for scanned documents

### Works with any PDF type
Scientific papers, legal contracts, technical manuals, financial statements, invoices, and forms. Handles fillable forms, scanned documents, and encrypted PDFs.

## Installation

### Claude Desktop Extension

#### Quick Install
1. **[Download the latest .mcpb file from Releases](https://github.com/Open-Document-Alliance/PDF-Tools/releases/latest)**
2. Double-click the `.mcpb` file to install in Claude Desktop

The extension is also available in the Claude Extensions directory.

#### Build from Source
```bash
git clone https://github.com/Open-Document-Alliance/PDF-Tools
cd PDF-Tools
npm install
npm run build:ui
npm install -g @anthropic-ai/mcpb
mcpb pack
# Install the generated .mcpb file in Claude Desktop
```

### Cursor / Other MCP Hosts

```bash
git clone https://github.com/Open-Document-Alliance/PDF-Tools
cd PDF-Tools
npm install

# Add to your MCP client config:
{
  "mcpServers": {
    "pdf-tools": {
      "command": "node",
      "args": ["/full/path/to/PDF-Tools/server/index.js"]
    }
  }
}
```

## Usage

Ask Claude to:

### View PDFs
*"Open my W-9 and show me the fields"*
*"Display the contract PDF in my Documents folder"*

### Fill Forms
*"Fill this W-9 with my business info: Company Name LLC, 123 Main St, Tax ID 12-3456789"*
*"Use my 'work' profile to fill this application"*

### Analyze Documents
*"Summarize this research paper"*
*"What does this contract say about payment terms?"*
*"Extract all text from this scanned invoice"* (OCR)

### Bulk Processing
*"Fill 50 contract PDFs using the client data from contracts.csv"*
*"Extract data from all PDFs in this folder to summary.csv"*

### Password-Protected PDFs
*"Read the fields from this encrypted PDF using password 'mypassword123'"*

## Available Tools

| Tool | Description |
|------|-------------|
| `display_pdf` | Interactive PDF viewer with search, navigation, zoom, and form field sidebar |
| `list_pdfs` | List PDF files in a directory |
| `read_pdf_fields` | Read form field names, types, and current values |
| `fill_pdf` | Fill a PDF form with data and save |
| `bulk_fill_from_csv` | Fill multiple PDFs from CSV data |
| `save_profile` | Save form data as a reusable profile |
| `load_profile` | Load a saved profile |
| `list_profiles` | List all saved profiles |
| `fill_with_profile` | Fill a PDF using a saved profile |
| `extract_to_csv` | Extract form data from PDFs to CSV |
| `validate_pdf` | Check for missing required fields |
| `read_pdf_content` | Extract text content (with OCR fallback for scans) |
| `get_pdf_resource_uri` | Get a resource URI for Claude's Resources API |

## Development

### Project Structure
```
PDF-Tools/
├── server/index.js          # MCP server (all tool definitions)
├── ui/                      # Interactive viewer source (TypeScript)
├── dist-ui/                 # Built viewer (single-file HTML)
├── vite.config.mjs          # Vite build config for viewer
├── manifest.json            # Claude Desktop extension metadata
├── manifest.mcpb.json       # MCPB packaging manifest
├── package.json             # Dependencies
├── docs/                    # Maintainer and release docs
└── scripts/reinstall.sh     # Dev helper for extension reinstall
```

### Build Commands
```bash
npm install              # Install dependencies
npm run build:ui         # Build the interactive viewer
node server/index.js     # Run MCP server locally
mcpb pack                # Build Claude Desktop extension
```

### Maintainer Docs
- `docs/MAINTAINERS.md` — Architecture and operations
- `docs/RELEASE.md` — Release checklist
- `docs/SUPPORT.md` — Issue triage

## Upstream Dependencies

- MCP spec: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- MCP Apps: https://github.com/modelcontextprotocol/ext-apps
- SDK: `@modelcontextprotocol/sdk`

## License

MIT

## Contributing

Pull requests welcome. See `docs/MAINTAINERS.md` for architecture details.
