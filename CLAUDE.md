# PDF Toolkit MCP - Development Guide

This document provides essential context for Claude and other AI assistants when working on the PDF Toolkit extension.

## Project Overview

PDF Toolkit is a Claude Desktop extension (MCPB) and MCP server that enables automated PDF form filling, bulk processing, and data extraction. Published in the official Claude Desktop Extension Directory.

### Key Features
- List PDF files in directories
- Read form fields from PDFs (text, checkboxes, dropdowns, radio buttons)
- Fill PDF forms programmatically
- Save filled PDFs to new files
- Password-protected PDF support
- Bulk fill from CSV files
- Profile system for reusable data
- Extract data from PDFs to CSV
- Form validation
- PDF.js text-layer extraction and page/region rendering for visual inspection

## Technical Architecture

### Technology Stack
- **Runtime**: Node.js (ES modules)
- **PDF Libraries**: pdf-lib, pdfjs-dist
- **Raster Rendering**: @napi-rs/canvas
- **Protocol**: MCP (Model Context Protocol)
- **Extension Format**: MCPB (built via `mcpb pack`)

### Important Files
- `server/index.js` - Main MCP server implementation (all tool definitions and helpers). Prefer incremental updates over rewrites.
- `manifest.json` - Claude Desktop extension metadata and UI stub. Update versions alongside package.json.
- `manifest.mcpb.json` - MCPB packaging manifest
- `package.json` - Node.js dependencies
- `pdf-toolkit-mcp-share/` - Shareable package for Cursor users. Mirror changes from server/index.js when APIs evolve.
- `example-fw9.pdf` - Sample form for smoke tests. Keep anonymized assets only.
- `docs/MAINTAINERS.md` - Maintainer onboarding and operations
- `docs/RELEASE.md` - Release checklist

## Module Format: ESM

The project uses ES modules (`"type": "module"` in package.json):
- Use `import`/`export` syntax
- Dynamic `await import()` for lazy-loaded dependencies (pdfjs-dist, @napi-rs/canvas)
- The MCP SDK, MCPB runtime, and Claude Desktop all support ESM

## Password Support

Password functionality for encrypted PDFs is implemented across all relevant tools:
- `read_pdf_fields`
- `fill_pdf`
- `bulk_fill_from_csv`
- `fill_with_profile`
- `validate_pdf`
- `read_pdf_layout`
- `convert_pdf_to_markdown`

Pass the optional `password` parameter when working with protected PDFs.

## Development Commands

### Build and Package
```bash
# Install dependencies
npm install

# Run MCP server locally (for testing with Claude Desktop or Cursor)
node server/index.js

# Build and inspect a platform-complete MCPB for Claude Desktop
npm run build:mcpb

# Create shareable package for Cursor
node package-for-friend.js
```

### Testing
Run focused Vitest checks with `npm test -- <paths>`. Run
`npm run test:node-native` for the explicit platform partition of native
Node suites, and use the unfiltered `npm run test:all` aggregate for release
qualification. Then perform manual host runs against `example-fw9.pdf`:
1. `list_pdfs` against a local directory
2. `read_pdf_fields` on example-fw9.pdf
3. `fill_pdf` with test data
4. Profile flow: `save_profile`, `load_profile`, `fill_with_profile`
5. `bulk_fill_from_csv` with a two-row CSV (include a comma in one value)
6. `extract_to_csv` on two PDFs
7. `validate_pdf` on a partially filled form
8. `read_pdf_content` on a text-layer PDF and a textless scanned PDF, confirming the page-1 image fallback boundary

## Core Available Tools (selected; 1 app-only)

