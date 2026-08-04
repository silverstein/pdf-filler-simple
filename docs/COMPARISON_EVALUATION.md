# PDF Comparison Evaluation

This document defines the public, versioned evaluation contract for comparing
two PDF versions. The frozen v1 corpus and scorer remain historical evidence.
The current unmerged candidate adds a minimal deterministic `compare_pdfs`
product, but this document is still an evaluation boundary rather than a claim
of general comparison accuracy or release readiness.

## Product boundary

Comparison is a layered workflow:

1. **Tool primitives** inspect each input and return evidence that is bound to a
   file digest, page, field, annotation, metadata property, or page region.
2. **Deterministic comparison** aligns pages and elements, classifies exact
   changes, preserves uncertainty, and produces a machine-readable change set.
3. **Agent explanation** ranks material changes, explains them in user language,
   cites both versions, and states limitations. It cannot override a failed
   deterministic check.
4. **Viewer UX** presents aligned pages, localized highlights, filters, and a
   reviewable change list. It is scored separately from detection accuracy.

The first corpus measures the first three layers. Viewer interaction remains a
native-host gate. Both inputs are read-only; producing or displaying a report
must not mutate them.

Frozen v1 is benchmark evidence, not the runtime contract. The candidate
`compare_pdfs` tool reads both immutable sources directly and emits page
alignments, seven-channel coverage, source-bound evidence, typed changes, and
reversible material/noise presentation decisions. It enumerates inert ordinary
annotations separately from form widgets and preserves Info/XMP metadata
disagreements. It refuses documents over 20 pages rather than comparing
prefixes. Its complete status means only that the requested channels were
observed under the named deterministic policies; it never claims document
equivalence.

## Threat model

A comparison can look persuasive while being wrong. The harness therefore
tries to falsify these failure modes:

- reporting any byte-level rewrite as a user-visible change;
- missing a material number, date, negation, party, or obligation change;
- treating a small layout or anti-aliasing shift as a semantic change;
- comparing pages only by index when pages were inserted, deleted, or moved;
- finding visible text while missing form-field, annotation, metadata, or
  logical-structure changes;
- citing only one version, the wrong page, or a broad page when a region is
  known;
- using a model-generated explanation as the oracle for deterministic facts;
- silently dropping an unparseable, encrypted, scanned, or unsupported page;
- claiming no change when a required evidence channel failed;
- leaking document content or sending it to an undeclared external service.

## Corpus contract

The canonical manifest is
`test/fixtures/eval/comparison/manifest.v1.json`, validated against a matching
JSON Schema and an independent fail-closed JavaScript validator. Every case
contains:

- stable case and pair IDs, corpus partition, immutable before/after SHA-256,
  media types, provenance, redistribution license, and privacy classification;
- explicit page-alignment truth;
- typed expected changes and typed distractors;
- before/after page and top-left PDF-point region where applicable;
- expected old/new normalized values or digests;
- materiality and salience labels;
- channels required to observe the change; and
- limitations that a correct report must preserve.

The public v1 slice is synthetic and contains no personal data. Generation must
be byte-reproducible. Development and held-out-release partitions use different
semantic operations, text values, layouts, and seeds. The public repository
must not contain private sponsor documents or derived excerpts. V1 contains a
two-page base document and these seven logical pairs:

- identical inputs;
- material amount and date changes;
- a visible vector-status change with unchanged extracted text;
- meaningful pixel noise caused by non-semantic font/layout movement;
- metadata-only changes;
- reordered pages with the same page-content set; and
- a form-value change plus an independently added annotation.

The validator requires exactly these seven case roles and their role-specific
mandatory facets, modes, materiality labels, provenance, and presentation
policies. This public corpus is an operational holdout, not a secret benchmark.
Public visibility is not permission to expose its truth manifest to a
system-under-test run.

### Change taxonomy

The v1 taxonomy is deliberately explicit:

