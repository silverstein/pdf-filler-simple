# Extraction Intelligence Plan — pdf-inspector idea ports (2026-08-03)

Status: PROPOSED (pending adversarial review; beads to be created from §9)
Owner: control tower session on silvercloud; implementation lanes via codex
Sources: firecrawl/pdf-inspector @ v0.1.x (MIT), reviewed 2026-08-01..03;
recon reports over `src/detector.rs`, `src/tables/detect_rects.rs`,
`src/text_quality.rs`, `src/markdown/*`, and over this repo's
`server/layout-extraction.js`, `server/markdown-conversion.js`,
`server/helpers.js`, `server/output-schemas.js`.

## 1. What this epic is

Port four ideas from pdf-inspector into PDF Tools **without taking the
dependency** (no Rust, no lopdf, no third PDF parser — PDF.js 5.4.624 and
pdf-lib remain the only parsers):

- **W1 Routing:** first-class per-page text/raster classification with a
  `pages_needing_vision` routing surface, so a host model is told up front
  which pages to render instead of discovering raster pages by absence.
- **W2 Ruled tables:** drawing-operator rectangle evidence for the strict
  table reconstructor — ruled/bordered tables become reconstructible with
  geometry evidence while staying fail-closed.
- **W3 Text integrity:** typed detection of "text layer present but likely
  garbage" (replacement chars, private-use runs, C1 controls,
  non-alphanumeric dominance) surfaced as gaps and routing reasons, never as
  silent success.
- **W4 Compact output:** opt-in, declared, deterministic token-efficiency
  normalizations for model-context consumption (dot leaders, page-number
  lines, spaced hyphens).
- **W5 Evidence:** eval fixtures + scorer extensions so each feature lands
  with before/after evidence and the strict-vs-heuristic tradeoff is
  measured, claim-bounded per docs/EXTRACTION_EVALUATION.md.

This is a successor to bead `pdf-toolkit-mcp-jm4` (deterministic
`convert_pdf_to_markdown`, independent review APPROVE) and must not weaken
any jm4 guarantee: evidence-backed structure only, typed gaps, fail-closed
limits, no OCR, no model, no network, deterministic output, share-mirror
byte parity, versioned schemas.

**Attribution:** algorithm designs in W1–W4 derive from pdf-inspector (MIT,
Copyright Firecrawl). Any directly translated logic carries a source comment
(`// Ported from firecrawl/pdf-inspector (MIT): <file>`); this plan is the
provenance record. No pdf-inspector code ships in the MCPB; only
independently reimplemented JavaScript.

## 2. The admission filter

pdf-inspector optimizes recall with aggressive heuristics; PDF Tools
optimizes truthful determinism. Every borrow passes this filter:

1. Output structure must be **evidence-backed** (geometry, operators,
   character classes — not statistical vibes), or
2. the heuristic is **opt-in**, its application is **counted and typed in
   the structured result**, and the default behavior is unchanged; and
3. every signal is **deterministic** (pure function of source bytes +
   options) and carries typed provenance/status like the rest of the IR.

Concretely rejected by this filter (recorded as explicit non-goals in §8):
pdf-inspector's numeric confidence constants (0.5–0.95 hand-tuned values we
cannot defend with our eval), its English-letter-frequency cipher detector
(v1), font-ratio-only heading promotion, and silent always-on normalization.

## 3. W1 — Classification and routing

### 3.1 Design

pdf-inspector classifies by counting raw content-stream operators. We do not
reimplement byte-level scanning; PDF.js already gives us the same *semantic*
measurements. We port the **taxonomy, the per-page routing output, and the
decision thresholds**, adapted to measurements we already trust:

- Extend the existing per-page analysis (worker `analyzePdfPages`,
  `server/helpers.js:3947`) from boolean `.some()` operator checks to
  **counts**: `image_op_count`, `path_op_count` (same single
  `getOperatorList()` call, same op sets at `helpers.js:3989-4015`).
  `text_length` already exists per page.
