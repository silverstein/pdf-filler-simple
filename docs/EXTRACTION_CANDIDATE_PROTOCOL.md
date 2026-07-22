# Structured extraction candidate protocol

Phase 1 adds an evaluation-only boundary for comparing optional structured
extraction sidecars. It does not add an extractor, model, runtime dependency,
or MCPB capability. Its runner, independent scorer, artifact attestations,
privacy evidence, immutable generation publisher, and cross-device receipt
format remain excluded from production and share-package archives.

## Process contract

Each candidate attempt starts a fresh process. The runner writes one
`pdf-tools.extraction-candidate.v1` JSON request to standard input, closes
standard input, and accepts exactly one JSON response on standard output.
The runner enforces a wall-clock deadline and byte limits for standard output
and standard error. It also enforces `max_report_bytes` against incrementally
retained attempt and failure evidence, then rechecks the exact serialized
retained evidence before publication. A configuration may use large individual
capture limits when the actual aggregate remains within the report limit. On
supported POSIX hosts the runner checks and empties the candidate
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
The report binds input-adapter availability, and retained-report verification
recomputes capability, license-review, and adapter eligibility before accepting
any success or error outcome.

## Candidate artifact and command identity

A configured candidate has a private artifact configuration that names every
retained file, component, license, root, and role. Components own their license
records in both directions: a component may reference only licenses with the
same component identity, and every license must have exactly one owning
component. The inventory builder rejects missing and extra files, unsafe names,
case and Unicode collisions, symlinks, hard links, special files, invalid
license evidence, and mutations of bytes, modes, paths, roles, or ownership.
A structurally valid license with `pending_review` status is retained as
review-pending evidence; it makes the candidate ineligible for execution until
the license is reviewed.

The runner captures artifact inventories and command evidence before and after
execution. Command evidence binds the executable and every literal or artifact
argument without retaining raw absolute paths or literal values. A failed
postcheck or a change in either the artifact inventory or command evidence
converts every affected attempt to `ARTIFACT_DRIFT`. The execution companion
must describe the same drift result, so command-only drift cannot be hidden by
an unchanged file inventory.

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

Every error retains a typed runner stage and stable error code. A serialized
request limit error also retains the observed request byte count and exact plan
limit. The runner captures these facts in a separate per-attempt evidence map,
binds the map's canonical SHA-256 into the report, and embeds the exact trusted
map in the execution companion when an immutable execution generation is
requested. The runner does not write a standalone report or `.preflight.json`
sidecar. Generation publication retains the canonical report and execution
companion as separately indexed artifacts. Verification derives the trusted
map from that companion and exact-compares its outcome, reason, unmet
requirements, and failure object with the report. It does not infer expected
failure facts from the mutable report. Null request and process fields alone
cannot establish a runner failure.

Phase 1 uses strict exact-key loaders and versioned schemas for the report,
execution companion, privacy attestation, generation index, transfer receipt,
score report, and score provenance. An execution generation is not accepted as
complete merely because those files parse. Every indexed artifact record is
reopened without following symlinks and checked for exact size, SHA-256, mode,
filename, and role.

## Immutable generations and recovery

Execution and score outputs are written only to an explicitly supplied,
out-of-repository generation root. Publication creates a mode-0700 staging
directory and a mode-0600 transaction claim, writes and fsyncs each artifact,
reopens each file for exact verification, and writes the canonical index last
as the commit marker. The index binds its kind, run, transaction, parent
generation when required, and the complete sorted artifact set.

The publisher reinspects the committed staging directory and runs any required
semantic verifier before the atomic same-filesystem rename. It repeats exact
and semantic verification after rename, fsyncs the parent, reinspects again,
then removes and fsyncs the transaction claim. A generation with a sibling
claim is `durability_uncertain` to ordinary readers. Only the exact active
transaction may inspect it internally. Recovery of a privacy-attested
generation requires and reruns its semantic verifier; verifier failure leaves
the claim in place.

