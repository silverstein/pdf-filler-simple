# MCP discovery contract

PDF Tools targets MCP `2025-11-25` through the stable TypeScript SDK 1.x and
MCPB manifest format `0.3`. The server intentionally exposes the same protocol
surfaces from the source checkout, the packed MCPB, and the share package.

Primary references:

- [MCP lifecycle and capability negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCPB manifest 0.3](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)

## Advertised surfaces

| Surface | Initialize capability | Discovery and use | Static declaration |
| --- | --- | --- | --- |
| Tools | `tools: {}` | `tools/list`, `tools/call` | `manifest.json` and `manifest.mcpb.json` |
| Prompts | `prompts: {}` | `prompts/list`, `prompts/get` | Identical 14-prompt arrays in both manifests |
| Resources | `resources: {}` | `resources/list`, `resources/read` | Runtime only; MCPB 0.3 does not declare resources |

The capability objects do not claim list-change notifications or resource
subscriptions because PDF Tools does not emit or implement them. Resource
template discovery is also unsupported and deterministically returns JSON-RPC
`-32601` (`Method not found`).

### Tools

The runtime returns 37 uniquely named tools. Every tool has an object input
schema plus `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`openWorldHint` annotations. Annotations are user-interface hints, never an
authorization boundary; path allowlists and signature-intent checks remain the
enforced controls. The contract test enforces the exact four-hint policy for
every tool in both runtime copies. The handler evidence and classification
rules are recorded in
[`TOOL_ANNOTATION_AUDIT_2026-07-21.md`](TOOL_ANNOTATION_AUDIT_2026-07-21.md).

The source manifest lists all 38 tools. The packed MCPB manifest lists the 37
normal model-workflow tools and omits `read_pdf_bytes`, whose runtime metadata
marks it `ui.visibility: ["app"]`. `tools_generated: true` explicitly tells MCPB
hosts that runtime discovery includes an additional tool. That visibility hint
is advisory and depends on an MCP Apps-aware host filtering its model catalog;
a generic MCP client can still discover and call `read_pdf_bytes`. It is not an
authorization or confidentiality boundary. Filesystem allowlists and the tool's
bounded reads remain the enforced controls.

Thirty-two tool handlers advertise strict `outputSchema` contracts and return
`structuredContent`. They also return a human-readable `content` text block so
non-Apps and older clients remain usable. Successful structured output is
validated before it leaves the server, with separate generic and tool-specific
error branches where required.

#### Extraction and page-analysis truthfulness

`read_pdf_layout` returns the versioned PDF Tools Extraction IR for at most 10
pages per call. It binds each ID scope to the source SHA-256, pinned PDF.js
parser, IR version, page range, and retention options. When pdf-lib can parse
the same authenticated bytes, it preserves raw MediaBox, CropBox, and PDF
rotation; otherwise those enrichment fields are null and an explicit geometry
error is returned while PDF.js remains the display-geometry authority. Raw
MediaBox and CropBox values remain in PDF default user space before UserUnit
and page rotation. `pdfjs_view` is recorded separately in that raw coordinate
space, and UserUnit comes from PDF.js. Item quads and boxes
use a separate top-left space in physical 1/72-inch points after UserUnit and
rotation in the PDF.js display viewport. Text-run quads use a deterministic
PDF.js TextItem/style-metric approximation: the baseline is shifted by the
recorded ascent ratio, the advance axis uses item width (or item height for
vertical text) times the effective viewport scale, and the cross axis uses
transformed font height. The IR records the advance and ascent provenance.
These boxes are neither browser DOM TextLayer boxes nor glyph ink bounds. Quad
points are ordered anchor-top, terminal-top, anchor-bottom, terminal-bottom;
they are not polygon winding order. `line_height` is the modeled TextLayer
font-height vector, not a font-size or ink-height measurement.
Stable item, line, and nonsemantic flow-block references support conservative
reading order without claiming paragraphs or document structure. Raster-only,
mixed, hidden, clipped, duplicate, and OCR-overlay gaps remain explicit. The
tool does not render, OCR, infer tables, or claim arbitrary schema extraction,
and every item, character, or output limit is fail-closed with truncation
metadata. Its coordinates must not be passed to `render_pdf_region` or signing
tools.

`read_pdf_content` exposes `extraction_status` as `complete`, `partial`, or
`failed`. A text result is partial when it is page-limited or response-
truncated. A successful first-page image fallback is also partial because it
does not establish the contents of every page. If text extraction finds no
content and image fallback fails, the tool returns `isError: true` while
preserving safe document metadata and page-preview measurements in
`structuredContent`. That result uses `extraction_mode: "none"`,
`content_available: false`, stable public `error_codes`, and retry guidance;
it must never be interpreted as proof that the PDF is empty. Internal renderer
error text is logged to stderr rather than exposed in the structured contract.

`get_page_analysis` reports geometry from `pdf-lib` separately from content
measurements obtained through PDF.js. Every page has explicit text/image/vector-graphics
measurement status, provenance, and `blank_status` (`likely_blank`,
`not_blank`, or `unknown`). A page is `likely_blank` only when text and
operator-list measurements completed successfully and found no text, image, or
painted vector graphics. Positive partial
evidence can still establish `not_blank`; missing or failed evidence produces
`unknown`, with `null` rather than fabricated zero/false values. Whole-document,
per-page, and 200-page-cap gaps are therefore never deletion or reorder advice.
When any pages are unknown, the response tells agents to retry and then inspect
those pages with `render_pdf_page` before a page mutation. Even a
`likely_blank` result is a conservative heuristic rather than deletion
authorization; `mutation_guidance` requires visual inspection of every
candidate before deletion or reordering.

### Prompts

The 14 manifest prompt templates are first-class MCP prompts. Runtime
discovery preserves manifest order, names, descriptions, and argument names.
Every declared argument is required because every one is interpolated into its
template. `prompts/get` returns one user message. User-provided values are
bounded to 1,024 characters, reject C0/C1 and common invisible/bidirectional
format characters, and are serialized in an explicit JSON data block. The task section refers to
argument names instead of splicing values into operative instructions. The
boundary tells the consuming model never to follow commands embedded in the
data. This reduces prompt-injection ambiguity but does not make arbitrary
untrusted input safe by itself; clients should keep prompt invocation
user-controlled and avoid sourcing arguments from untrusted documents without
their own review.

Missing arguments, unknown arguments, and unknown prompt names return JSON-RPC
`-32602` (`Invalid params`). Adding or removing a prompt requires updating both
manifests and both committed runtime copies; the contract test detects drift.

### Resources

`resources/list` returns the MCP Apps viewer at
`ui://pdf-toolkit/viewer`. `resources/read` returns its single-file HTML with
the `text/html;profile=mcp-app` media type.