- New document-level `classification` block in `get_page_analysis` output:
  - `document_kind`: `text_based | image_based | mixed | vector_heavy |
    empty | unknown` (per-page statuses roll up; `unknown` whenever any
    contributing measurement has failed status — mirrors the existing
    `blank_status` truthfulness rule at `helpers.js:3901`).
  - `pages_needing_vision[]` with per-page typed `reasons[]`:
    `no_text_layer | image_dominated | vector_only_text |
    suspected_text_integrity | analysis_unavailable`.
    Naming is deliberate: "vision", not "OCR" — we do not bundle OCR.
  - No numeric confidence. Statuses + counts + reasons only. (The IR
    already sets the precedent: `reading_order.confidence` is the literal
    string `not_calibrated`.)
- Threshold ports (adapted; defended by W5 fixtures, not by pdf-inspector's
  calibration): a page counts as text-bearing when trimmed `text_length >=
  MIN_TEXT_CHARS` (default 25) — on pages with images the bar rises
  (pdf-inspector raises min ops 3→10 on image pages; we scale the char
  minimum the same way, 25→100). `image_dominated` when `image_op_count`
  high and text chars below the raised bar. `vector_only_text` port of the
  vector-text rule: high path activity with `text_length < 30`.
  **Counting semantics caveat:** PDF.js aggregates many raw path segments
  into one `constructPath` fnArray entry, so pdf-inspector's raw-op
  thresholds (e.g. 1000 path ops) do NOT transfer to fnArray counts.
  Counts must be defined over *segments* (constructPath sub-operations)
  and *paint invocations* (image ops; PDF.js grouped/repeat image ops —
  `paintImageXObjectRepeat` etc. — count as one invocation each, and the
  counts are labeled PDF.js measurements, never raw-op ports), with our
  own numeric defaults documented as named constants in the B2 spec and
  exercised by W5 fixtures. `text_length` semantics stay exactly what the
  code measures today (UTF-16 length of concatenated PDF.js item strings,
  `helpers.js:4034`) with trimming applied at the decision point, not to
  the stored field. Misclassification bias is chosen deliberately: a
  false `pages_needing_vision` entry costs one extra render; a miss
  reproduces today's behavior. When in doubt, include the page and type
  the reason.
  **Operator-set consistency:** `helpers.js:3989-4015` and
  `layout-extraction.js:532-559` maintain near-duplicate op sets that can
  classify the same PDF differently. Rather than new shared-module
  plumbing mid-epic, B2 adds a contract test asserting the sets agree on
  the classification-relevant members (image paints; path/vector ops),
  with any intentional differences (e.g. `beginAnnotation`) explicitly
  listed in the test.
- Routing metadata embedded where the model actually is:
  - `read_pdf_content`: add `read_pages_without_text[]` computed
    explicitly per page in `readContent` (`pdfjs-worker.js:579`) from the
    same normalized-text predicate that feeds today's document-wide
    `textFound` boolean — NOT reused from preview `char_count`, which
    only exists for preview-capped pages — forwarded through the text,
    image-fallback, and failure branches alike, plus `routing_guidance`
    text when non-empty. The field is scoped to pages actually read
    (`pages_read`) — it must never imply knowledge of pages beyond
    `max_pages`. The page-1-image fallback behavior is unchanged; the new
    fields make the mixed-document boundary visible instead of silent.
  - `convert_pdf_to_markdown`: add `pages_needing_vision[]` derived from IR
    fields that already exist (`text_layer_status`, `image_detection_status`,
    `modality_hint`, plus W3 integrity signals when present).

### 3.2 Explicitly not ported

Sampling strategies (`Sample(n)`/`EarlyExit`): our tools are already
page-range-bounded (≤10 pages layout, ≤200 analysis) and local; sampling
complexity buys nothing. Template-image pixel-area analysis (`Width×Height`
via raw XObject dicts) — PDF.js op counts cover the routing need; revisit
only if W5 shows misroutes. Newspaper-override, page-count byte-scan
fallback: out of scope.

### 3.3 Touch points

