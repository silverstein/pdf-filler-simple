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
| `compare_pdfs` | source-bound whole-document alignments, seven-channel coverage, evidence, typed changes, reversible presentation decisions, and an equivalence-claim boundary |
| `create_signature` | saved signature metadata |
| `convert_pdf_to_markdown` | deterministic Markdown, typed coverage gaps (incl. `TABLE_RULING_UNSUPPORTED`, `TEXT_INTEGRITY_SUSPECT`), `pages_needing_vision` routing, opt-in compact `normalizations` counts, provenance, and optional verified UTF-8 output |
| `detect_signature_zones` | detected coordinate zones |
| `display_pdf` | active document and form summary |
| `extract_to_csv` | CSV counts, headers, and bounded row preview |
| `fetch_pdf_from_url` | active document and download provenance |
| `fill_pdf` | active document and field-fill outcome |
| `fill_with_profile` | active document and profile-fill outcome |
| `get_active_document` | empty or populated active-document state |
| `get_page_analysis` | bounded page analysis with explicit provenance, operator counts, and a `classification` rollup (`document_kind`, typed `pages_needing_vision`, explicit `pages_not_analyzed`) |
| `get_pdf_identity` | parser-independent canonical path, byte length, and SHA-256 |
| `get_pdf_info` | bounded source-bound page, metadata, form-widget, and inert annotation observations with typed coverage, exact accounting, and a full-envelope digest |
| `get_pdf_resource_uri` | resource URI and local file metadata |
| `list_signatures` | saved signature summaries, including an empty array |
| `load_signature` | signature metadata and optional preview |
| `merge_pdfs` | active output document and page count |
| `prepare_signing_packet` | active document, fills, and pending placements |
| `read_pdf_bytes` | bounded base64 byte chunk |
| `read_pdf_content` | complete/partial text or image-fallback result with page-scoped routing facts (`read_pages_without_text`, integrity signals, typed `page_read_error`) preserved through failure and resource-limit branches |
| `read_pdf_fields` | active document and form fields |
| `read_pdf_pages` | bounded page-numbered text |
| `read_pdf_layout` | versioned bounded Extraction IR with source, geometry, reading order, gaps, and limits |
| `render_pdf_page` | source identity, distinct raw page and PDF.js view geometry, renderer policy, raster dimensions, and PNG/raw-pixel digest evidence |
| `render_pdf_region` | source identity, PDF.js viewport request coordinates, rendered raster region, page/view geometry, renderer policy, and PNG/raw-pixel digest evidence |
| `reorder_pdf_pages` | active output document and page order |
| `reveal_in_finder` | revealed path and platform |
| `rotate_pdf_pages` | active output document and rotation outcome |
| `search_pdf_text` | bounded page matches |
| `set_active_document` | populated active-document state |
| `validate_pdf` | versioned PDF field-validation result |

The following four tools remain intentionally text-only and therefore do not
advertise `outputSchema`: `list_pdfs`, `list_profiles`, `load_profile`,
and `save_profile`. Their error results are also
text-only; attaching an undeclared `structuredContent` error would create a
wire contract that discovery does not publish.

`get_pdf_identity` adds exact structured error codes for an unavailable file,
invalid PDF header, input over 250 MiB, and a file or pathname that changed
during hashing. Path-policy denial remains the shared structured error.

`compare_pdfs` has stable structured failures for page-cap refusal, source
identity races, password requirements or rejection, unsupported parsing,
filesystem policy denial, unavailable inputs, output-cap refusal, and internal
validation failure. Success validates complete source-page alignment coverage,
known sorted coverage reasons, evidence geometry and digests, change/facet
relations, summary counts, zero server network/persistence effects, and a full
comparison-envelope digest before leaving the server.

The low-level MCP server does not apply advertised input schemas on its own.
Session rehydration and coordinate-bearing mutations therefore validate and
normalize typed arguments before changing active-document state, opening an
output, creating a backup, or editing a PDF. Returned placement and timestamp
fields are the normalized values actually used for the operation.

Saved signature JSON is treated as untrusted input. A shared validator binds
the record name to the requested signature, preserves legacy records that omit
`created_at`, checks typed display text against the actual signature font, and
verifies image MIME, canonical base64, magic bytes, and decoder compatibility.
Creation, listing, loading, and application all use that validator. In
particular, `apply_signature` rejects an unusable or identity-confused record
before loading the target PDF, writing output, or changing active-document
state.

The executable source of truth is `server/output-schemas.js`. The MCP contract
tests assert this complete 37/4 matrix, compile every schema through the pinned
SDK validator, reject newer unsupported JSON Schema keywords, exercise live
success and error branches, and require byte-identical source/share runtime
files.
