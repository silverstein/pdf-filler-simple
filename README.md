# PDF Tools for Claude Desktop and Local MCP Hosts

The full local PDF workflow for Claude Desktop and MCP hosts.

Instead of just opening a PDF, PDF Tools lets Claude view it interactively, fill forms, save reusable profiles, merge and split files, reorganize pages visually, extract structured data, and analyze document content without uploading anything to a web app.

This package targets Claude Desktop and other local MCP hosts today. It does not yet include a remote connector for Claude Cowork / web-hosted Claude.

## Install

### Claude Desktop

1. **[Download the latest `.mcpb` from Releases](https://github.com/Open-Document-Alliance/PDF-Tools/releases/latest)**
2. Double-click the `.mcpb` file to install it in Claude Desktop

The extension is also available in the Claude Extensions directory.

### Cursor / Other MCP Hosts

```json
{
  "mcpServers": {
    "pdf-tools": {
      "command": "node",
      "args": ["/full/path/to/PDF-Tools/server/index.js"]
    }
  }
}
```

## Why It's Different

Claude already knows how to read PDFs in limited ways. PDF Tools goes much further:

- **Interactive viewer:** page navigation, zoom, search, fullscreen, text selection, and form-field sidebar
- **Form workflows:** `fill_pdf`, `read_pdf_fields`, `bulk_fill_from_csv`, and reusable profiles
- **Page organization:** merge, split, rotate, reorder, and apply full page plans in one pass
- **Extraction and analysis:** text extraction, CSV export, page-level analysis, metadata, and validation
- **Local-first:** files stay on your machine

## What You Can Do

### Interactive PDF Viewer

- View PDFs with page navigation, zoom, search, and fullscreen
- Select and copy text directly from pages
- See form fields in a sidebar with fill status
- Use visual page management to reorder, rotate, and remove pages before saving a new copy

### Forms and Reusable Profiles

- Fill W-9s, 1099s, rental applications, waivers, and any fillable PDF
- Save personal or business details as reusable profiles
- List, load, and apply saved profiles so repeated forms take seconds instead of minutes
- Bulk fill many PDFs from CSV data and validate required fields before submission

### Page Organization Tools

- Merge multiple PDFs into one document
- Split PDFs by exact page ranges or regular intervals
- Rotate and reorder pages
- Apply a full page plan in one pass to reorder, rotate, and delete pages while preserving the original

### Extraction and Analysis

- Read document text for summarization, question answering, and research workflows
- Extract structured data to CSV
- Inspect page-level details like orientation, text presence, images, and likely blank pages
- Review metadata such as page count, dimensions, form fields, and file size

## Great Fit For

- Researchers reviewing papers and reports
- Operators processing forms and back-office PDFs
- Lawyers organizing contracts and comparing versions
- Accountants handling tax documents
- Anyone who wants a serious PDF workflow in Claude without sending files to a web app

## Example Prompts

### View and Inspect

- "Open my W-9 and show me the fields"
- "Display the contract PDF in my Documents folder"
- "Search this report for every mention of indemnification"

### Fill Forms

- "Fill this W-9 with my business info: Company Name LLC, 123 Main St, Tax ID 12-3456789"
- "Use my work profile to fill this application"
- "Save this data as a reusable profile called advisor-office"

### Organize Pages

- "Merge these three contracts into one PDF"
- "Split this report every 10 pages"
- "Rotate page 3 by 90 degrees"
- "Open Manage Pages so I can reorder and delete pages visually"

### Analyze and Extract

- "Summarize this research paper"
- "Extract all text from this scanned invoice"
- "Read pages 8 through 10 of this contract"
- "Search this PDF for every mention of governing law"
- "Export all the filled fields from these PDFs into a CSV"
- "Analyze this PDF for blank pages and sideways pages"

## Core Tools

### Viewer and Reading

- `display_pdf`
- `list_pdfs`
- `read_pdf_content`
- `read_pdf_pages`
- `search_pdf_text`
- `get_pdf_resource_uri`

### Forms and Profiles

- `read_pdf_fields`
- `fill_pdf`
- `bulk_fill_from_csv`
- `save_profile`
- `load_profile`
- `list_profiles`
- `fill_with_profile`
- `validate_pdf`

### Organization and Page Management

- `merge_pdfs`
- `split_pdf`
- `rotate_pdf_pages`
- `reorder_pdf_pages`
- `apply_page_plan`

### Extraction and Analysis

- `extract_to_csv`
- `get_pdf_info`
- `get_page_analysis`

## Build From Source

```bash
git clone https://github.com/Open-Document-Alliance/PDF-Tools
cd PDF-Tools
npm install
npm run build:ui
npm install -g @anthropic-ai/mcpb
mcpb pack
```

## Development

<details>
<summary>Development and maintainer details</summary>

### Project Structure

```text
PDF-Tools/
├── server/index.js           # MCP server entry point
├── server/helpers.js         # Shared helper functions
├── ui/                       # Interactive viewer source (TypeScript)
├── dist-ui/                  # Built viewer (single-file HTML)
├── test/                     # Unit tests (Vitest)
├── manifest.json             # Extension metadata
├── manifest.mcpb.json        # MCPB packaging manifest
├── package-for-friend.js     # Share-bundle packaging script
└── docs/                     # Maintainer and release docs
```

### Common Commands

```bash
npm install
npm run build:ui
npm test
node server/index.js
mcpb pack
node package-for-friend.js
```

### Maintainer Docs

- `docs/MAINTAINERS.md` — architecture and operations
- `docs/RELEASE.md` — release checklist
- `docs/SUPPORT.md` — issue triage

</details>

## Upstream Dependencies

- MCP spec: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- MCP Apps: https://github.com/modelcontextprotocol/ext-apps
- SDK: `@modelcontextprotocol/sdk`

## License

MIT