| Channel | Examples | Deterministic oracle |
|---|---|---|
| `semantic` | amount, date, party, negation, obligation | pinned expected normalized values plus evidence in both versions |
| `text` | insertion, deletion, replacement | normalized text spans and page/region anchors |
| `structure` | page insert/delete/move, geometry or rotation | page alignment, page tree, media/crop boxes, rotation |
| `form_field` | value, option, required state, added/removed field | canonical AcroForm field records |
| `annotation` | added/removed/changed note, link, widget, or mark | canonical annotation subtype, rectangle, content, and target |
| `metadata` | title, subject, keywords, author, dates, XMP | canonical property/value records with volatile-key policy |
| `visual` | image, drawing, stamp, or scan-only change | renderer-pinned region masks and pixel statistics |

One truth event may carry multiple typed channel facets, but it is counted once
in the overall event metric. This prevents one amount edit from being inflated
into unrelated semantic, text, and visual wins. Facets retain separate channel
scores, and a channel failure cannot be hidden by a correct result in another
channel.

Every facet declares whether it is mandatory or optional and binds its own
evidence. Unicode normalization, whitespace handling, tokenization, date and
currency normalization, volatile metadata keys, point-coordinate rounding, and
region-overlap rules are versioned before a run. The scorer may not infer or
tune normalization from the expected answer.

A truth event is an event-level true positive only when every mandatory facet
matches. A candidate with enough evidence to identify the event but with a
missing, unsupported, or unavailable mandatory facet is retained as
`matched_incomplete` for diagnosis, not counted as an event true positive. The
missing facet is a facet false negative. Explicit `unavailable` is honest
limitation reporting; it never satisfies detection recall. Every mandatory
material facet must have recall 1.0 for the v1 hard gate. In the combined
form-and-annotation role, the field-value change and the newly added annotation
are two separate truth events, so field evidence cannot absorb an annotation
miss.

### Distractors and invariants

Every corpus version includes negative controls:

- byte-different but user-visible-equivalent PDFs;
- metadata-only changes;
- sub-point layout shifts and renderer anti-aliasing noise;
- reserialization, object renumbering, compression, and producer/date churn;
- repeated headers/footers surrounding one material body change; and
- identical pages in a different structural context.

Distractors are not universally ignored. The manifest declares whether each is
`report`, `suppress`, or `report_on_request` for each output mode. A metadata
review may report a producer change that the default material-summary mode
suppresses.

## Prediction contract

A claim-eligible system under test must run in a fresh allowlisted directory
containing only the two PDFs, the comparison mode, and the public prediction
schema. It has no repository path, truth manifest, unrelated MCP server, or
shell access. The scorer process alone loads the truth manifest, and only after
the prediction has been schema-validated, hashed, and frozen. The harness
records pre/post input hashes, allowed-directory access evidence, PDF Tools
egress policy, host/model transport policy, and optional external-baseline
processes separately.

The v1 shared-library and current-product descriptive lanes do **not** yet meet
that isolation contract. Their controller can see the repository and truth,
their shell boundary is not OS-enforced, and network denial is not enforced.
They therefore report those states honestly and cannot pass the global scorer,
even when individual pair-level capability metrics are useful. Their separate
controller observation registries freeze report and observation digests, but
are unsigned and are not independent attestations. The scorer reserves global
`passed: true` for a verified controller attestation; v1 deliberately implements
no path that upgrades an unsigned registry to verified, even when caller-supplied
isolation flags say otherwise. Pair-level diagnostic passes remain available.

All system-under-test and tool network access is denied during a scored run.
When a remote model is used, only its predeclared inference endpoint is
reachable through a controller that exposes no browser, URL fetcher, arbitrary
network client, or repository content. Attempted truth retrieval is a policy
failure even if the destination was declared.

The report contains exact input digests, selected mode, candidate page
alignments, detected events, presentation decisions, evidence references,
limitations, timing, renderer/parser identities, and external-request counts.

