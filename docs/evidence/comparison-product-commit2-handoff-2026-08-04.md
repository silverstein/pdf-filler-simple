# Comparison product Commit 2 handoff — 2026-08-04

## Review target

- Worktree: `/Users/silverbook/Sites/pdf-tools-worktrees/codex-comparison-product-observations`
- Branch: `codex/comparison-product-observations`
- Parent: `c8fa7462f8664b3709aaaae23fc78d3de9ae21dc`
- Selected program base: `8575246837e824239af03e63e9e2538852910403`
- Implementation candidate: `ae1efe831833d9799c9988b4c2067b7bab5eb705`
- Implementation tree: `dca88b50744182f53859b9dd6ace3391e98a7d6e`
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
`ae1efe831833d9799c9988b4c2067b7bab5eb705` and renderer fingerprint
`c2dd1a1d44aac6b47b58a18b9b578e2e863bb0b75cfd8dbf95346e841b4eace8`.
Across six deterministic iterations per pair, the product passed all 7 of 7
pairs with 9 true-positive events, no false positives or false negatives,
event F1 1.0, every channel F1 1.0, material recall 1.0, 27 of 27 evidence
anchors, 13 of 13 two-sided facets, and no unsupported facets, references, or
orphan observations. The validated score remains globally `passed: false`
because OS network isolation and signed result attestation were intentionally
absent; `benchmark_claim_ready` remains false.

Exact generated artifact bindings:

- product report: `073ed5a3c90f845e1fa6f0637a21ab2ebd3f0bc92dddad5f4e9b26dfef86f1e1`
- product score: `ea5aceb32504048a1f66a67d57343f9a74a11bc40e807ba842d70ee1ed052628`
- product observation registry: `7987f7248281d8c5d6c90712edca65ad67cda2b5bea9321d134b4e9c5454d258`
- run index: `dda5a5619278fc03fd01d83a3ca49ee06336d83230dae225e506d845a8d7fde7`

The generated raw artifacts remain in the preserved disposable review clone
at `/tmp/pdf-comparison-linux.8upyBV/repo/.comparison-output/` on Silverbook.

## Closed gates and residual work

No push, merge, release, tag, signature, publication, production mutation,
Lumin-provider transport, private sponsor data, or Kepano communication was
performed. MCPB packaging, installed-host exercises, Stonebook x64 evidence,
Claude-chat UI invocation, and broad benchmark/release claims remain separate
gates. Any future integration must consume an exact reviewed SHA and preserve
the Shannon/comparison ownership boundary.
