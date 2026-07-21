# Structured tool output contracts

PDF Tools advertises an MCP `outputSchema` only when a tool can return
`structuredContent`. The schema is part of the wire contract: a successful
result is validated before it leaves the server, structured errors are checked
only against their error branches, and an invalid or missing structured result
is replaced with a text-only `isError` response. Every
structured success also retains `TextContent` for clients that do not consume
structured output.

The pinned MCP SDK 1.29 client validates any `structuredContent` it receives,
including content attached to `isError` results. Consequently each advertised
schema has tightly constrained branches for the generic versioned error
envelope and, where the runtime intentionally returns one, a tool-specific
structured error. Server-side success validation uses only the success branch;
an `isError` result is never forced through a success schema.

## Discovery matrix

| Tool | Advertised structured contract |
| --- | --- |
| `add_signature_field` | active document plus placement |
| `apply_page_plan` | active document plus page-plan outcome |
| `apply_signature` | active document plus signature-stamp audit fields |
| `apply_text` | active document plus text placement |
| `bulk_fill_from_csv` | row results and bounded record preview |
| `create_signature` | saved signature metadata |
| `detect_signature_zones` | detected coordinate zones |
| `display_pdf` | active document and form summary |
| `extract_to_csv` | CSV counts, headers, and bounded row preview |
| `fetch_pdf_from_url` | active document and download provenance |
| `fill_pdf` | active document and field-fill outcome |
| `fill_with_profile` | active document and profile-fill outcome |
| `get_active_document` | empty or populated active-document state |
| `get_page_analysis` | bounded page analysis with explicit provenance |
| `get_pdf_resource_uri` | resource URI and local file metadata |
| `list_signatures` | saved signature summaries, including an empty array |
| `load_signature` | signature metadata and optional preview |
| `merge_pdfs` | active output document and page count |
| `prepare_signing_packet` | active document, fills, and pending placements |
| `read_pdf_bytes` | bounded base64 byte chunk |
| `read_pdf_content` | complete/partial text or image-fallback result |
| `read_pdf_fields` | active document and form fields |
| `read_pdf_pages` | bounded page-numbered text |
| `render_pdf_page` | page raster metadata |
| `render_pdf_region` | region raster metadata |
| `reorder_pdf_pages` | active output document and page order |
| `reveal_in_finder` | revealed path and platform |
| `rotate_pdf_pages` | active output document and rotation outcome |
| `search_pdf_text` | bounded page matches |
| `set_active_document` | populated active-document state |
| `validate_pdf` | versioned PDF field-validation result |

The following six tools remain intentionally text-only and therefore do not
advertise `outputSchema`: `get_pdf_info`, `list_pdfs`, `list_profiles`,
`load_profile`, `save_profile`, and `split_pdf`. Their error results are also
text-only; attaching an undeclared `structuredContent` error would create a
wire contract that discovery does not publish.

The low-level MCP server does not apply advertised input schemas on its own.
Session rehydration and coordinate-bearing mutations therefore validate and
normalize typed arguments before changing active-document state, opening an
output, creating a backup, or editing a PDF. Returned placement and timestamp
fields are the normalized values actually used for the operation.

The executable source of truth is `server/output-schemas.js`. The MCP contract
tests assert this complete 31/6 matrix, compile every schema through the pinned
SDK validator, reject newer unsupported JSON Schema keywords, exercise live
success and error branches, and require byte-identical source/share runtime
files.