`detected_events` records raw observed changes independently of what a user
should see in a particular mode. `presentation_decisions` references those
run-local events and declares a mode, a `report`, `suppress`, or
`report_on_request` disposition, and a rationale. A metadata-only event can
therefore be correctly detected yet suppressed from a default material summary
without becoming a false positive or false negative.

Each predicted change has:

- a stable run-local ID and one or more typed channel facets;
- `added`, `removed`, `modified`, or `moved` operation;
- materiality and confidence;
- before/after normalized values or digests when available;
- before/after page plus top-left PDF-point region when available;
- evidence references bound to observed tool results; and
- a concise factual summary.

Candidate page-alignment records contain `before_page` or null, `after_page` or
null, a `same`, `moved`, `inserted`, or `deleted` relation, stable content
anchors, and an optional ambiguity group. V1 permits only one-to-one-plus-null
alignments. Repeated or otherwise ambiguous pages retain the ambiguity rather
than being guessed. Each before/after region is expressed separately in
top-left PDF points and binds the page box and rotation used for conversion.

Unknown and unavailable are first-class states. An empty change list is valid
only when every channel required by the case completed successfully.

## Deterministic scoring

The scorer performs one-to-one matching between predictions and truth. A
candidate-supplied truth-event ID is ignored. Matching derives from the typed
facets and operation, directional before/after source hashes and normalized
values, candidate alignment, and region intersection-over-union where regions
exist. It does not match on prose similarity alone.

Candidate IDs are run-local and a candidate ID equal to a truth ID is rejected.
Candidate alignment is itself scored and must be correct for an associated
event to match; truth alignment never repairs a missing or wrong prediction.
Event assignment uses a versioned maximum-cardinality, maximum-weight bipartite
match with a deterministic lexicographic tie-break. Each truth and candidate
event matches at most once; duplicate predictions are false positives.

The report keeps these metrics separate:

- per-channel true positives, false positives, false negatives, precision,
  recall, and F1;
- event-level micro and macro F1;
- exact material-change recall (a hard gate);
- distractor false-positive rate and no-change-case specificity;
- detection precision/recall separated from mode-specific suppression and
  presentation-policy accuracy;
- page-alignment accuracy;
- evidence completeness, two-sided citation rate, page accuracy, and region
  localization IoU;
- explanation salience and factuality, scored only after deterministic facts;
- source immutability and undeclared external requests;
- wall latency, peak child RSS, rendered pixels, pages inspected, tool calls,
  and logical input bytes processed (not instrumented physical I/O); and
- operating system, architecture, Node/runtime, parser, renderer, host, and
  model cost where applicable.

Undefined denominators remain `null`; they are never converted to perfect
scores. Harness failures, unsupported channels, product failures, and policy
violations are reported separately. A weighted average cannot override any hard
gate.

V1 deterministically scores predeclared salience labels. Explanation factuality
remains pending a separately versioned model or human rubric; fluent summaries
are not treated as factual merely because the underlying event matched.

### V1 hard gates

- both input hashes match and remain unchanged;
- all required channels return a terminal supported or explicit unavailable
  state;
- every required channel is supported for a passing pair; `unavailable` is an
  honest diagnostic state but cannot prove absence of a change;
- material-change recall is 1.0 for the small public slice;
- every mandatory material facet has recall 1.0; an explicit unavailable state
  remains a false negative for detection;
- no fabricated event, unsupported candidate facet, channel false positive, or
  evidence reference that fails binding;
- no undeclared external request;
- independently retained raw-result bindings for every observation and a
  verified controller attestation for any global pass;
- every material claim has evidence from both versions when both regions exist;
- every candidate event has exactly one mode-matched presentation decision,
  and every matched event has the correct predeclared salience;
- the deliberately byte-different/visually-equivalent pair produces no default
  user-visible change; and
- the deliberately visual-only change is not declared unchanged.

Thresholds for non-hard metrics live in the manifest and may change only with a
corpus-version bump and review.