`server/helpers.js` (counts + rollup + reasons), `server/index.js`
(read_pdf_content and convert_pdf_to_markdown handlers),
`server/output-schemas.js` (additive schema fields — all-required rule means
these are version-relevant), `pdfjs-worker.js` (readContent per-page
surface), share mirror, tests.

## 4. W2 — Ruled-rectangle table evidence

### 4.1 IR extension (extractor side)

New per-page IR field `ruled_rects` built inside the **existing**
`getOperatorList()` consumption (`layout-extraction.js:1637-1644`), with a
CTM-tracked walk:

- CTM machine tracks `save/restore/transform` **and Form XObject matrix
  scope**: `paintFormXObjectBegin` carries a matrix that is not an
  `OPS.transform` entry (`pdf.worker.mjs:32620`) and its nested operators
  are appended inline — the walk must push that matrix on Begin and pop on
  `paintFormXObjectEnd`, and a transformed-Form-XObject fixture pins this.
- Extract axis-aligned rectangles from `constructPath` rectangle subpaths
  and 4-segment closed subpaths (axis-aligned within eps 0.5pt, w>1 &&
  h>1 — pdf-inspector's `fill_rects` rule). Paint verb comes from
  `constructPath`'s own `paintOp` arg (`fill | stroke | none`); **clip is
  a separate operator**: PDF.js maps `W` to `OPS.clip`/`OPS.eoClip`
  (`pdf.worker.mjs:36102`) and flushes the path as
  `constructPath(endPath)` — the walk models pending-clip state and binds
  it to the adjacent flushed path, yielding verb `clip` for `re W n`
  sequences. The contract test asserts the actual fnArray/argsArray
  sequence for `re f`, `re S`, and `re W n`. Evidence hierarchy stays
  pdf-inspector's: explicit rects, else fills, else clips
  (`content_stream.rs:1255`).
- `constructPath` encoding under pinned pdfjs 5.4.624 (verified against
  the vendored build, 2026-08-03): each fnArray `OPS.constructPath` (91)
  entry's args are `[paintOp, data, minMax]` where `paintOp` is the paint
  verb itself (`OPS.fill`/`stroke`/`eoFill`/…), `data[0]` is a flat
  DrawOPS-encoded buffer (`moveTo=0, lineTo=1, curveTo=2,
  quadraticCurveTo=3, closePath=4` — a `re` op becomes
  `moveTo,x,y, lineTo,x+w,y, lineTo,x+w,y+h, lineTo,x,y+h, closePath`;
  degenerate w/h collapses to `moveTo,lineTo,closePath`:
  `pdf.worker.mjs:33186-33199`), and `minMax` is the path bbox. Path
  coordinates are **untransformed user space**; the consumer tracks the
  CTM via `OPS.transform`/`save`/`restore` entries in the same fnArray.
  Clip-path representation must be pinned by the same contract test. A
  contract test asserts this encoding against the vendored build so any
  future pdfjs upgrade fails loudly.
- Transform rect corners into the same top-left display viewport space as
  text items (viewport transform, `computeItemGeometry` precedent at
  `layout-extraction.js:218`); round 0.001 like other geometry.
- Bounded and **self-contained**: the existing page truncation block's
  invariants are text-item-based (`layout-extraction.js:947-950`) and must
  not be polluted with rect omissions. `ruled_rects` carries its own
  accounting: `{ status, items[], observed_count, returned_count }` with
  cap 512 (first-N in operator order), dedup on a 0.5pt grid (port of
  `dedup_rects`), drop w<5 || h<5 (observed_count counts post-filter,
  pre-cap candidates so truncation is provable).
- `status: available | truncated | unavailable | failed`, with an errors[]
  record using a new `stage: "ruled_rects"` — and the stage enum work
  fixes the **pre-existing** mismatch where runtime semantic validation
  accepts stage `annotations` (`layout-extraction.js:1067`) that the
  schema enum omits (`output-schemas.js:314`). Filed as its own
  discovered-from bug bead. Failure never fails the page's text
  extraction.
- **Replay:** a dedicated independent operator-evidence replay inside
  `validatePdfLayoutSourceEvidence` (`layout-extraction.js:1156`) —
  re-runs the same walk against the second parse's operator list and
  exact-compares rects, status, and counts. (The existing replay checks
  selected fields and boolean operator presence, not all derived claims —
  the spec states explicitly which fields are replay-proven vs
  semantic-only.)
- IR version 1.1.0 → 1.2.0. The "triple pin" is really an N-site
  migration: `layout-extraction.js:5`, `output-schemas.js:515` (root
  schema const), `:527` (ID scope), `:573` (markdown provenance schema),
  `markdown-conversion.js:58`, `test/pdfjs-worker-contract.test.js:154`,
  plus every test literal. B1 sweeps `rg '1\.1\.0'` across server/, test/,
  and the share mirror, updates old-version rejection tests, and records
  the full pin list in its bead notes.

### 4.2 Renderer side (markdown-conversion.js)

A second, independent table-evidence path in `segmentPageLines`
(`markdown-conversion.js:502`), tried when the existing
recurring-column analysis declines. Deliberately minimal port:

- Cluster page rects with union-find (port of `cluster_rects`: adjacency
  tolerance 3pt, min cluster size 6, cap 2000, deterministic order) after
  the preprocessing guards: oversize-width filter (w > 10× median width),
  contained-sub-rect dedup with its two documented anti-guards, page
  background exclusion (origin-anchored, h > 20× median height).
- Per cluster, port the **core grid gates of `try_build_grid`** verbatim
  where they are stricter than us and adapted where our philosophy is
  stricter:
  - edges: snap x/y edges at 6pt tolerance; require ≥3 x-edges, ≥4
    y-edges; 2 ≤ cols ≤ 25, rows ≥ 2;
  - cell fill ratio ≥ 0.30 against rect coverage;
  - assignment: item center-x / baseline-y with 2pt slack, first match
    wins (their rule) — **but** PDF Tools abandons the table (typed gap)
    if any text item inside the cluster bbox fails to assign to exactly
    one cell, or any cell would contain a line break. No dropped text,
    ever.
  - empty interior column ⇒ abandon (their rule, kept);
  - **no merged-cell propagation in v1**, with rect classification
    applied BEFORE the spanning gate (resolves the header-band/spanning
    contradiction): a rect covering the full grid width (all columns
    within 6pt) and exactly one row band is a "band rect" — decorative or
    header evidence, excluded from topology judgment; a rect spanning >1
    row, or >1 column but less than full width, is merged-cell evidence ⇒
    abandon with the existing `TABLE_TOPOLOGY_UNKNOWN` gap (merged cells
    remain an explicit jm4 non-claim);
  - header evidence: existing `hasHeaderEvidence` height rule, extended
    with one new evidence source — a first-row band rect (per the
    classification above) that does not recur on any body row within 6pt.
    Absent both ⇒ existing `header` gap reason. Emission format reuses
    `renderTable` unchanged.
- New gap code `TABLE_RULING_UNSUPPORTED` for clusters that look ruled
  but failed grid gates — the reader learns a ruled region exists that we
  declined to reconstruct. Emission guard (the anti-noise analog of the
  existing `tableLike`-gated topology reason): only when the cluster
  passed preprocessing, has ≥6 rects, ≥3 snapped x-edges AND ≥4 snapped
  y-edges (grid-shaped, not a callout box), and contains ≥2 text lines.
  Decorative single boxes emit nothing. Emit-site + schema enum +
  contract test (`test/markdown-conversion.test.js:619` pattern).
- **Existing vector-gap contract requalified for truthfulness**: today
  `VECTOR_CONTENT_NOT_INTERPRETED` is emitted unconditionally when vector
  paint ops exist (`markdown-conversion.js:627`) and the `LIMITATIONS`
  text claims ruling lines are never interpreted (`:49`). Once W2
  consumes ruling rects, both statements become partially false. The gap
  remains emitted whenever vector ops exist (absence of other vector
  content is unprovable), but its detail text and the `LIMITATIONS`
  constant change to "vector paint operations beyond any reconstructed
  table rulings are not interpreted"; page status assertions cover both a
  reconstructed-ruled page (still `partial` via this gap) and a declined
  one.
- Renderer version 1.2.0 → 1.3.0.

### 4.3 Explicitly not ported

Row-stripe tables, stacked-box tables, chart-bar rejection, prose-in-frame
function-word lists, merged-cluster and cell-rect fallbacks, hint regions,
struct-tree tables, cross-page continuation merging, text-derived column
arbitration. These exist to *expand recall of an aggressive path*; our path
only fires on clean full-grid evidence, so their false-positive surface
never opens. Each is a candidate future bead only with W5 evidence.

## 5. W3 — Text-integrity signals

### 5.1 Signals (all pure character-class functions, ported thresholds)

Per raw item at build time (`layout-extraction.js:1701`), then rolled up
per page into a `text_integrity` block:

- `replacement`: U+FFFD — run ≥2 or count ≥3 per item
  (`text_quality.rs:373`); page escalation via the ported density gates
  (chars ≤80 with run ≥2; else ≥12 chars and ≥5%; ≥3 spans and ≥2.5%;
  run ≥8 and ≥2.5% — `text_quality.rs:353-371`). Provenance is named
  honestly: signals are computed over **PDF.js-normalized item text**
  (layout extraction uses `disableNormalization: false`,
  `layout-extraction.js:1632`) but **before Markdown sanitization**
  (`sanitizeUnsafeText`, markdown-conversion.js:97, which maps control
  chars to U+FFFD and would self-trigger the signal). The IR field
  records this provenance string; no second differently-normalized text
  read is added.
- `private_use`: PUA ranges (BMP + planes 15/16) — run ≥3, or total ≥5
  with PUA ≥2 and ≥50% (`text_quality.rs:378-404`).
- `c1_controls`: per whitespace token: len ≥5, C1 ≥2, ≥5%
  (`text_quality.rs:410-422`).
- `non_alphanumeric_dominance`: port of `is_garbage_text` including its
  run-aware dot-leader exclusion (runs of `. _ ·` ≥3 excluded) and the
  ≥50-chars, <50%-alphanumeric verdict (`text_quality.rs:436-471`) —
  computed over the page's joined line text.
- Page rollup: `text_integrity_status: ok | suspect | unavailable` +
  `signals[]` (typed, with counts). Document rollup mirrors it.

### 5.2 Consumption

- W1 routing: a `suspect` page adds `suspected_text_integrity` to
  `pages_needing_vision` reasons.
- `convert_pdf_to_markdown`: new gap code `TEXT_INTEGRITY_SUSPECT` on
  affected pages (emit-site + enum + contract test). Markdown text itself
  is **not** suppressed (pdf-inspector strips items; we never silently
  drop — the gap + routing hint is the product).
- `read_pdf_content`: page-level signal in the new per-page surface (W1).

### 5.3 Deferred (backlog beads, not v1)

- Structural font forensics (Type0/Identity-H without ToUnicode, Type3-only,
  GID-named Differences): needs used-font resolution via operator list +
  pdf-lib dict walks; substantial, separately reviewable. Backlog.
- English-letter-frequency cipher detector (`CipherGarbleStats`):
  English-calibrated; false-positive risk on non-English text we cannot
  bound with current fixtures. Backlog, requires multilingual fixtures.
- `letter$letter` dollar-as-space pattern: subsumed by the above concerns.

## 6. W4 — Compact mode

`compact: false` (default) new optional argument to
`convert_pdf_to_markdown`. When true, three normalizations run as a
**post-render pass**, each deterministic, each counted in a new
`normalizations` result object (all-zero object when compact=false — keeps
the all-required schema rule satisfied):

1. `dot_leaders_collapsed`: `/\.{4,}/` → `" ... "` (exactly-3 dots
   preserved; `postprocess.rs:121` port). Applied to text lines only —
   never inside table cells or link labels/destinations.
2. `page_number_lines_removed`: port of `is_page_number_line` (≤4-digit
   line; `page N [of M]`; `N of M`; `-N-`) **plus** its isolation-context
   rule (adjacent to blank/page-boundary lines only — `postprocess.rs:159`).
   Count per page; each removal also adds the page to a
   `normalized_pages[]` list so the removal is auditable.
3. `spaced_hyphens_joined`: `letter - letter` → `letter-letter` with the
   both-sides-letter guard protecting list markers (`postprocess.rs:130`).

Full tool-contract wiring is in scope for this workstream: advertised
inputSchema property (`index.js:2678`), runtime allowedArguments set
(`index.js:4416`), handler forwarding (`index.js:4489`), tool
description, output schema, the fixed tool-contract digest test
(`test/mcp-contract.test.js:332`), and share mirror.

Renderer version bump rides with W2's (single 1.3.0 bump for the epic's
renderer changes). Normalization must run **inside the validated render
path**, not as an after-pass bolted past validation: the determinism
self-check (`validateMarkdownConversionSemantics`,
`markdown-conversion.js:744`, which re-renders every page and
byte-compares) must exercise the same compact pipeline and pass with
compact on and off. Lines produced by `renderLinkedLine` and table rows
are exempt from all three normalizations.

