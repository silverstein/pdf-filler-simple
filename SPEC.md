# SPEC — E1: `MATH_NOT_RECONSTRUCTED` typed gap

Bead: `pdf-toolkit-mcp-0av.1` (child of epic `pdf-toolkit-mcp-0av`)
Branch: `claude/math-not-reconstructed-gap` (from `origin/master` @ dd2d922, v0.11.0)
Lane host: silvercloud VM. node_modules is a symlink — do NOT run npm/pnpm install.

## Why this lane exists (state the problem precisely — an earlier framing was wrong)

A full olmOCR-bench run (1,403 PDFs / 7,019 tests) found that **71.8% of the 3,385 math tests fail with no typed gap covering them.**

**Do NOT describe this as "we drop equations without declaring it" — that is false.** The converter already declares the limit in **prose**: a `## Conversion limitations` section ships in **95.2% of outputs (1,336/1,403)** and states that "General equations, subscripts, other fraction bars, unregistered raster variants, and other damaged mathematical glyphs remain source reading-order text rather than being guessed."

The real, narrower gap:
- the declaration is **global prose**, not a **per-page typed gap**;
- a consumer **cannot tell which pages actually lost mathematical content**;
- nothing machine-readable exists to route on (e.g. "send these pages to vision").

**E1 = make an existing prose limitation machine-readable and page-specific.** It does not change reconstruction behavior at all.

## Objective

Add a `MATH_NOT_RECONSTRUCTED` gap code and emit it **per page**, on evidence, when mathematical source content is present but is not represented as reconstructed math in the Markdown.

## Hard constraints

1. **Evidence-backed, never speculative.** Emit only on positive source evidence of mathematical content that was not reconstructed. No heuristic "this looks mathy" guess. If evidence is absent or ambiguous, emit nothing — a missing gap is better than a fabricated one.
2. **Zero behavior change to the document body.** This lane DECLARES; it does not reconstruct, remove, or reorder source content. Everything before the trailing declaration sections must be **byte-identical** to the pre-change frozen corpus. The trailing gaps section, structured `gaps[]`, page/document `conversion_status`, Markdown byte count and digest, and renderer identity are expected to change together when the new gap fires.
3. **Fail-closed discipline preserved.** Consistent with the existing gap vocabulary; typed code, page-scoped, no numeric confidence.
4. **Pinned pdfjs 5.4.624 stays pinned.** Do not touch `vendor/qpdf-wasm/runtime/`, `.beads/`, or unrelated tools.
5. **Share-mirror parity** — mirror `server/*` changes into `pdf-toolkit-mcp-share/` and pass `npm run test:contract:share`.

## Where to work

- `server/markdown-conversion.js` — `GAP_CODES` set (~line 64; currently 17 codes, alphabetically ordered — insert to preserve ordering). Gap emission happens per page alongside the existing `TABLE_TOPOLOGY_UNKNOWN` / `VECTOR_CONTENT_NOT_INTERPRETED` emissions; follow that exact pattern. The `LIMITATIONS` array (~line 84) already contains the equations prose — update it only if wording must change to reference the new typed gap (prefer minimal edits).
- `server/output-schemas.js` — the gap-code enum used by the `convert_pdf_to_markdown` output schema must include the new code, or structured results will fail validation.
- The semantic validator asserts `GAP_CODES.has(gap.code)` (~line 2954) — new code must be registered before emission.

## Evidence signals available (investigate, then choose the most defensible)

Do not invent a new parser. Candidates already in the IR / renderer:
- **Type-3 / legacy Computer-Modern glyph groups** and `glyph_recoveries` on raw items — the strongest signal for legacy math typesetting, already tracked for the registry recovery path.
- **Existing math-run detection** used by the bounded `log`-spacing repair and the stacked-fraction path (`server/markdown-conversion.js`) — it already identifies "short compact left-to-right math run" with same-baseline variable evidence.
- **Superscript/raised-run detection** — already implemented; note the existing limitation prose is explicit that a raised run does NOT distinguish an exponent from a footnote marker, so raised runs alone are **weak** evidence and probably should not trigger the gap by themselves.
- **Replacement/damaged-glyph counts** on math-class items.

