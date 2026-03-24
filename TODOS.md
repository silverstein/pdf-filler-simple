# TODOS

## P1 — Ship Next

### parseCSV bug fix
- **What:** parseCSV helper (server/index.js:222) doesn't handle quoted commas in CSV values
- **Why:** Users with commas in their form data (addresses, company names) get corrupted bulk fills
- **Effort:** S (human) → S (CC)
- **Depends on:** Nothing
- **Context:** Known issue, called out in v0.5.0 plan as "separate PR." The function uses naive `.split(',')` instead of proper CSV parsing.

## P2 — After v0.6.0

### Visual page manager MCP App
- **What:** Thumbnail strip view showing all pages. Drag-to-reorder, visual split point selection, merge preview.
- **Why:** Transforms manipulation from "type page numbers" to "see and drag." Matches SmallPDF's UX inside Claude.
- **Pros:** Killer feature, strong differentiation, natural extension of existing viewer
- **Cons:** ~2 hours CC effort, new interaction patterns, heavier bundle
- **Effort:** L (human) → M (CC)
- **Depends on:** v0.6.0 manipulation tools proving usage frequency
- **Context:** Deferred from v0.6.0 CEO review (2026-03-24). Build only if merge/split/rotate/reorder get used.

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

### Modular refactor of server/index.js
- **What:** Break 1,427-line single file into modules (tools/merge.js, tools/split.js, etc.)
- **Why:** Single file is increasingly hard to navigate. Blocks automated testing. Makes contributing harder.
- **Pros:** Foundation for tests, cleaner for contributors, each tool independently testable
- **Cons:** Larger diff, regression risk on working code shipping to 369K users
- **Effort:** M (human) → S (CC)
- **Depends on:** v0.6.0 shipped (don't refactor AND add features in same release)
- **Context:** Acknowledged in both v0.5.0 and v0.6.0 plans. Do after v0.6.0 adds ~300 more lines.

### Automated test suite
- **What:** Unit and integration tests for all tools
- **Why:** Manual testing doesn't scale. Each new tool makes the manual checklist longer.
- **Pros:** Confidence in releases, faster iteration, contributor-friendly
- **Cons:** Initial setup effort, need test fixtures
- **Effort:** M (human) → S (CC)
- **Depends on:** Modular refactor (easier to test modules than a 1,700-line switch statement)

### Cursor share bundle sync
- **What:** Update pdf-toolkit-mcp-share/ to mirror current server/index.js capabilities
- **Why:** Share bundle is stale — doesn't include display_pdf, viewer, or v0.6.0 tools
- **Effort:** S
- **Depends on:** v0.6.0 shipped