Deferred to backlog: repeated running-header/footer stripping (needs
cross-page normalization evidence rules), drop-cap merging (mutates reading
order text), hyphenated-linebreak word rejoining (dictionary-adjacent
judgment). Each is its own future bead with W5 fixtures first.

## 7. W5 — Evaluation evidence

Extends the existing Phase 0 synthetic corpus
(`test/fixtures/eval/extraction/`, generator
`scripts/eval-generate-extraction-fixtures.mjs`) and suite-level tests.
Claim boundary per docs/EXTRACTION_EVALUATION.md: `benchmark_claim_ready`
and `calibration_claim_ready` remain false; nothing here is a public
benchmark claim.

New fixtures (generated, deterministic, anonymized):
- `table-ruled-grid`: bordered grid the current converter abstains on and
  W2 must reconstruct; truth includes exact cells.
- `table-ruled-merged-negative`: ruled grid with a merged span; truth is
  **abstention** (`TABLE_TOPOLOGY_UNKNOWN`) — the fail-closed regression
  guard for W2.
- `text-integrity-pua`: page whose text layer is PUA/FFFD-dense; truth is
  `suspect` + routing reason, with text still emitted.
- `routing-mixed`: extends the existing mixed-modality case with routing
  truth (`pages_needing_vision` exact set) for W1.
