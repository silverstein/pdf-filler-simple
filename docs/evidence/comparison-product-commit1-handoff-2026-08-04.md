# Comparison product Commit 1 handoff

## Exact lane

- Worktree: `/Users/silverbook/Sites/pdf-tools-worktrees/codex-comparison-product-observations`
- Branch: `codex/comparison-product-observations`
- Selected base: `8575246837e824239af03e63e9e2538852910403`
- Commit 1 seam: the commit containing this handoff
- `pdfjs-dist`: exact pin remains `5.4.624`

This lane did not call `bd`, touch the protected `pdf-tools` tmux windows or
their worktrees, mutate GitHub, push, merge, release, tag, sign, publish, or
send an external message.

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
  report raw pixels unavailable. Semantic digest tampering fails closed.
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

Result: 11 test files passed, 220 tests passed, 4 platform-path tests skipped.
The worker-contract run emitted expected native-binding warnings in guarded
non-rendering contexts; the directly exercised native render and digest tests
passed.

## Deliberately not run

Per the session constraint, this seam did not start `compare_pdfs` Commit 2 and
did not run the broad aggregate, deterministic package campaign, or live host
work.

## Next protected action

Preserve this worktree and independently review the exact Commit 1 SHA before
any integration or Commit 2 work. Push, merge, package qualification, release,
and external communication remain separately protected gates.
