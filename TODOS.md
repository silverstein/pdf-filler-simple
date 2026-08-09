# TODOS

## P1 — Ship Next

### v0.8.0: Close-the-loop release (IMPLEMENTED — needs PR + release)
Bundles URL fetch + signature tooling into one "agent can now download, fill, and sign" release.

**New tools (6):**
1. `fetch_pdf_from_url` — download a PDF from an HTTP(S) URL to `~/.pdf-toolkit-files/inbox/` (closes the Lumin gap — MCP server has full network where Claude's WebFetch doesn't)
2. `create_signature` — save a reusable typed or image signature
3. `list_signatures` — enumerate saved signatures
4. `add_signature_field` — draw a visible "Sign here" placeholder box on a page
5. `apply_signature` — stamp a saved signature at a location (requires explicit human intent — see Signature Architecture in CLAUDE.md)
6. `prepare_signing_packet` — fill form fields + add sign-here boxes in one pass

**Status:** Code + 53 new tests (103/103 passing). Smoke-tested end-to-end via MCP stdio round-trip: Sandy Springs GA business license downloaded (727 KB, previously blocked by Claude sandbox), IRS W-9 downloaded and signed with audit trail in Keywords metadata.

**Still to do:** Pack `mcpb pack`, test interactive paths in Claude Desktop, update README, open PR, cut release.

**Depends on:** Nothing.

**Design:** `project_signature_strategy.md` + `project_signature_intent_constraint.md` in memory.

### v0.8.1: Viewer-gated signature UX
- "Sign here" button overlay in display_pdf at each add_signature_field location
- Click dispatches apply_signature with viewer-origin intent token (better than CLI intent string for UX)
- Drawn-in-viewer signature capture (canvas stroke → PNG data URL → create_signature)
- Depends on v0.9.0 landing

### v0.9.0: Lumin API handoff (Tier 2)
- `request_lumin_signature` tool that routes prepared packets to Lumin's API for cryptographic/compliance-grade signing
- Requires `LUMIN_API_KEY` env var
- Needs API spec from Max

### Extraction pre-flight: make the routing signal a first-class cheap call

The server already computes whether a page needs vision — `read_pages_without_text`
from `read_pdf_content`, the `classification` rollup and typed
`pages_needing_vision` reasons from `get_page_analysis`. Today those only come
back as a byproduct of an operation the caller has already paid for. An agent
deciding *whether to spend* on a 300-page scan has to do the expensive read first
to learn it was the wrong move.

Expose the same determination as a bounded, cheap call: text-layer inspection
only, no rasterization, no OCR, no full extraction. It answers one question —
which pages carry a usable text layer, which need vision, and which could not be
assessed — using the typed reasons and explicit `pages_not_analyzed` scope that
already exist, so it adds a route rather than a new claim.

Value is highest exactly where cost is highest: large scanned documents, mixed
text/raster files, and any agent loop choosing between a local read and a
vision-capable model. It also gives `convert_pdf_to_markdown` and the comparison
lane a way to refuse early with a reason instead of producing thin output.

Constraints: it must not rasterize, must reuse the existing routing vocabulary
rather than inventing a second one, and must never report confidence numbers —
statuses and typed reasons only, consistent with the current extraction boundary.

### Optional OCR through a caller-supplied endpoint, still bundling none

OCR has sat in this list as planned-but-unshipped for a while, and the reason is
sound: bundling an engine would add a large native dependency to an artifact that
already carries five platform binaries, and it would weaken the local-only story
that is a real differentiator.

There is a middle path. Accept an optional, explicitly configured OCR endpoint —
absent by default, never bundled, never contacted unless a user configures it —
and merge its output with the native text layer rather than replacing it. The
default install keeps today's behaviour and today's honest boundary: no OCR, and
raster pages reported as unrecognized rather than silently empty.

This turns "no OCR" from a dead end into a documented extension point without
changing what ships. It pairs naturally with the pre-flight above: the pre-flight
says which pages need vision, and the endpoint, when configured, is one way to
serve them.

Constraints: no engine in the artifact; no network call without explicit
configuration; the boundary language must continue to state plainly that the
local runtime performs no text recognition; and OCR-derived text must be
distinguishable in output from native text-layer extraction, since the two do not
carry the same evidence.

