# MCP tool-annotation audit: 2026-07-21

This living audit is the handler-by-handler evidence behind PDF Tools' current
42 MCP `ToolAnnotations`. It covers the source runtime and the byte-identical
share runtime. It is a risk declaration for host UX, not an authorization
boundary. The original 2026-07-21 verification numbers remain below as
historical evidence for the then-current 41-tool surface.

## Semantics used

The audit applies the MCP `2025-11-25` definitions:

- [`readOnlyHint`](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#toolannotations)
  is true only when a call does not modify its environment.
- `destructiveHint` is true when a write-capable tool may replace or remove
  existing state; false means its updates are only non-destructive. It is only
  meaningful when `readOnlyHint` is false.
- `idempotentHint` is true only when repeating the same successful call with
  the same arguments converges on the same user-visible state. It is only
  meaningful when `readOnlyHint` is false.
- `openWorldHint` is true when a tool can interact with an open set of external
  entities. The [MCP maintainers' annotation guidance](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
  recommends treating external output as potentially untrusted and notes that
  this boundary depends on deployment context.

The local path allowlist is treated as a closed domain. The sole unbounded
network operation, `fetch_pdf_from_url`, is open-world. A write is destructive
when any accepted argument combination can overwrite an existing user file,
even when the common path creates a new file and even when same-path PDF edits
create a safety backup. “Destructive” therefore describes capability, not
intent or likelihood.

For deterministic replacement tools, idempotence is judged by the resulting
document/profile/CSV state, consistent with PUT/file-write semantics. File
mtime and operational telemetry such as `lastMutationAt` are not treated as an
additional domain effect. Tools that append marks, choose unique filenames,
replace timestamped records, change session/viewer state, or launch OS UI are
not idempotent.

## Exhaustive matrix

`R`, `D`, `I`, and `O` mean `readOnlyHint`, `destructiveHint`,
`idempotentHint`, and `openWorldHint` respectively.

| Tool | R | D | I | O | Handler evidence |
| --- | ---: | ---: | ---: | ---: | --- |
| `list_pdfs` | T | F | T | F | Reads one allowlisted directory. |
| `read_pdf_fields` | F | F | F | F | Reads a PDF but also replaces active-document state and timestamps the viewer session. |
| `fill_pdf` | F | T | T | F | Deterministically writes `output_path`; accepted same-path and existing-destination writes can replace content. |
| `bulk_fill_from_csv` | F | T | T | F | Deterministically writes derived filenames; duplicate names are rejected, and existing files are replaced only by a complete batch commit. |
| `save_profile` | F | T | T | F | Writes a deterministic JSON record and can replace an existing named profile. |
| `load_profile` | T | F | T | F | Reads one local profile. |
| `list_profiles` | T | F | T | F | Reads the local profile directory. |
| `fill_with_profile` | F | T | T | F | Deterministically writes a filled PDF and may replace an existing destination. |
| `extract_to_csv` | F | T | T | F | Deterministically writes CSV and may replace an existing destination. |
| `validate_pdf` | T | F | T | F | Reads and evaluates a local PDF without saving it. |
| `read_pdf_content` | T | F | T | F | Reads/extracts local PDF content; renderer scratch work has no retained output. |
| `read_pdf_pages` | T | F | T | F | Reads a bounded local page range. |
| `read_pdf_layout` | T | F | T | F | Reads bounded local text geometry without rendering, OCR, or retained output. |
| `convert_pdf_to_markdown` | F | T | T | F | Deterministically returns Markdown and may replace an existing local `.md` output only when `overwrite` is true. |
| `render_pdf_page` | T | F | T | F | Reads and returns an in-memory raster; it does not retain an image file. |
| `render_pdf_region` | T | F | T | F | Reads and returns an in-memory crop; it does not retain an image file. |
| `search_pdf_text` | T | F | T | F | Reads and searches local PDF text. |
| `get_pdf_resource_uri` | T | F | T | F | Validates a local file and computes a URI without registration or persistence. |
| `get_pdf_identity` | T | F | T | F | Streams a bounded local file to return canonical path, byte length, and SHA-256 without parsing. |
| `display_pdf` | F | F | F | F | Reads a PDF but also replaces/timestamps active-document state and issues a fresh viewer UUID. |
| `get_active_document` | T | F | T | F | Reads active-document state. |
| `set_active_document` | F | F | F | F | Replaces ephemeral active-document state and refreshes `lastOpenedAt`; it does not alter user files. |
| `read_pdf_bytes` | T | F | T | F | Reads a bounded chunk from one local PDF. |
| `merge_pdfs` | F | T | T | F | Deterministically writes a merged PDF and can replace an existing destination. |
| `split_pdf` | F | T | T | F | Deterministically writes derived split files; existing files are replaced only by a complete split-set commit. |
| `rotate_pdf_pages` | F | T | T | F | Deterministically writes rotated output and can replace an existing destination. |
| `reorder_pdf_pages` | F | T | T | F | Deterministically writes reordered output and can replace an existing destination. |
| `get_pdf_info` | T | F | T | F | Reads local file and PDF metadata. |
| `inspect_pdf_accessibility` | T | F | T | F | Reads eight bounded catalog-level signals from one local PDF in isolated memory and retains no output. |
| `compare_pdfs` | T | F | T | F | Reads and compares two bounded local PDFs in memory without retaining output or mutating either source. |
| `apply_page_plan` | F | T | T | F | Deterministically writes reordered/rotated/subset output and can replace an existing destination. |
| `get_page_analysis` | T | F | T | F | Reads and analyzes local PDF pages without saving mutations. |
| `create_signature` | F | T | F | F | Creates a timestamped signature record; `overwrite=true` can replace an existing signature. |
| `list_signatures` | T | F | T | F | Reads local signature records. |
| `load_signature` | T | F | T | F | Reads one local signature record. |
| `add_signature_field` | F | T | F | F | Stamps a new mark each call and can overwrite a PDF destination. |
| `apply_signature` | F | T | F | F | Appends a visible mark/audit record and can overwrite a PDF destination. |
| `prepare_signing_packet` | F | T | F | F | Adds boxes/field changes per call and can overwrite a PDF destination. |
| `apply_text` | F | T | F | F | Appends text plus a timestamped audit record and can overwrite a PDF destination. |
| `detect_signature_zones` | T | F | T | F | Reads/analyzes a local PDF without saving it. |
| `fetch_pdf_from_url` | F | T | F | T | Reads untrusted network content; default retries create unique files and `overwrite=true` can replace a local file. |
| `reveal_in_finder` | F | F | F | F | Launches/focuses local OS file-manager UI; it does not alter the selected file. |

## Regression proof

`test/mcp-contract.test.js` contains the same exhaustive 42-tool matrix and
compares all four effect hints for both runtime copies after live MCP
discovery. It also binds the complete discovery payload to an updated SHA-256,
so a title, description, schema, metadata, or annotation change requires
intentional review. Source/share byte equality remains a separate assertion in
the same suite.

This matrix deliberately makes no claim that annotations enforce policy. Path
allowlists, PDF mutation guards, signing-intent validation, backups, and host
approval remain the actual controls.

Historical verification recorded on 2026-07-21 with Node `22.22.3` for the
then-current 41-tool surface:

- focused live source/share contract: 1 file, 30 tests passed;
- full suite: 27 files, 308 tests passed;
- shuffled suite (`--sequence.seed=410`): 27 files, 308 tests passed;
- source/share runtime byte comparison: identical;
- dependency manifests and the protected `pdfjs-dist` pin: unchanged.

## Addendum: 2026-08-03 (extraction-intelligence epic, pdf-toolkit-mcp-zyx)

The epic extended the structured outputs of `read_pdf_layout`,
`convert_pdf_to_markdown`, `get_page_analysis`, and `read_pdf_content`
(ruled-rect/text-integrity/operator evidence, vision routing, compact-mode
normalizations) and added the optional `compact` input argument to
`convert_pdf_to_markdown`. All four tools remain read-only local operations;
no `readOnlyHint`, `destructiveHint`, `idempotentHint`, or `openWorldHint`
value changes. The advertised tool-contract digest changes are recorded with
dated entries in `test/mcp-contract.test.js`.

## Addendum: 2026-08-05

The current candidate adds `inspect_pdf_accessibility` as a local, bounded,
read-only operation. Its annotation tuple is `R=T, D=F, I=T, O=F` because the
handler reads one allowlisted PDF, retains no output, and has no network or
other open-world effect.

Focused integrated-candidate evidence on 2026-08-05:

- 15 Vitest files: 199 tests passed and 6 intentionally skipped;
- `test/mcp-contract.test.js`: all 43 tests passed within that run;
- live MCP discovery: 42 unique tools, including 38 structured tools;
- complete discovery SHA-256: `d9c225a5b72694d73dc0064a28fecf76a5bedf27121b04e656b86f055ced9313`;
- source/share runtime byte comparison: identical;
- dependency versions: `pdf-lib` 1.17.1 and `pdfjs-dist` 5.4.624 unchanged.