1. **display_pdf** - Interactive PDF viewer with search, navigation, zoom, and form field sidebar
2. **list_pdfs** - Lists PDF files in a directory
3. **read_pdf_fields** - Extracts form field information (opens viewer with form sidebar)
4. **fill_pdf** - Fills a PDF form with data
5. **bulk_fill_from_csv** - Fill multiple PDFs from CSV
6. **save_profile** - Save form data as reusable profile
7. **load_profile** - Load a saved profile
8. **list_profiles** - List all saved profiles
9. **fill_with_profile** - Fill PDF using saved profile
10. **extract_to_csv** - Extract data from PDFs to CSV
11. **validate_pdf** - Check for missing required fields
12. **read_pdf_content** - Read the PDF.js text layer; if the selected extraction contains no text, it may return a rendered page-1 image for host/model vision
13. **read_pdf_layout** - Extract bounded local text geometry and conservative reading order without OCR or table inference
14. **convert_pdf_to_markdown** - Convert a bounded supported text-layer range to deterministic Markdown with explicit coverage gaps, including evidence-backed tables and source-validated external http or https links
15. **get_pdf_resource_uri** - Get resource URI for a PDF file
16. **read_pdf_bytes** - (app-only) Chunked byte streaming for the interactive viewer
17. **merge_pdfs** - Merge multiple PDFs into a single document
18. **split_pdf** - Split a PDF by page ranges or at regular intervals
19. **rotate_pdf_pages** - Rotate pages by 90, 180, or 270 degrees
20. **reorder_pdf_pages** - Rearrange the pages of a PDF into a new order
21. **get_pdf_info** - Get page count, file size, dimensions, form field info
22. **apply_page_plan** - Reorder, rotate, and delete pages in one pass (saves as new file)
23. **get_page_analysis** - Analyze pages for blank detection, orientation, text content, images
24. **fetch_pdf_from_url** - Download a PDF from a URL to the user's local machine (bypasses Claude's WebFetch sandbox)
25. **create_signature** - Save a reusable typed or image signature
26. **list_signatures** - List saved signatures
27. **add_signature_field** - Draw a "Sign here" placeholder box (does NOT sign)
28. **apply_signature** - Stamp a saved signature at a location (requires explicit human intent; see Signature Architecture below)
29. **prepare_signing_packet** - Fill form + add sign-here boxes in one pass
30. **detect_signature_zones** - Locate signature, initials, printed-name, and date zones with coordinates. Use apply_signature for signatures and initials, and apply_text for names and dates.

### Current Extraction Boundary

The local runtime does not bundle an OCR engine. `read_pdf_content` reads the
PDF.js text layer. Only when the entire selected extraction contains no text may
it return a rendered image of page 1 for a vision-capable host or model to
inspect. `render_pdf_page` and `render_pdf_region` perform local rasterization;
they do not produce recognized text. Mixed text/raster documents and raster
pages after page 1 can therefore remain unrecognized by a broad text read.

`convert_pdf_to_markdown` consumes the bounded source-validated layout IR. It
reconstructs a table only from recurring column geometry when every row fills
every detected column and the first row carries real header evidence, and emits
a link only for a source-validated external http or https annotation target
that maps to exactly one contiguous run of text on one line. Ruling lines,
merged or spanning cells, internal destinations, actions, other URL schemes,
and ambiguous labels stay escaped text. It may restore a missing space after a
separate `log` source item only in a short, tightly bounded math run with
same-baseline variable evidence. It does not reconstruct general equations,
scripts, or fraction bars. It does not run OCR or use an external model.
Unsupported visual or structural content is reported as typed partial coverage
rather than silently represented as complete Markdown.

PDF Tools performs filesystem operations and rasterization locally and does not
upload files to a separate PDF service. Content returned through MCP can be
processed by the selected host or model under that provider's data terms. A
future local OCR engine is optional planned work, not a current capability.

## Signature Architecture (v0.8.0)

The signature tools implement a **two-tier model** agreed with Max Ferguson on 2026-04-09:

- **Tier 1 (this repo, local, free)**: Visible stamp via pdf-lib. `apply_signature` stamps a saved signature + writes an audit trail to PDF metadata. NOT legally-binding. NOT cryptographic.
- **Tier 2 (Lumin API handoff, future)**: Cryptographic signing with timestamp and certificate. `request_lumin_signature` will route prepared packets to Lumin.

**Human-intent constraint** (critical): `apply_signature` requires `user_intent_statement` + `user_confirmed_at` (ISO-8601, within last 24h). This is a legal requirement per Max: *"there's gotta be intent. Having the agent just kind of go and stamp signatures on a document without someone telling it to is not really allowed."* Agents MUST obtain these from the user and never fabricate. The validation enforces length/recency sanity checks; the intent is stored in PDF Keywords metadata for audit.

**Coordinate system**: All signature tools use **top-left origin** (x from left, y from top) in PDF points (72pt = 1 inch). Internally converted to pdf-lib's bottom-left — agents/users never need to think about it.