Performance runs use one separately reported warm-up followed by five measured
iterations for each engine/pair. Reports retain the warm-up latency and cost,
every measured timing and cost sample, and totals equal to all six executions.
Peak RSS names the process actually measured; if child-process RSS is not
available it is null and explicitly marked unavailable rather than substituted
with parent RSS. Tests assert report validity and calibrated budgets, not exact
wall-clock values.

Raster scoring compares raw RGBA, never encoded PNG bytes. The canonical v1
lane is literal and fail-closed:

- `pdfjs-dist` 5.4.624 and `@napi-rs/canvas` 0.1.99;
- scale `2.0` (144 DPI at 72 PDF points per inch);
- `CropBox` when present, otherwise `MediaBox`, with intrinsic page `Rotate`
  applied by PDF.js before scaling;
- canvas width and height `ceil(viewport dimension)`;
- opaque sRGB white background `[255, 255, 255, 255]`, with alpha flattened;
- top-left point regions converted after rotation and scale, with minima
  rounded down and maxima rounded up;
- `isEvalSupported: false`, `useWorkerFetch: false`, `useSystemFonts: false`,
  `useWasm: false`, no system renderer, no font fallback, and embedded standard
  fonts supplied from the pinned PDF.js package;
- a pixel changes when the maximum absolute RGBA-channel delta is greater than
  `8`;
- one-pixel Chebyshev mask dilation, eight-connected components, minimum
  component area four pixels; and
- dimension mismatch is a visual/structure failure, never resized away.

Reports bind those values, the package/platform/architecture fingerprint, and
page raster hashes. The scorer fails closed if any setting or fingerprint
differs. If the canonical renderer is unavailable, the channel is unavailable;
it never silently switches.

A frozen reference-renderer profile identifies the Linux runtime that produced
the v1 raw-RGBA truth anchors. Exact raw hashes remain reference-renderer
identity checks. A different operating system, architecture, Node runtime, or
native canvas build may exercise source binding, text, structure, form,
annotation, metadata, identical-page, localization, and bounded-delta controls,
but it may not replace the v1 hashes or claim a canonical benchmark result.
The evidence generation command fails before rendering unless the frozen
reference identity and manifest digest match. It also requires an explicit
public-safe host label and refuses to write unless the generated shared report
reproduces the complete frozen event, anchor, two-sided-facet, and pair score.
Non-reference compatibility captures, when added, must use a separate output
directory and receipt.

The published v1 evidence did not retain native canvas binary or PDF.js
standard-font tree digests. The companion profile records that limitation
instead of inventing provenance. A future benchmark version must retain those
byte-level identities before it can supersede the v1 reference profile.

A documented channel threshold, bounded anti-aliasing-mask dilation,
changed-pixel fraction inside expected regions, and unexpected-change fraction
outside allowed regions are calibrated from identical and layout-noise controls
per renderer/platform. A broad global tolerance may not hide a visible change.
Same-renderer raster comparison is an implementation sensor, not independent
truth.

## Reference baselines

V1 records separately reported reference baselines rather than an opaque
aggregate score:

1. normalized per-page text sequence comparison using `pdfjs-dist` (shared
   implementation dependency);
2. PDF structure, form, annotation, and document-info comparison using
   `pdf-lib` plus direct dictionary inspection where the high-level API is
   incomplete (shared implementation dependency);
3. same-renderer raster comparison at a pinned scale, reporting exact changed
   pixels, a thresholded mask, connected regions, and excluded-noise regions
   (same-renderer implementation sensor);
4. current PDF Tools `compare_pdfs` candidate, using its public whole-document
   contract and all seven typed coverage channels;
5. an optional Poppler CLI baseline on named versions, recorded as an external
   process and never bundled or used as the sole oracle; and
6. other optional external tools on named versions, never used as the sole
   oracle.