Prefer a conjunction (e.g. damaged/legacy math glyph evidence, or a detected math run that was emitted as flat reading-order text) over any single weak signal. Document the chosen rule in a code comment with the reasoning.

## Acceptance tests

Add `test/math-not-reconstructed-gap.test.js`:
1. **Positive**: a fixture with clear unreconstructed mathematical content emits `MATH_NOT_RECONSTRUCTED` scoped to the right page.
2. **Negative (critical)**: a plain-prose fixture with no mathematical content emits **no** such gap. A fixture with only a raised footnote marker also emits none (raised ≠ math).
3. **Body invariance**: the lane's explicit positive, negative, and adversarial corpus is pinned to Markdown **body** bytes captured from `dd2d922`, in default and compact modes. The existing conversion suites remain the broader regression gate. Do not claim those suites are pre-change byte pins when they are not.
4. **Schema**: structured results validate; the new code is in the output-schema enum; the semantic validator accepts it.
5. **Determinism**: two runs byte-identical.

Gates (must be green, paste real output):
- `npm test -- --run test/math-not-reconstructed-gap.test.js`
- `npm test -- --run test/convert-pdf-to-markdown.test.js test/markdown-conversion.test.js`
- `npm run test:contract:share`

## Forbidden

No release/tag/push. Do not edit `.beads/`. No npm install. No reconstruction of equations (that is explicitly out of scope and a separate, much harder problem). Do not weaken any existing gap or limitation.

## Definition of done

New typed gap registered, schema-wired, emitted only on documented evidence, Markdown body provably unchanged for the frozen lane corpus, derived partial status and renderer `1.18.0` provenance bound consistently, adversarial negatives pass, share parity green. Hand back for review; a codex diff review runs before integration.

---

# SPEC — E2: evidence-bounded page-furniture removal

Bead: `pdf-toolkit-mcp-0av.2` (child of epic `pdf-toolkit-mcp-0av`)
Base: exact reviewed E1 commit `f5d60170ece21d9ab62d93f7e3458325ad533e92`

## Objective

Improve absent-header/footer benchmark behavior without guessing at document
structure or silently deleting source content. The renderer removes only
source-evidenced extreme-margin furniture by default and offers an exact
opt-out that preserves every source line.

## Evidence rule and safety boundary

A candidate must be no longer than 120 Unicode characters, wholly inside the
top or bottom 12 percent of the page, smaller than or comparable to established
body text, separated from at least two inner-body lines, and not be a detected
heading or any row in a
source-evidenced table region. It is removed only when it is either:

1. an explicit page-number or provenance pattern; or
2. normalized text repeated in the same margin band on at least two selected
   pages, with digits normalized only to admit changing page/year numbers.

A bare one-character Roman glyph is deliberately not treated as a page number.
When evidence is ambiguous, retain the source line. No numeric confidence is
created and no model or provider is called.

## Contract consequences

- Default: `remove_page_furniture: true`; exact opt-out: `false`.
- Every affected page emits `PAGE_FURNITURE_REMOVED`, so its derived conversion
  status is `partial` and the Markdown declaration, bytes, and digest change.
- `normalizations` reports page-number, running-header, running-footer, removed
  character, and affected-page counts.
- Renderer identity is `pdf-tools.layout-markdown-renderer` `1.20.0`.
- Source and share-bundle implementations remain byte-identical.

## Acceptance

Positive fixtures cover explicit and cross-page repeated furniture. Negative
fixtures cover a genuine heading, reconstructed table content, ambiguous bare
Roman text, and the exact opt-out. The real header/footer corpus must be
measured against the frozen pre-E2 baseline, with present/order controls checked
for regression. Focused conversion, schema, contract, and share-parity gates
must pass before local integration. No release, tag, push, or public benchmark
claim is authorized by this lane.