After the terminal claim-free semantic callback, publication, receive, staging
recovery, and published recovery perform one more exact inspection. The final
generation digest and canonical index bytes must equal the pre-callback
snapshot. The returned inspection is this post-callback snapshot. This closes
mutation during the terminal callback; continuous immutability after return is
still unavailable and is not claimed.

Execution and score semantic verifiers are separate exported factories, not
retained in-memory closures. They share only bounded-read, transaction,
transport, and privacy primitives. The execution verifier does not import the
scorer or oracle generator, and the score verifier does not import the execution
verifier or runner. Each named local source map equals the complete reachable
static local module graph for its orchestration entry point. A fresh process
rebuilds the selected verifier from explicit trusted local paths, its exact
source and schema role set, PDF.js 5.4.624, and retained generation artifacts.
Execution and score generations retain the exact candidate registry and run
plan used by the report. Score generations also retain the source execution
companion so adapter, artifact, and runner-failure context can be reconstructed
without the scoring process that created them.

Local crash recovery uses an explicit `local_claim_owned` rule. The caller must
supply the expected transaction ID and may supply the exact generation digest;
recovery of a received generation requires that exact digest.
The factory verifies the mode-0600, no-follow claim bytes before accepting the
transaction, permits one terminal claim-free use for that same transaction,
then becomes unusable. This is local, unauthenticated recovery trust. It is not
cross-device authenticity. A fresh recovery after the terminal claim was
removed must provide the exact expected generation digest and recover through a
new exact transaction claim.

Generation kinds have a strict ancestry contract. An original `execution`
index has no source-generation digest. `score`, `received_execution`, and
`received_score` indexes require one. A received execution must embed an
original index whose kind is exactly `execution`.

## Privacy and cross-device receipt boundary

Every execution and score generation carries a privacy attestation. It binds
the ordinary artifact records, directory and file modes, policy, path-hash
behavior, and the digest of the prohibited-root set. It does not claim that
path hashes are secret or that the evidence is authorized for publication.

A private cross-device transfer preserves the original source privacy evidence
verbatim and creates a separate destination privacy attestation from locally
trusted destination roots. Source and destination root digests are not assumed
to match. Both sides must cover the repository and package boundary while the
source and destination generation locations must remain outside the applicable
prohibited roots.

Before any private candidate attempt, the source runner realpaths the repository
and every caller-supplied source prohibited root. At least one supplied root must
contain the repository/package root, and the prospective generation root must
remain outside every supplied root. The runner repeats the boundary check before
publication and after creating the generation root. Additional sync or share
locations are protected only when the caller includes them in the prohibited
root set.

The transfer receipt binds the exact source index bytes, source generation
digest, hosts, transport, time, and a code identity derived from the indexed
execution companion or score provenance. Callers cannot substitute an
unrelated source hash. Receive also requires the exact source generation digest
from an out-of-band trusted input before copying. A received execution must
anchor an original execution, and a received score must anchor an original
score. The destination must contain every source artifact record byte-for-byte
and record-for-record, plus exactly the source index, transfer receipt, and
received privacy attestation. Source generations may not use those transfer-local
roles or paths. The expected receipt code identity is derived from the already
independently verified execution companion or score provenance, never from the
receipt itself. Unsigned receipts state that receipt authenticity is unavailable
and do not call a configured signature verifier. For signed receipts, the fresh
factory requires an explicit trusted verifier, which must return the synchronous
boolean value `true`; promises and other truthy values fail closed.

A received generation retains every original source artifact record exactly and
adds only `source_generation_index`, `transfer_receipt`, and
`received_privacy_attestation`. The scorer checks that exact mapping rather than
trusting a self-consistent destination index.

## Independent scoring