Agreement between PDF Tools and a shared PDF.js or pdf-lib reference is not
independent confirmation. Only a named implementation with distinct provenance,
such as Poppler or qpdf, is labeled external/independent, and no single external
engine is the sole oracle.

### Current candidate adapter and host boundary

The product baseline invokes `compare_pdfs` once per pair and requires six
byte-stable iterations, immutable source envelopes, complete seven-channel
coverage, exact page relations, one-to-one typed events, source/page/rotation/
page-box evidence, and region IoU of at least 0.5. Evaluator-only normalization
adapts the candidate's richer evidence envelope to frozen v1 truth shapes. It
does not put truth IDs or expected values into the runtime, and its capture is
`oracle_calibration`, not measured product or benchmark evidence.

The frozen v1 scorer admits only its reviewed Linux x64 renderer profile on
Node 22.22.3 with `pdfjs-dist` 5.4.624. Silverbook's Darwin arm64 renderer is
therefore not an exact scoring host. A direct development run on Silverbook
produced F1 1.0 for semantic, text, structure, form-field, annotation, and
metadata channels, but host-dependent raster hashes made visual F1 0 and only
3 of 7 product pairs passed. Those numbers are diagnostic, not a benchmark
claim. Exact Linux/amd64 scoring and the remaining package/native-host gates
must pass before a release-readiness statement.

PDF object identities, stream bytes, timestamps, and compression are not
semantic equality signals. Raster comparison is a localized visual sensor, not
a semantic oracle. Text comparison cannot prove that a visual or form change is
absent.

The frozen trajectory evidence binds generic regions only where its reviewed
schema permits them. The product candidate now emits comparison observations
with exact source hash, page/view geometry, native and display regions,
canonical-value digest, raw-result digest, and observation digest. A claimed
region still cannot self-attest: the frozen scorer and its independent
validator remain the authority for benchmark matching.

## Agent trials

At least three predeclared independent attempts run the public compare job. Each
uses a distinct synthetic fixture instance sampled from one predeclared
operation family/distribution and a fixed run plan established before
execution. A changed label, seed, or unrelated semantic operation does not by
itself establish independence. The trajectory scorer requires:

- inspection of both exact inputs;
- no mutation, undeclared tool/server, URL-fetching, or external-baseline
  request; predeclared model-inference transport is accounted separately;
- correct material changes and suppressions;
- evidence bound to both input hashes and exact pages/regions;
- a terminal answer after the final observation; and
- limitations for any unavailable required channel.

Reports include attempted runs, product trials, harness failures, pass rate,
sample variance, standard error, and a Wilson interval only after the existing
independence and trust gates pass. Generated calibration records exercise the
grader but are never presented as observed agent performance.

Measured trials still require the shared trajectory schema, ingester, and
grader to accept generic observed regions bound to the exact input hash, page,
box, render parameters, result/image digest, and retained host observation.
The comparison answer schema and trusted suite digest must be reviewed and
bumped. Agents return `unavailable` for any required channel the admitted
runtime cannot observe; they may not infer unchanged. Predeclared per-case
strata and denominators cannot be changed after seeing results. Because the
repository has no authorized planner or result-attestation keys, the measured
report remains descriptive,
`benchmark_claim_ready` remains false, and no keys are authorized merely to
make this Bead pass.

## Platform and privacy reporting

Baseline records name exact software versions and hardware class. Privacy
accounting separates PDF Tools server egress, host/model transport, content or
excerpts disclosed to the model, and external-baseline processes. A local MCPB
server making zero requests does not make a remote-model workflow zero-egress.
Remote-model trials use public synthetic fixtures only unless private-document
consent, retention, and regional-processing requirements are explicitly
satisfied. Cloud-hosted agents remain a separate product boundary: upload,
retention, authentication, regional processing, consent, and cost must be
declared and evaluated separately.

## Frozen v1 implementation sequence

1. Add schema, independent validator, reproducible generator, paired fixtures,
   and hostile validator tests.
