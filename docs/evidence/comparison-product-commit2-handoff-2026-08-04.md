# Comparison product Commit 2 handoff — 2026-08-04

## Review target

- Worktree: `/Users/silverbook/Sites/pdf-tools-worktrees/codex-comparison-product-observations`
- Branch: `codex/comparison-product-observations`
- Parent: `c8fa7462f8664b3709aaaae23fc78d3de9ae21dc`
- Selected program base: `8575246837e824239af03e63e9e2538852910403`
- Implementation candidate: `96d314b01a1fecfa54811bc0255faa83e73edbf7`
- Implementation tree: `752de29ca602222b52efdc16acc899a4eeaafb8d`
- Evidence head: the clean docs-only commit containing this updated handoff;
  use its exact SHA reported by the operator rather than a branch name.
- Protected dependency: `pdfjs-dist` remains exactly `5.4.624`; no dependency
  was added or changed.

This lane is collision-free with the Shannon work. It does not modify Shannon
layout/Markdown implementation or its evidence. Shannon PR 62 remains a
separate bounded glyph-recovery tranche and is not comparison-product proof.

## Implemented boundary

`compare_pdfs` is a deterministic, local, read-only whole-document tool for two
PDFs of at most 20 pages each. It refuses prefixes and binds both canonical
paths, file names, sizes, SHA-256 values, parser identity, observation digests,
page counts, and pre/post immutability checks. It returns:

- complete one-to-one page coverage with exact, unique-text, weighted,
  ambiguous, inserted, and deleted relations;
- semantic, text, structure, form-field, ordinary-annotation, metadata, and
native-visual coverage as separate typed channels;
- source/page/geometry/value/raw-result-bound evidence for both versions;
- truthful PDF.js display coordinates even when source content is clipped or
  lies partly outside the CropBox, without rewriting them as in-page points;
- independently typed form properties, including widget page and geometry;
- inert ordinary annotations, with Widget annotations retained in the form
  channel;
- Info/XMP metadata disagreements without choosing a winner;
- native scale-1.5 raw-RGBA visual deltas using threshold 8, one-pixel mask
  dilation, 8-connected components, and minimum area 4, with no resizing;
- reversible `default_material` suppressions and a `forensic` report mode.

No successful output asserts document equivalence. Native render
unavailability is partial coverage and never silently substitutes the system
renderer. Unknown arguments, oversized documents, changed sources, password
failures, parser/filesystem failures, output-cap refusal, and internal semantic
failures are stable typed public errors with path and password text scrubbed.

## Adversarial review performed

Focused regressions cover page-cap refusal and 11-page chunk completion;
repeated-page ambiguity; inserted/deleted pages; CropBox origins, rotation, and
UserUnit; field type/options/flags/page/widget geometry; Widget/annotation
separation; metadata suppression and forensic reversibility; native-region
truth; output-cap refusal; unknown-input rejection; source immutability; stable
password/path/parser errors; and fail-closed mutations of status, coverage,
reason codes, limitations, source envelope, observation digest, page count,
alignment coverage, summary counts, evidence source/page/regions, facets,
resource effects, and the full comparison digest.

Source/share runtime parity and package inventories are enforced tests, not
assumptions. The inherited Phase 1 source graph, schemas, suite classifier, and
layout oracle include both `pdf-observations.js` and `pdf-comparison.js` so the
new runtime modules cannot evade provenance checks.

## Evaluation status and claim boundary

The product adapter invokes `compare_pdfs` once per pair for six deterministic
iterations and validates source binding, alignment, channel coverage, typed
events, values, and evidence regions before adapting to the frozen v1 scorer.
Its generated records are `oracle_calibration`, not measured benchmark proof.

Silverbook development scoring is diagnostic only: semantic, text, structure,
form-field, annotation, and metadata channel F1 values were each 1.0, while
Darwin-arm64 raster hashes did not match the frozen Linux-x64 renderer truth;
visual F1 was 0 and 3 of 7 product pairs passed. The frozen scorer admits Linux
x64, Node 22.22.3, `pdfjs-dist` 5.4.624.

The exact frozen-host run then completed in a disposable Linux/amd64 container
on Silverbook, bound to implementation SHA
`96d314b01a1fecfa54811bc0255faa83e73edbf7` and renderer fingerprint
`c2dd1a1d44aac6b47b58a18b9b578e2e863bb0b75cfd8dbf95346e841b4eace8`.
Across six deterministic iterations per pair, the product passed all 7 of 7
pairs with 9 true-positive events, no false positives or false negatives,
event F1 1.0, every channel F1 1.0, material recall 1.0, 27 of 27 evidence
anchors, 13 of 13 two-sided facets, and no unsupported facets, references, or
orphan observations. The validated score remains globally `passed: false`
because OS network isolation and signed result attestation were intentionally
absent; `benchmark_claim_ready` remains false.

Exact generated artifact bindings:

- product report: `542187e110b35daa1a23e28b6348ae8941bc466a71643c6ac3c372b7ed32ce7e`
- product score: `6d9e9a8c10ef4fe2ee90ddebedcdc926210d6287393af930b13f7c73e310fc22`
- product observation registry: `bf959b5075dec1393fdbfe9a0a520939e86d5d40b2fef94c5c55f605ec887571`
- run index: `70ed6d8526953cb2d137b4bcaf64b8affb9d63273064dbe865a241fc8525f1dd`

The generated raw artifacts remain in the preserved disposable review clone at
`/tmp/pdf-comparison-linux.8upyBV/repo/.comparison-output-96d314b/` on
Silverbook.

## Verification evidence

- Focused final source/share, schema, comparator, and inherited-provenance bank:
  6 files, 89 tests passed.
- Direct comparator bank: 11 tests passed, including the exact clipped/off-page
  packaged-smoke regression and 23 fail-closed envelope mutations.
- Full aggregate at the implementation SHA: 124 Vitest files, 1,939 tests
  passed, 81 skipped; native partition 62 passed, 9 intentional platform skips,
  zero failures.
- All five affected source/share runtime modules are byte-identical;
  `pdf-comparison.js` SHA-256 is
  `72d4911773bce66ce8a9f698cf3cfc3b2e53e80e9dbc185e7cb0642e37941b4d`.
- Fresh exact-SHA package clone: two clean isolated builds were byte-identical,
  3,001 files, 73,659,266 bytes, MCPB SHA-256
  `5aadadc37c9854debdefbdef4e97ece700fc1cf90a2f74978dec1aafd5f5d3dd`.
- Extracted artifact smoke passed on Darwin/arm64 with 41 tools, 14 prompts,
  native raster execution, and a successful source-bound packaged
  `compare_pdfs` invocation.

## Closed gates and residual work

No push, merge, release, tag, signature, publication, production mutation,
Lumin-provider transport, private sponsor data, or Kepano communication was
performed. Installed-host exercises, Stonebook x64 evidence, Claude-chat UI
invocation, OS-denied benchmark isolation, signed result attestation, and broad
benchmark/release claims remain separate gates. Any future integration must
consume an exact reviewed SHA and preserve the Shannon/comparison ownership
boundary.