The scorer consumes only a complete execution or received-execution generation.
It revalidates the report, companion, artifact evidence, privacy evidence,
source ancestry, and receipt before computing metrics. Score provenance binds
the explicitly named scorer local source set, oracle inputs, schemas, report
bytes, and scoring leaves. The local set closes every repository source and
schema that governs load, verification, scoring, publication, and recovery. It
also binds package metadata for the MCP SDK, pdf-lib, and PDF.js plus the exact
package lock. Installed external scorer runtime and module-byte closure remain
unavailable and are explicitly nonclaimed.
The score is then published as its own immutable generation that names the
verified execution generation as its source. Scores can be transferred into a
`received_score` generation under the same receipt and privacy rules.

## Typed results and evidence

Candidate outcomes are `completed`, `partial`, `abstained`, or `error`. The
runner adds `not_run` for an unconfigured slot or an unavailable declared
requirement.

The target schema is reduced to exact requested leaf paths using a deliberately
small supported schema subset. Object properties must all be required and
`additionalProperties` must be false. Answered arrays expose concrete scalar
leaves such as `/events/2` and `/rows/1/amount`; unresolved array contracts keep
their exact schema-level gap path. Evidence never inherits from an array parent.
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

Canonical `evidence` and `field_evidence` are untrusted candidate proposals.
They are accepted only for `layout_ir` requests and receive no credit until the
runner and scorer independently re-read retained fixture bytes, validate the
exact shipped `read_pdf_layout` schema, validate layout semantics, reparse the
source with PDF.js 5.4.624, and prove every Unicode code-point span, source item,
line, reading order, quote, exact 0.001-rounded item-union bbox, field path, and
typed value digest. Multiple noncontiguous facts require multiple evidence
records; one broad record cannot receive repeated credit for separated facts.
Direct-PDF and raster proposals fail closed. Exact anchor matching precomputes
the layout digest and Unicode prefix table once per search, preserves a full
100,000-code-point no-match scan, and fails closed before constructing more than
1,000 occurrences across all lines.

The Phase 0 coordinate gate is deliberately narrow: zero raw and display
rotation, equal zero-origin MediaBox and CropBox, UserUnit 1, exact PDF.js view,
display dimensions, viewport transform, complete pages, and valid positive item
geometry. A scorer-only occurrence oracle is independently regenerated from the
retained synthetic corpus. It may approve one of several exhaustive exact
occurrences only when one has a unique positive maximum overlap with the Phase 0
review region. Candidate bboxes themselves must equal the exact item union; the
review region is not copied into candidate evidence.
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
network, CPU, memory, process-count, or process-tree memory isolation. Canonical
page, bbox, fact, and answer metrics are separate and scorer-only. Gaps and
abstentions never enter the answer denominator, though exact gap-bound evidence
may support an independently applicable fact metric.

Each immutable execution generation retains one bounded JSON corpus envelope
containing the exact raw Phase 0 manifest and schema bytes plus the selected
synthetic PDFs. Raw and canonical hashes, ordered case IDs, byte lengths, full
fixture hashes, page counts, privacy labels, and a domain-separated fixture-set
digest are rechecked before report verification. Publication, scoring, reload,
receive, and recovery await composite semantic verification at staging, final,
pre-claim-removal, and claim-free boundaries.

Manifest and schema inputs are opened without following symlinks and are bounded
before JSON parsing. Plans select at most 100 cases. Selected fixtures are read
sequentially under one remaining 8 MiB aggregate budget, with an 8 MiB
per-fixture ceiling. The retained descriptor schema is mandatory. Base64 limits
are the exact encoded ceilings for the 1 MiB manifest and schema inputs and the
8 MiB fixture budget; the whole descriptor and default generation reader share
a consistent 16 MiB ceiling.

The report flags `benchmark_claim_ready`, `calibration_claim_ready`, and
`truth_isolation_claim_ready` remain false. Candidate installation, model
downloads, native-host runs, scoring, product integration, packaging, and
release decisions are separate reviewed work.