2. Add prediction validation and exact event/evidence scoring with mutation
   tests against false-pass behavior.
3. Implement the bundled deterministic reference baselines without adding a
   shipped runtime dependency; treat Poppler as an optional named external
   baseline whose absence is `engine_unavailable`, never a pass.
4. Record the current deterministic baseline on development fixtures.
5. Extend the existing `compare-and-explain` trajectory job beyond the accepted
   three-run descriptive headless campaign: add independent fixture instances,
   the other five suite jobs, native Claude Desktop and packed-MCPB trials, and
   release-scale repetition before making an agent-reliability claim.
6. Produce a versioned `comparison-decision.v1.json` and readable report bound
   to exact corpus, schema, scorer, baseline, renderer, and raw-report hashes.
7. Adversarially review the full slice, then run focused, shuffled, concurrent,
   and whole-suite tests before integration.

The comparison observations and region scorers are intentionally reusable by
the broader mutation-fidelity benchmark. V1 remains born-digital and does not
choose an OCR, table-extraction, or layout-reconstruction architecture; those
channels are explicit future coverage rather than hidden assumptions.

The decision artifact records the per-channel capability matrix; accuracy;
false positives; material salience; latency; RSS; rendered pixels; tool calls;
model cost; bundle/runtime footprint; native-platform coverage; licenses; and
privacy boundaries. It makes separate build, defer, or research recommendations
for product primitives, agent explanation, and viewer UX. Baseline failures are
preserved; truth, thresholds, and recommendations are not tuned to make the
current product pass.

## Claim boundary

Passing the public synthetic slice means only that the named implementation met
this versioned contract on those fixtures and platforms. It does not establish
general legal-document accuracy, OCR quality across languages, equivalence to
Acrobat or another commercial product, or correctness on private sponsor data.
Those claims require broader held-out corpora, native-host evidence, human
review, and field corrections.

## Research basis and expansion path

The benchmark architecture reflects current primary evidence without importing
third-party datasets or proprietary implementations:

- [Adobe Acrobat Compare Files](https://helpx.adobe.com/acrobat/using/compare-documents.html)
  separates continuous-text, page/slide matching, scan/pixel, text, graphics,
  formatting, annotation, filtering, and side-by-side review modes.
- [Adobe Acrobat Analyzer Compare](https://helpx.adobe.com/acrobat-analyzer/using/collections/compare-files.html)
  combines normalization, exact matching, and semantic similarity while linking
  each attribute to source locations in both documents.
- [LegDiff at ACL 2026](https://aclanthology.org/2026.acl-srw.86/)
  reports low end-to-end span-and-label and contradiction performance even for
  frontier models, supporting an uncertainty-bearing model layer rather than a
  model-only oracle.
- [qpdf JSON v2](https://qpdf.readthedocs.io/en/stable/json.html) provides a
  complete low-level PDF object representation while explicitly not providing
  text extraction or semantic structure; it is a useful optional structural
  oracle, not a complete comparator.
- [PDF Association `pdf-differences`](https://github.com/pdf-association/pdf-differences)
  supplies licensed rendering/interoperability stress cases that should remain
  a separate sentinel from paired semantic fixtures.
- [RealDocBench](https://github.com/extend-hq/realdoc-bench) demonstrates typed
  strict scoring, human region annotations, split/merge-aware matching, and
  explicit latency/cost accounting.
- [ALCE](https://aclanthology.org/2023.emnlp-main.398/) separates citation
  correctness from citation completeness; comparison evidence needs both.

After the seven-case executable slice proves the harness, the expansion target
is an original 64-pair corpus: 32 atomic changes across eight channels, 16
benign/noise controls, eight page-alignment/reflow cases, and eight adversarial
cross-layer contradictions. External corpora are adopted only after document
rights are verified separately from annotation/code licenses. Optional PDFBox,
qpdf, current-upstream PDF.js, and Poppler lanes remain named eval engines and
must never silently enter the shipped MCPB.
