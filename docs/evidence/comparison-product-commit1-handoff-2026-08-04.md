# Comparison product Commit 1 repair handoff

## Exact lane

- Worktree: `/Users/silverbook/Sites/pdf-tools-worktrees/codex-comparison-product-observations`
- Branch: `codex/comparison-product-observations`
- Selected base: `8575246837e824239af03e63e9e2538852910403`
- Blocked Commit 1: `5c9f2fdcec4934e6a503af9598588d26ec7b207e`
- First repair: `4bfa28a8b464b93d480de8b2ef9ec54ada21726b`
- Final Commit 1 repair seam: the commit containing this handoff, directly atop
  `4bfa28a8b464b93d480de8b2ef9ec54ada21726b`
- `pdfjs-dist`: exact pin remains `5.4.624`

This lane did not call `bd`, touch the protected `pdf-tools` tmux windows or
their worktrees, mutate GitHub, push, merge, release, tag, sign, publish, or
send an external message.

## Independent review history

Independent review returned BLOCK on the exact original Commit 1 SHA. The
review reproduced five defects: orphan widgets could starve a recognized
field, render coordinates were mislabeled as MediaBox-relative, semantic
mutations could validate, omitted metadata key names escaped the metadata cap,
and lower-level errors could expose internal strings. The earlier 220-test
handoff result did not cover those failures and is superseded by this repair
seam.

The first repair commit closed those five findings but deliberately rejected
complex geometry in the macOS system renderer. That was safe but not a usable
embedded-host result. The final Commit 1 repair replaces that rejection with a
coordinate-correct Quick Look path and keeps the earlier five repairs intact.

## Repair scope

- Counts every encountered Widget, prioritizes recognized fields over orphan
  retention, emits unmatched widgets as bounded form-channel records, and
  reports field, widget, page, and global-output omissions separately.
- Separates raw bottom-left PDF MediaBox/CropBox geometry from the rotated,
  UserUnit-scaled top-left PDF.js page view. Region requests now truthfully use
  PDF.js viewport points and are explicitly incompatible with signing zones.
- Replaces direct PDF rendering through `sips`, which ignores page rotation,
  with bounded macOS Quick Look rendering. Whole pages and regions now preserve
  the PDF.js CropBox view across nonzero origins, rotation, and UserUnit.
- Derives channel coverage and truncation semantics, cross-checks all retained
  counts and cap reasons, validates the source path/name/size envelope, and
  binds the full final document envelope with a SHA-256 digest.
- Charges values, escaped key names, hashed omitted-key reporting, disagreement
  reporting, counts, and flags against the complete metadata envelope cap.
- Maps password, policy, changed-source, filesystem, resource, and parser
  failures to stable public messages that do not include lower-level paths,
  passwords, or parser text.

## Implemented scope

- Upgraded `get_pdf_info` to return bounded, structured, source-bound page,
  metadata, form-widget, and ordinary-annotation observations.
- Preserved Info and XMP separately and reports disagreements without choosing
  a metadata winner.
- Kept widgets under form fields and ordinary annotations separate. Annotation
  URLs, destinations, and actions are inert returned values only.
- Added explicit per-channel `supported`, `partial`, and `unavailable`
  coverage, typed reasons, and whole-record serialized-output truncation.
- Added source identity, page geometry, coordinate spaces, renderer policy,
  PNG SHA-256, and raw-pixel evidence status to page and region renders.
- Added stable source-bound observation IDs and semantic validation that fails
  closed on count, cap, source-binding, or digest inconsistency.
- Added the new runtime module to both package inventories and mirrored all
  affected runtime files byte-for-byte into `pdf-toolkit-mcp-share/server/`.

## Adversarial inspection

- Caps: pages 200, form fields 500, ordinary annotations 500, metadata 32,768
  characters, and structured output 20,000 to 200,000 characters. Output
  reduction removes complete records and marks the affected channel partial.
- Coverage: complete channel failure remains `unavailable`; a cap, page scope,
  parser gap, fallback geometry, or output omission is `partial` with a typed
  reason. Page-scope omission is not mislabeled as collection-cap exhaustion.
- Privacy: missing and incorrect encrypted-PDF passwords return typed errors
  without password or document observations. Disallowed paths fail before a
  source observation is returned.
- Immutability: observation reads use the existing race-aware source binding;
  the isolated worker reopens and revalidates canonical path, byte length,
  file identity, and SHA-256. The fixture byte content and modification time
  remain unchanged across repeated calls.
- Render truth: the PNG digest is calculated from the exact returned bytes.
  Native renders digest exact RGBA bytes before PNG encoding. System renders
  report raw pixels unavailable and use the same PDF.js view for whole pages
  and regions. Semantic digest tampering fails closed.
- Annotation safety: widgets never appear in ordinary annotations, and no
  annotation target is opened or fetched.
- Unknown input: `get_pdf_info` rejects additional properties in discovery and
  again at the handler boundary.
- Parity: `index.js`, `output-schemas.js`, `pdf-observations.js`,
  `pdfjs-subprocess.js`, and `pdfjs-worker.js` are byte-identical across source
  and share runtime trees.

## Narrow verification bank

Command:

```text
npx vitest run test/pdf-observations.test.js test/get-pdf-info.test.js test/output-schema.test.js test/render-pdf-page.test.js test/pdfjs-worker-contract.test.js test/pdfjs-subprocess-boundary.test.js test/read-bounded-pdf-file.test.js test/mcp-contract.test.js test/documentation-claims.test.js test/agent-host-workflow-contract.test.js test/eval/extraction-phase1-packaging.test.js
```

The first repair result was 11 test files passed, 228 tests passed, and 4
platform-path tests skipped. A follow-up review found that failing closed left
embedded macOS hosts unable to render ordinary complex page geometry. The
Quick Look correction directly tests whole-page and top-left-region rendering
for rotations 0, 90, 180, and 270 with a nonzero MediaBox/CropBox origin and
UserUnit 2. Final focused result: 11 test files passed, 232 tests passed, and 4
platform-path tests skipped. The discovery contract SHA-256 is
`c8c1875eb1a78191e6846308c9184a1cc749b568dae890d0690f03ca203756e1`.
The adjacent current trajectory-contract regeneration also passed: the full
12-file bank recorded 235 passed and 35 intentional skips. The regenerated
current v3 input-schema projection is
`842c391689e9056c95ff999896f625e0f1c9d28e394a9fb2060af80f75ac379b`;
the frozen v1 and v2 contracts were not changed.

## Deliberately not run

Per the session constraint, this seam did not start `compare_pdfs` Commit 2 and
did not run the broad aggregate, deterministic package campaign, or live host
work.

## Next protected action

Preserve this worktree for exact-SHA review. Commit 2 may proceed only from this
clean seam. Package qualification, release, and external communication remain
separate gates.
