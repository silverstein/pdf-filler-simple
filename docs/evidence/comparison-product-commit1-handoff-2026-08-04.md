# Comparison product Commit 1 repair handoff

## Exact lane

- Worktree: `/Users/silverbook/Sites/pdf-tools-worktrees/codex-comparison-product-observations`
- Branch: `codex/comparison-product-observations`
- Selected base: `8575246837e824239af03e63e9e2538852910403`
- Blocked Commit 1: `5c9f2fdcec4934e6a503af9598588d26ec7b207e`
- Repair seam: the commit containing this handoff, directly atop the blocked commit
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

## Repair scope

- Counts every encountered Widget, prioritizes recognized fields over orphan
  retention, emits unmatched widgets as bounded form-channel records, and
  reports field, widget, page, and global-output omissions separately.
- Separates raw bottom-left PDF MediaBox/CropBox geometry from the rotated,
  UserUnit-scaled top-left PDF.js page view. Region requests now truthfully use
  PDF.js viewport points and are explicitly incompatible with signing zones.
- Makes the macOS `sips` path fail closed on nonzero origins, a distinct
  CropBox, rotation, or UserUnit instead of returning a falsely aligned image.
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
  report raw pixels unavailable and reject page views they cannot align.
  Semantic digest tampering fails closed.
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

Repair result: 11 test files passed, 228 tests passed, 4 platform-path tests
skipped. The worker-contract run emitted expected native-binding warnings in
guarded non-rendering contexts; the directly exercised native and supported
system render tests passed. Complex system geometry was verified fail-closed.

## Deliberately not run

Per the session constraint, this seam did not start `compare_pdfs` Commit 2 and
did not run the broad aggregate, deterministic package campaign, or live host
work.

## Next protected action

Preserve this worktree and independently review the exact repair SHA before any
integration or Commit 2 work. Push, merge, package qualification, release, and
external communication remain separately protected gates.