- `compact-toc`: dot-leader TOC + isolated page numbers; truth: exact
  compact output + exact normalization counts + verbatim default output.

Scorer/test extensions assert: classification rollups, routing sets, gap
codes, normalization counts, and a **paired strict-vs-W2 table delta**
(cells recovered on `table-ruled-grid`, zero false cells on the negative).
Feature beads cite these fixtures in acceptance criteria; the epic's exit
gate includes a one-page before/after evidence summary in
`docs/evidence/`.

Deferred: opendataloader-bench local comparison run (external corpus;
license review first; unpublished reference only). Backlog bead.

## 8. Non-goals (epic-wide)

No OCR engine, ML model, network call, or third PDF parser. No numeric
confidence scores. No heading/list heuristic changes. No silent
normalization. No merged-cell reconstruction. No viewer/signature/mutation
changes. No pdfjs-dist version change (5.4.624 pinned). No release —
release remains a human gate per ORCHESTRATION.md.

## 9. Bead map

Epic bead: `pdf-toolkit-mcp-zyx` (P1, epic, discovered-from jm4, related
igr.4), created 2026-08-03. Children: B1=`zyx.1` B2=`zyx.2` B3=`zyx.3`
B4=`zyx.4` B5=`zyx.5` B6=`zyx.6` B7=`zyx.7` B8=`zyx.8`; backlog
`zyx.9`–`zyx.15` (P4). Rows below use the B-labels:

