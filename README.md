# PDF Tools for Claude Desktop and Local MCP Hosts

The local PDF workflow for Claude Desktop and MCP hosts: fill, sign, merge,
split, extract, render, and analyze PDFs with local file operations.

Instead of just opening a PDF, PDF Tools lets Claude fetch PDF URLs to your
machine, inspect documents visually, fill forms, save reusable profiles, add
signature/date zones, merge and split files, reorganize pages visually, extract
structured data, and return document content to your chosen MCP host for analysis.

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
- **Local file operations:** PDF Tools reads, renders, edits, and saves files on your machine instead of uploading them to a separate PDF service
- **Directory sandbox:** Claude Desktop users can choose which local folders PDF Tools may read from or write to

Text, images, and metadata returned by PDF Tools may be processed by Claude or
another MCP host. Your host and model provider's data terms apply to that
content, so the complete workflow is not necessarily zero egress.

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

- Detect likely signature, initials, printed-name, and date zones with model-readable coordinates
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

- Read existing PDF text layers for summarization, question answering, and research workflows
- Extract structured data to CSV
- Inspect page-level details like orientation, text presence, images, and likely blank pages
- Review source-bound page geometry, bounded metadata, form widgets, ordinary annotations, and file identity
- Inspect exactly eight shallow catalog-level accessibility signals with explicit missing or unavailable states and required human review

PDF Tools does not currently bundle an OCR engine. Text reads use the PDF.js
text layer. If the selected `read_pdf_content` result contains no text, the tool
may return a rendered image of page 1 for vision-capable host/model inspection.
Page and region rendering produces raster images, not recognized text. A mixed
text/raster PDF, or raster pages after page 1, may therefore contain content the
broad text read does not recognize. Optional local OCR remains a planned
improvement rather than a shipped capability.

`get_pdf_info` binds these observations to the exact race-aware source
SHA-256, keeps widget annotations separate from ordinary annotations, and
returns link or action targets only as inert values. Page and region renders
report page geometry, coordinate spaces, renderer policy, the PNG SHA-256,
and raw RGBA SHA-256 availability.

`inspect_pdf_accessibility` is a bounded structural-review screen for an
unencrypted local PDF. It does not run veraPDF, assess tag semantics or
assistive-technology behavior, or establish PDF/UA, WCAG, certification,
legal, or document-accessibility conclusions.

Region-render inputs are top-left PDF.js viewport points after CropBox,
rotation, and UserUnit. They are not MediaBox-relative signing-zone
coordinates. The macOS Quick Look fallback renders whole pages and regions in
that same view and reports raw pixels unavailable.

## Great Fit For

- Researchers reviewing papers and reports
- Operators processing forms and back-office PDFs
- Lawyers organizing contracts and comparing versions
- Accountants handling tax documents
- Anyone who wants local PDF file operations in Claude without a separate PDF upload service

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
- "Read the available text from this invoice and tell me which pages need visual inspection"
- "Render page 1 of this scanned invoice so you can inspect it visually"
- "Render just the signature block on page 3 so you can inspect it visually"
- "Read pages 8 through 10 of this contract"
- "Search this PDF for every mention of governing law"
- "Convert pages 1 through 6 of this PDF to Markdown and tell me about any coverage gaps"
- "Export all the filled fields from these PDFs into a CSV"
- "Analyze this PDF for blank pages and sideways pages"

## Core Tools

This list is complete: it names every tool the server registers. One of them,
`read_pdf_bytes`, is available only to the in-app viewer and is not packed into
the `.mcpb` manifest that ordinary model workflows discover.

### Viewer and Reading

- `display_pdf`
- `fetch_pdf_from_url`
- `list_pdfs`
- `read_pdf_content`
- `read_pdf_pages`
- `read_pdf_layout`
- `convert_pdf_to_markdown` (reconstructs evidence-backed tables and source-validated external http or https links; unsupported, ambiguous, internal, and action links stay escaped text reported as typed gaps)
- `verify_table_proposal` (reparses the source and applies the B2 coverage, ordering, and independent-header checks to an untrusted proposal; accepted content is source-derived, but topology is not yet proven unique)
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
- `compare_pdfs`
- `get_pdf_identity`
- `get_pdf_info`
- `inspect_pdf_accessibility`
- `get_page_analysis`

### Active Document and Host Helpers

- `get_active_document`
- `set_active_document`
- `get_allowed_directories`
- `read_pdf_bytes`
- `reveal_in_finder`

## Build From Source

```bash
git clone https://github.com/Open-Document-Alliance/PDF-Tools
cd PDF-Tools
npm ci
npm run build:mcpb
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
npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb
npm run build:ui
npm run build:mcpb
npm test
npm run test:node-native
npm run test:all
node server/index.js
node package-for-friend.js
```

`npm test` runs the Vitest partition. Release qualification uses
`npm run test:all` so the explicitly classified Node native-test suites cannot
be silently omitted.

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

- `docs/MAINTAINERS.md`: architecture and operations
- `docs/RELEASE.md`: release checklist
- `docs/SUPPORT.md`: issue triage

</details>

## Upstream Dependencies

- MCP spec: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- MCP Apps: https://github.com/modelcontextprotocol/ext-apps
- SDK: `@modelcontextprotocol/sdk`

## License

MIT

### Third-party notices

The MCPB and the share ZIP both carry a vendored QPDF WebAssembly runtime at
`vendor/qpdf-wasm/runtime/`. No tool loads it yet; it is packaged ahead of the
integration that will use it. qpdf is Apache-2.0, and the complete notice set
(qpdf, zlib, libjpeg-turbo, the Emscripten generated runtime, musl,
compiler-rt, libc++, libc++abi and libunwind) ships beside it in
`vendor/qpdf-wasm/runtime/licenses/`, bound to its SHA-256 hashes by
`licenses/manifest.json`. The npm dependencies keep their own licences inside
`node_modules/`, including the PDF.js, Foxit and Liberation font notices.
