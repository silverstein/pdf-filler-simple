# Repository Guidelines

## Project Structure & Module Organization
- `server/index.js`: Node MCP server exposing PDF tools shared by Claude Desktop and Cursor. Keep tool definitions and helper utilities here; prefer incremental updates over rewrites.
- `pdf-toolkit-mcp-share/`: Packaged variant used by `package-for-friend.js`; mirror changes from `server/index.js` when APIs evolve.
- `manifest.json` and `index.html`: Claude Desktop extension metadata and UI stub. Update versions alongside `package.json`.
- `example-fw9.pdf`: Sample form for smoke tests. Keep anonymized assets only.

### Tools currently shipped
- `display_pdf`, `list_pdfs`, `read_pdf_fields`, `fill_pdf`, `bulk_fill_from_csv`, `save_profile`, `load_profile`, `list_profiles`, `fill_with_profile`, `extract_to_csv`, `validate_pdf`, `read_pdf_content`, `get_pdf_resource_uri`, `read_pdf_bytes` (app-only).

## Build, Test, and Development Commands
- `npm install`: install runtime dependencies (Node.js 18+).
- `node server/index.js`: run the MCP server over stdio for local hosts (Cursor, Claude) and watch stderr for diagnostics.
- `node package-for-friend.js`: regenerate `pdf-toolkit-mcp.zip`; requires the `zip` CLI and ensures shareable installers stay current.
- `mcpb pack`: rebuild the `.mcpb` extension after code or asset updates; install via Claude Desktop to validate.

## Coding Style & Naming Conventions
- Use 2-space indentation, `const`/`let` semantics, and double-quoted strings to match `server/index.js` and shipped bundles.
- Favor composable helpers over inlined logic; reuse `resolvePath`, `fillPdfFields`, and profile utilities instead of duplicating them.
- Tool names stay snake_case (`list_pdfs`, `fill_pdf`); new tools should follow that pattern and return structured text blocks.

## Testing Guidelines
- No automated test suite yet; perform manual runs against `example-fw9.pdf` via the MCP host. Exercise `list_pdfs`, `read_pdf_fields`, `fill_pdf`, and one profile flow.
- Validate CSV workflows with a two-row fixture before publishing; include a value with a comma to catch CSV parsing regressions.
- Smoke-test new tools: `extract_to_csv` on two PDFs, `validate_pdf` on a partially filled form, `read_pdf_content` on text and scanned PDFs, and `get_pdf_resource_uri` with a local file path.

## Commit & Pull Request Guidelines
- Follow the existing imperative subject style (`Update index.html to improve structure`). Group related changes and note version bumps explicitly.
- Include PR context: summary of affected tools, manual test evidence, linked issue if applicable, and screenshots only when UI assets change.
- Regenerate artifacts (`pdf-toolkit-mcp.zip`, `.mcpb`) in separate commits or attach them to releases rather than merging binaries directly. Keep version numbers aligned across `package.json`, `manifest.json`, and the share bundle.

## Maintainer Docs
- `docs/MAINTAINERS.md` for architecture, packaging, and manual test checklist.
- `docs/RELEASE.md` for release steps and artifact handling.
- `docs/SUPPORT.md` for issue intake and triage flow.

## Upstream Tracking
- MCP spec/org: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- SDK: `@modelcontextprotocol/sdk`

## Security & Configuration Tips
- Never hard-code personal paths; rely on `resolvePath` and default directories (`~/Documents`, `~/.pdf-toolkit-files`).
- Scrub PDFs or CSVs before committing, and point contributors to local-only credentials files when testing protected documents.