| Bead | Title | Depends on | Lane |
|---|---|---|---|
| B1 | IR v1.2.0: ruled-rect + text-integrity + op-count evidence (extractor, dedicated operator-evidence replay, full version-pin sweep, schemas, test-double extension, share mirror) | — | codex |
| B2 | Classification & routing surfaces (`get_page_analysis` rollup, `read_pdf_content` per-page fields, markdown routing metadata, operator-set consistency contract test) | B1 (consumes its measurement contract — codex review finding 13) | codex |
| B3 | Rect-grid table reconstruction + `TABLE_RULING_UNSUPPORTED` + vector-gap requalification (renderer 1.3.0) | B1 | codex |
| B4 | Text-integrity gaps + routing integration (`TEXT_INTEGRITY_SUSPECT`) | B1, B2 | codex |
| B5 | Compact mode normalizations + counts + full tool-contract wiring | B3 AND B4 (all renderer gap/result-shape changes land first — codex review finding 14) | codex |
| B6 | W5 fixtures + **baseline assertions** (fixtures assert *current* behavior — abstention/verbatim — as the frozen baseline; each feature lane flips only its own expectations as part of acceptance, producing the before/after delta). Fixtures live in their own `intelligence/` subdir with their own mini-manifest — the frozen Phase 0 manifest, category enums, and digests are untouched | — (starts first) | codex |
| B7 | Integration: share-parity re-verification, docs (CLAUDE.md boundary text, OUTPUT_SCHEMAS.md), tool-annotation audit entry, `test:all` on Silverbook, evidence ledger, milestone push | B1–B6 | control tower |
| B8 | [bug] Pre-existing: error-stage schema enum omits `annotations` accepted by runtime validation (`output-schemas.js:314` vs `layout-extraction.js:1067`) — fixed inside B1's stage-enum work, tracked separately for visibility | — (rides B1) | codex (B1 lane) |
| B9+ | Backlog: font forensics; cipher detector + multilingual fixtures; repeated header/footer strip; drop-cap merge; hyphen-linebreak rejoin; opendataloader-bench reference; template-image analysis | epic | deferred |

