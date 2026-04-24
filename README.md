# PDF Tools for Claude Desktop and Local MCP Hosts

The local PDF workflow for Claude Desktop and MCP hosts: fill, sign, merge,
split, extract, and analyze PDFs without sending files to a web app.

Instead of just opening a PDF, PDF Tools lets Claude fetch PDF URLs to your
machine, inspect documents visually, fill forms, save reusable profiles, add
signature/date zones, merge and split files, reorganize pages visually, extract
structured data, and analyze document content locally.

This package targets Claude Desktop and other local MCP hosts today. It does not yet include a remote connector for Claude Cowork / web-hosted Claude.

## Install

### Claude Desktop

1. **[Download the latest `.mcpb` from Releases](https://github.com/Open-Document-Alliance/PDF-Tools/releases/latest)**
2. Double-click the `.mcpb` file to install it in Claude Desktop

The extension is also available in the Claude Extensions directory.

Claude Desktop settings include an **Allowed PDF Directories** field. By default,
PDF Tools can access `~/Documents`, `~/Downloads`, and `~/Desktop`. Add any other
folder you want Claude to use before asking it to read, fill, sign, merge, or save
PDFs there. Saved profiles and signatures live in the extension's private local
store and do not need to be added manually.

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
- **Sign mode:** signature/date zone detection, saved or drawn local signatures, text stamping, inspect-region, and preview-to-zone flows
- **URL-to-PDF workflows:** fetch HTTP(S) PDF links to the local machine when sandboxed web fetches are blocked
- **Page organization:** merge, split, rotate, reorder, and apply full page plans in one pass
- **Extraction and analysis:** page-bounded reads, text search, page/region rendering, CSV export, page-level analysis, metadata, and validation
- **Local-first:** files stay on your machine
- **Directory sandbox:** Claude Desktop users can choose which local folders PDF Tools may read from or write to

## What You Can Do

### Interactive PDF Viewer

- View PDFs with page navigation, zoom, search, and fullscreen
- Select and copy text directly from pages
- See form fields in a sidebar with fill status
- Use visual page management to reorder, rotate, and remove pages before saving a new copy

### URL-to-PDF Workflows

- Download PDFs from HTTP(S) URLs to your local machine
- Open downloaded PDFs immediately in the viewer for fill, sign, page management, extraction, or analysis
- Use the local MCP host for cases where Claude's normal web/proxy fetch path cannot retrieve the PDF
- Keep downloaded PDFs inside user-approved local directories

### Forms and Reusable Profiles

- Fill W-9s, 1099s, rental applications, waivers, and any fillable PDF
- Save personal or business details as reusable profiles
- List, load, and apply saved profiles so repeated forms take seconds instead of minutes
- Bulk fill many PDFs from CSV data and validate required fields before submission

### Sign Mode and Local Signatures

- Detect likely signature, initials, and date zones with model-readable coordinates
- Switch to the viewer's Sign tab to place signatures, dates, or text on detected zones
- Draw or reuse saved local signatures
- Inspect a region, preview it, and turn it into a typed signing zone when automatic detection is not enough
- Keep signing edits local, with active-document tracking and backup behavior for same-file mutations

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
- "Download this PDF URL locally, open it, and tell me what needs to be filled out"

### Fill Forms

- "Fill this W-9 with my business info: Company Name LLC, 123 Main St, Tax ID 12-3456789"
- "Use my work profile to fill this application"
- "Save this data as a reusable profile called advisor-office"

### Sign and Date

- "Find every place this PDF needs a signature or date"
- "Open Sign mode so I can draw and place my signature"
- "Add sign-here and date boxes to this completed form"
- "Inspect the signature block on page 5 and create a custom signing zone there"

### Organize Pages

- "Merge these three contracts into one PDF"
- "Split this report every 10 pages"
- "Rotate page 3 by 90 degrees"
- "Open Manage Pages so I can reorder and delete pages visually"

### Analyze and Extract

- "Summarize this research paper"
- "Extract all text from this scanned invoice"
- "Render page 1 of this scanned invoice so you can inspect it visually"
- "Render just the signature block on page 3 so you can inspect it visually"
- "Read pages 8 through 10 of this contract"
- "Search this PDF for every mention of governing law"
- "Export all the filled fields from these PDFs into a CSV"
- "Analyze this PDF for blank pages and sideways pages"

## Core Tools

### Viewer and Reading

- `display_pdf`
- `fetch_pdf_from_url`
- `list_pdfs`
- `read_pdf_content`
- `read_pdf_pages`
- `render_pdf_page`
- `render_pdf_region`
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

### Signatures

- `detect_signature_zones`
- `add_signature_field`
- `prepare_signing_packet`
- `create_signature`
- `list_signatures`
- `load_signature`
- `apply_signature`
- `apply_text`

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

### Active Document and Host Helpers

- `get_active_document`
- `set_active_document`
- `get_pdf_resource_uri`
- `read_pdf_bytes`
- `reveal_in_finder`

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
npm run dev:ui
npm run smoke:ui-dev
npm run smoke:ui-sign
npm run smoke:ui-inspect
npm run smoke:ui-preview-zone
npm run smoke:ui-draw
npm run build:ui
npm test
node server/index.js
mcpb pack
node package-for-friend.js
```

### Viewer Dev Mode

`npm run dev:ui` starts the Vite viewer with a mocked ext-apps host and a real local MCP subprocess behind `/__dev__/tool`.

- Default URL: `http://127.0.0.1:5173/?pdf_path=example-fw9.pdf`
- You can point at another file with `?pdf_path=/absolute/path/to/file.pdf`
- The dev bridge is serve-only; `npm run build:ui` still produces the production single-file viewer for packaging
- `npm run smoke:ui-dev` starts the dev server on a throwaway port, verifies the HTML loads, and round-trips a real `display_pdf` tool call through `/__dev__/tool`
- `npm run smoke:ui-sign` boots the dev server, opens a real browser session with `agent-browser`, switches to sign mode, and verifies a sign-panel interaction opens a signing modal
- `npm run smoke:ui-inspect` boots the dev server, opens a real browser session with `agent-browser`, switches to sign mode, arms inspect-region, drags a rectangle, and verifies the region preview modal opens
- `npm run smoke:ui-preview-zone` boots the dev server, opens a real browser session, drives inspect-region, creates a zone from the preview modal, and verifies the sign modal opens on that new custom zone
- `npm run smoke:ui-draw` boots the dev server, opens the draw-signature modal in a real browser session, sketches a small stroke, fills the save fields, and verifies the modal closes after saving

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