**Agent-safe vs human-gated split**:
- Agent-safe (no intent check): `create_signature`, `list_signatures`, `add_signature_field`, `prepare_signing_packet`
- Human-gated (requires intent): `apply_signature` only

## Code Standards

### Coding Style
- 2-space indentation
- `const`/`let` semantics (no `var`)
- Double-quoted strings
- Tool names are snake_case (`list_pdfs`, `fill_pdf`)

### Helper Functions
Reuse existing helpers in `server/index.js`:
- `resolvePath` - Resolve file paths safely
- `fillPdfFields` - Core PDF filling logic
- Profile utilities for save/load operations

### Error Handling
- Provide clear, actionable error messages
- Handle password-protected PDFs gracefully
- Guide users to correct tools (e.g., "use 'read_pdf_fields' to see available fields")

### Security
- Never log or expose passwords
- Validate file paths to prevent directory traversal
- Use secure defaults for all operations
- Never hard-code personal paths; use `resolvePath` and default directories

## Common Issues & Solutions

### Module not found errors
Ensure ESM syntax is used throughout (`import`/`export`). Check that `package.json` has `"type": "module"`.

### Password-protected PDF errors
Pass the `password` parameter to relevant tools. The error message should indicate if a password is required.

### MCPB not loading in Claude Desktop
1. Ensure `npm run build:mcpb` and the platform's `npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb` completed successfully
2. Check Claude Desktop logs for errors
3. Verify `manifest.mcpb.json` is valid JSON

### CSV parsing issues
Ensure CSV values with commas are properly quoted. Test with a value containing a comma before publishing.

## Versioning

When releasing, update versions in all places:
- `package.json`
- `manifest.json`
- `manifest.mcpb.json`

Keep versions aligned. See `docs/RELEASE.md` for the full checklist.

## Upstream Dependencies

- MCP spec and org: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- SDK package: `@modelcontextprotocol/sdk`

Watch the MCPB repo for releases and breaking changes.

### pdfjs-dist — PINNED VERSION, DO NOT UPGRADE WITHOUT TESTING

**`pdfjs-dist` is pinned to `5.4.624` (exact, no caret).** Do not upgrade.

The interactive PDF viewer (`display_pdf`) runs inside Claude Desktop's Electron sandbox, which ships an older Chromium. Newer pdfjs-dist versions (5.5+) use ES2025 APIs like `Map.prototype.getOrInsertComputed` (Chrome 134+) that crash the viewer with `TypeError: this[#t].getOrInsertComputed is not a function`. The server-side Node.js code works fine — only the viewer breaks, making the regression invisible until you test in Claude Desktop.

**If upgrading pdfjs-dist:**
1. Grep the new version for ES2025+ APIs: `grep -r "getOrInsertComputed\|sumPrecise" node_modules/pdfjs-dist/build/`
2. Rebuild the UI: `npm run build:ui`
3. Run `npm run build:mcpb` and install the artifact in Claude Desktop
4. Test `display_pdf` on at least one PDF — confirm pages render without errors
5. Check Claude Desktop logs: `~/Library/Logs/Claude/claude.ai-web.log` for `[viewer] Render error`

## Commit & Pull Request Guidelines

### Commit Style
- Use imperative subject style (e.g., "Update index.html to improve structure")
- Group related changes together
- Note version bumps explicitly in commit messages

### Pull Requests
- Include summary of affected tools
- Provide manual test evidence
- Link related issues if applicable
- Only include screenshots when UI assets change

### Artifacts
- Regenerate artifacts (`pdf-toolkit-mcp.zip`, `.mcpb`) in separate commits
- Or attach them to releases rather than merging binaries directly
- Keep version numbers aligned across `package.json`, `manifest.json`, and the share bundle

### Before Committing
- Scrub PDFs or CSVs of personal data before committing
- Use local-only credentials files when testing protected documents
- Never commit sensitive test data

## Contributing

1. Read `docs/MAINTAINERS.md` for architecture details
2. Follow `docs/RELEASE.md` before publishing
3. Use GitHub Issues for bugs and feature requests
4. Include manual test evidence in PRs

## Project Links

- **Repository**: https://github.com/Open-Document-Alliance/PDF-Tools
- **Issues**: https://github.com/Open-Document-Alliance/PDF-Tools/issues