PDF file resources are dynamic and therefore are not included in
`resources/list`. `get_pdf_resource_uri` applies the filesystem allowlist, then
encodes the absolute platform path as one percent-encoded segment under the
canonical `pdf://local/` authority. The symmetric decoder handles POSIX,
Windows-drive, UNC, Unicode, and RFC 3986 reserved characters without allowing
URI query/fragment ambiguity. `resources/read` re-applies the allowlist before
returning the PDF as an `application/pdf` blob. Schema-valid string URIs that
do not match a supported resource form return `-32602`; missing or
expected-permission-unavailable resources return `-32002`. Inputs rejected by
the SDK before the handler runs can use the SDK's own protocol-error mapping.
Genuine filesystem/runtime faults remain `-32603` instead of being mislabeled
as a missing resource.

The finite tools, prompts, and resource lists do not issue pagination cursors.
Supplying a schema-valid string cursor therefore returns `-32602` instead of
silently restarting at the first page. Inputs rejected by the SDK schema before
the handler runs can use the SDK's own protocol-error mapping.

## Verification

Run the deterministic source and staged-share-files contract suite:

```bash
npm test -- --run test/mcp-contract.test.js
```

The suite verifies initialization, tool declarations and annotations, explicit
generic-client behavior for the app-intended byte tool, prompt
listing/rendering/injection boundaries/error behavior, cursor rejection,
static and reserved-character dynamic resource reads, representative structured
content with a text fallback, and unsupported resource-template discovery. It
also requires all committed share runtime modules and the single-file viewer to
be byte-identical to their source counterparts. The regular suite stages share
files under a temporary root with an explicit dependency fixture; it catches
missing package files and source/share drift, but is not the clean-install proof.

Prove that the share manifest resolves and installs without any parent checkout:

```bash
npm run test:contract:share
```

This gate runs the real share packager, extracts its ZIP into a clean temporary
root, generates a dependency lock from only that archive, recreates it with
`npm ci --omit=dev`, and exercises discovery, app-tool compatibility, cursor
errors, and a dynamic PDF resource round trip.

For an exact release candidate, also verify the packed projection:

```bash
npm run build:mcpb
npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb
```

The packed smoke runs the extracted archive itself and covers discovery,
prompt argument boundaries, cursor errors, both resource kinds, generic-client
app-tool behavior, tool error signaling, and native rasterization.

Finally install that exact artifact in the current Claude Desktop host and use
a fresh synthetic chat to confirm prompt visibility, one prompt invocation, one
normal tool call, and viewer rendering. The local stdio contract suite proves
protocol behavior, not host-specific catalog presentation.