Share-mirror parity is a **per-lane** gate: every lane mirrors every
runtime file it changed before handoff (the contract suite fails
otherwise); B7 only re-verifies the union.

Merge order note: B1, B3, B5 all touch `markdown-conversion.js` and/or
`output-schemas.js`; B2 and B4 touch `helpers.js`/`index.js`. Lanes are
isolated worktrees; the control tower integrates in dependency order and
resolves schema-file merges centrally.

## 10. Execution contract (per ORCHESTRATION.md + arbitrage)

- Control tower = this session. Judgment (specs, diff review, integration,
  git, beads, evidence) stays here.
- Each B1–B6 lane: isolated worktree `codex-<bead>` under
  `/home/mat/Sites/pdf-tools-worktrees/` (node_modules symlinked from the
  root checkout — established pattern; no installs), Agent Mail identity +
  path reservations, `SPEC.md` in the worktree with objective, constraints,
  exact acceptance tests, and forbidden actions; dispatched via
  `codex exec --cd <worktree> "/goal ..."` in the background.
- Every lane's acceptance names its exact Vitest command(s); targeted
  suites run on silvercloud, `npm run test:all` + any packaging smoke on
  Silverbook at B7 (execution-host policy).
- Independent adversarial review before each integration (fresh-context
  review of bead + diff + evidence; codex challenge as second reviewer).
- Share-mirror parity and gap-code contract tests are hard gates on every
  lane (they fail CI otherwise).
- One milestone push (git + bd dolt) when B7's gates are green. No release.
- **jm4 sequencing risk:** jm4's sole remaining acceptance gate is a macOS
  Claude Desktop GUI proof of an exact MCPB candidate hash
  (e9d57522…). This epic changes the same converter; integrating to
  master before that proof would obsolete the candidate. The epic
  therefore integrates on its own branch and is merged to master only
  after the jm4 gate resolves (or after the maintainer explicitly accepts
  superseding the candidate hash). Notify-not-pause item per
  ORCHESTRATION.md.