### 10/10 vision follow-ups (post-v0.8.x)
- `analyze_form_gaps` — per-field semantic classification + suggested search queries ("who handles waste for {address}" → route to Gmail/Drive/Stripe MCPs)
- Three-state field sidebar in `display_pdf`: filled / missing-known / missing-unknown with inline search-query dispatch
- Autoresearch-style evals for form-fill accuracy and signature placement (see `reference_autoresearch_eval_pattern.md`)

### v0.7.0: Visual Page Manager + AI Cleanup
- **What:** "Manage Pages" mode in display_pdf viewer — thumbnail grid with drag-to-reorder, rotate, delete. Two new tools: `apply_page_plan` and `get_page_analysis`. Chat-only AI suggestions (no visual overlay).
- **Design:** APPROVED — `~/.gstack/projects/Open-Document-Alliance-PDF-Tools/silverbook-master-design-20260325-174508.md`
- **Eng review:** CLEARED — 6 issues resolved, 3 critical gaps to address during implementation (disk write errors, corrupt page handling, thumbnail memory guard)
- **Prerequisites:** (1) Test HTML5 DnD in MCP App sandbox, (2) Benchmark thumbnail rendering
- **Effort:** M-L (CC: ~1.5 hours)
- **Depends on:** Prerequisites passing

### v0.7.0: Set up vitest test infrastructure
- **What:** vitest config + test fixtures + tests for 2 new tools + smoke tests for 5 existing tools
- **Why:** Zero test coverage across 21 tools shipping to 369K users
- **Effort:** S (CC: ~25min)
- **Depends on:** Nothing

### v0.7.1: Modular refactor of server/index.js
- **What:** Extract tool handlers from ~2,000-line switch statement into separate modules
- **Why:** Eng review decision — ship v0.7.0 into monolith, refactor immediately after
- **Effort:** M (CC: ~20min)
- **Depends on:** v0.7.0 shipped + test suite in place

### parseCSV bug fix
- **What:** parseCSV helper (server/index.js:222) doesn't handle quoted commas in CSV values
- **Why:** Users with commas in their form data (addresses, company names) get corrupted bulk fills
- **Effort:** S (human) → S (CC)
- **Depends on:** Nothing
- **Context:** Known issue, called out in v0.5.0 plan as "separate PR." The function uses naive `.split(',')` instead of proper CSV parsing.

## P2 — After v0.7.0

### PDF compression tool
- **What:** compress_pdf tool that meaningfully reduces file size for image-heavy PDFs
- **Why:** One of the top 3 most common PDF operations. Currently impossible with pdf-lib alone.
- **Pros:** Completes the manipulation toolkit, eliminates another iLovePDF use case
- **Cons:** Requires native dependency (Ghostscript/qpdf) which complicates cross-platform installation
- **Effort:** M (human) → S (CC) for implementation, L for dependency management
- **Depends on:** Benchmarking pdf-lib vs Ghostscript on 20 real PDFs
- **Context:** Codex challenged premise #3 in office-hours (2026-03-24). pdf-lib can strip metadata but can't downsample images. Need benchmarks before committing.

### AI-powered smart operations
- **What:** Intelligence layer on top of manipulation tools: "split by chapter," "merge chronologically," "rotate landscape pages to portrait"
- **Why:** This is the moat — nobody else combines local PDF manipulation with AI understanding
- **Pros:** Deep differentiation, leverages Claude's unique capability
- **Cons:** Requires reliable document understanding (table of contents detection, date extraction)
- **Effort:** M (human) → S-M (CC)
- **Depends on:** v0.6.0 tools + get_pdf_info proving the concept
- **Context:** The "v0.7.0 vision" from office-hours. Ship dumb operations first, layer intelligence after.

## P3 — Tech Debt

### ~~Modular refactor~~ — promoted to P1 (v0.7.1)

### ~~Automated test suite~~ — promoted to P1 (v0.7.0)

### Cursor share bundle sync
- **What:** Update pdf-toolkit-mcp-share/ to mirror current server/index.js capabilities
- **Why:** Share bundle is stale — doesn't include display_pdf, viewer, or v0.6.0 tools
- **Effort:** S
- **Depends on:** v0.6.0 shipped
