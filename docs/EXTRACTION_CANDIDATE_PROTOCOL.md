# Structured extraction candidate protocol

Phase 1 adds an evaluation-only boundary for comparing optional structured
extraction sidecars. It does not add an extractor, model, runtime dependency,
or MCPB capability. The Phase 0 corpus, scorer, baseline runner, and retained
evidence remain unchanged.

## Process contract

Each candidate attempt starts a fresh process. The runner writes one
`pdf-tools.extraction-candidate.v1` JSON request to standard input, closes
standard input, and accepts exactly one JSON response on standard output.
The runner enforces a wall-clock deadline and byte limits for standard output
and standard error. On supported POSIX hosts it checks and empties the candidate
process group after every attempt, including a delayed force-termination pass
after a successful leader exits. A process that deliberately creates a new
operating-system session is outside this process-group boundary.

The default registry contains five stable slots:

- `control.current_product.v0`
- `candidate.layout_ir.v1`
- `candidate.direct_pdf.v1`
- `candidate.raster.v1`
- `candidate.remote_model.v1`

All slots are intentionally unconfigured. An unconfigured slot produces a
retained `not_run` outcome for every planned case and repetition. A configured
candidate must have an exact version, reviewed framework and model license
metadata, an absolute executable path, and explicit environment requirements.
If the runner cannot provide a requirement, it records `not_run` rather than
claiming isolation.

## Truth projection

The candidate receives a staged working copy of the PDF, runner-derived source
size, SHA-256, and page count, the requested input payload, the target JSON
schema, and fixed limits. Adapter builders receive a frozen public task
projection with the same source facts and target schema.

The serialized request and frozen adapter task projection do not contain
fixture IDs, manifest paths, partitions, categories,
ground truth, expected transcripts, truth boxes, fact IDs, expected answer
state, scorer thresholds, evaluation policy, repository paths, other candidate
outputs, or private host environment variables. This is a request-projection
claim only. The candidate process is not filesystem isolated and could inspect
other readable host paths. Request IDs bind the run,
candidate, source, target schema, limits, case, and repetition without exposing
the hidden case identity.

The runner retains bounded raw standard output and standard error bytes and
computes independently verifiable source, request, raw response, and canonical
response digests. Each attempt uses a new read-only staged source copy, and a
changed or removed copy becomes `SOURCE_MUTATED` even when the candidate
otherwise returned a valid response.

## Typed results and evidence

Candidate outcomes are `completed`, `partial`, `abstained`, or `error`. The
runner adds `not_run` for an unconfigured slot or an unavailable declared
requirement.

The target schema is reduced to exact requested leaf paths using a deliberately
small supported schema subset. Object properties must all be required and
`additionalProperties` must be false. Arrays are treated as leaf values.
Unsupported composition or optional-object shapes fail closed.

- `completed` must be target-schema valid, answer every leaf, and have no gaps.
- `partial` must answer at least one leaf and assign a unique typed gap to every
  unresolved leaf. Its answered projection must preserve the target leaf types
  and reject extraneous structure.
- `abstained` must assign a typed gap to every requested leaf and return no
  structured answer.
- `error` must return no extracted content, evidence, field coverage, or gaps,
  and must provide a stable bounded diagnostic code and message.

Answered and gap paths cannot overlap. Gaps must name exact schema leaves, not
parent objects. The empty JSON Pointer identifies the root value; `/` identifies
an object property whose name is the empty string.

Canonical `evidence` and `field_evidence` arrays are structurally required to be
empty. No candidate input, including an empty or self-described layout IR, can
authorize canonical ODA evidence until a separate verifier proves source-item,
quote, CropBox, UserUnit, rotation, region, and PDF.js display equivalence.
Page text declares a typed origin:
`born_digital_text_layer`, `ocr`, `visual_parser`, or `hybrid`. Direct-PDF
candidate text cannot claim born-digital text-layer origin without
runner-bound source items.

A separate `native_evidence` lane may retain engine-native coordinates, engine
and model version, native self references, page geometry, box basis, rotation,
UserUnit handling, and quotes. Native evidence is response-hash bound but never
receives canonical ODA evidence credit. Engine-native self references cannot be
copied into ODA `source_item_ids`. This preserves useful adapter evidence while
CropBox, rotation, coordinate origin, and UserUnit equivalence remain unproved.
Native evidence IDs must be unique, and each native bbox must remain inside its
declared engine page geometry.

Raw table cells declare `row_span`, `column_span`, `present: true`, and their
exact JSON value. Empty string, zero, and null remain distinct. A missing cell
coordinate is represented by absence. Cell starts are unique, spans are bounded
and non-overlapping, and `merged_regions` must exactly equal the coverage of
cells whose row or column span is greater than one.

## Claim boundary

The current Node runner truthfully reports that it does not enforce filesystem,
network, CPU, memory, process-count, or process-tree memory isolation. Candidate
evidence also remains unscored until a separate scorer binds values, source
items, page geometry, quotes, and regions independently.

The report flags `benchmark_claim_ready`, `calibration_claim_ready`, and
`truth_isolation_claim_ready` remain false. Candidate installation, model
downloads, native-host runs, scoring, product integration, packaging, and
release decisions are separate reviewed work.
