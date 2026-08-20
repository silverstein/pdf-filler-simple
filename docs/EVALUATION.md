# Evaluation and Release Evidence

PDF Tools is not state of the art because it has many tools or because a demo
worked once. It earns that claim when a versioned evaluation system can show
that agents complete real document jobs correctly, safely, and consistently on
the hosts we support.

This document defines that system. Engineering work remains tracked in Beads;
this is the public scoring and evidence contract.

## Principles

1. **Evaluate user jobs, not isolated model answers.** A trial includes the
   prompt, tool trajectory, source files, output files, visible host behavior,
   and final answer.
2. **Prefer deterministic graders.** Exact structure, hashes, schemas, page
   geometry, pixels, fields, filesystem effects, and protocol behavior should
   be checked by code. Model and human graders cover qualities that cannot be
   reduced safely to exact assertions.
3. **Require evidence chains.** A correct-looking answer is incomplete when it
   cannot point to the page, region, field, or transformation that supports it.
4. **Separate product failures from harness failures.** Automation timeouts,
   host focus problems, and unavailable fixtures are reported independently and
   never converted into product passes.
5. **Turn every escaped defect into an eval.** A reproducible user report or
   maintainer correction becomes an anonymized fixture and regression test when
   licensing and privacy permit it.
6. **Do not average away blockers.** Security, destructive mutation, signature
   intent, artifact integrity, and supported-host startup are hard gates.

## Evidence layers

| Layer | What it proves | Typical evidence |
|---|---|---|
| L0: unit and property tests | Helpers and invariants behave correctly | Test output, fuzz seeds, exact assertions |
| L1: MCP contract | Tool discovery, schemas, results, errors, resources, and lifecycle are protocol-correct | Recorded JSON-RPC transcript and schema checks |
| L2: packed artifact | The exact MCPB is self-contained and contains the intended code and native targets | SHA-256, archive inventory, manifest diff, SBOM, extracted-artifact smoke |
| L3: runtime shape | Electron utility-process and browser-sandbox assumptions are represented in tests | Electron-shaped tests and viewer browser tests |
| L4: native host | The final artifact installs, exposes tools, renders, and completes core jobs in a supported host | Host/app versions, install registry, screenshots, logs, tool transcript |
| L5: agent workflow | An agent chooses suitable tools, asks for needed intent, recovers from errors, and returns a verifiable artifact | Versioned task, repeated trials, trajectory grade, output grade |
| L6: field evidence | Real users succeed and their corrections improve the suite | Anonymized failure class, support issue, regression fixture, trend report |

Passing a lower layer does not imply a higher-layer pass. In particular, direct
stdio success does not prove Claude Desktop integration, and a screenshot does
not prove the output file is correct.

## Corpus design

The corpus is versioned, anonymized, licensed for its use, and split so that
development does not tune entirely against the release set. Every fixture has
provenance, expected properties, permitted uses, and a stable identifier.

Cover at least these families:

- born-digital text, scans, mixed text/image, and degraded OCR;
- simple and multi-column layouts, tables, lists, equations, and images;
- AcroForm, XFA, flattened, encrypted, signed, and malformed files;
- rotated, cropped, unusually sized, very large, and multi-document packets;
- accessible/tagged documents and documents with known PDF/UA defects;
- Windows-originated paths and filenames, Unicode, spaces, commas, and long paths;
- adversarial content, embedded links, oversized objects, and parser edge cases.

Public fixtures belong in the repository only when redistribution is clearly
allowed. Confidential or user-supplied documents stay outside Git; derived
synthetic fixtures should reproduce the failure without retaining private data.

### External olmOCR-bench regression gate

The tracked olmOCR-bench gate measures page-1 Markdown extraction and typed-gap
coverage across an external 1,403-PDF corpus. The corpus is not vendored. Its
upstream revision, seven JSONL inputs, metadata, and canonical PDF inventory are
pinned in `test/fixtures/eval/olmocr/manifest.v1.json`. Download the ODC-BY
dataset separately and verify all bytes before executing product code:

```bash
npm run eval:olmocr -- verify --bench-root /absolute/path/to/olmOCR-bench
```

A full release-candidate run and score run on a POSIX Linux or macOS host and
use exclusive, atomic, mode-`0600` JSON outputs outside the repository.
Existing outputs are never overwritten:

```bash
npm run eval:olmocr -- run \
  --bench-root /absolute/path/to/olmOCR-bench \
  --output /private/evidence/run.json
# Retain the printed run SHA-256 independently before scoring.
npm run eval:olmocr -- score \
  --bench-root /absolute/path/to/olmOCR-bench \
  --run /private/evidence/run.json \
  --run-sha256 PRINTED_RUN_SHA256 \
  --output /private/evidence/score.json
```

The runner starts the candidate and every descendant inside a fail-closed
OS process-tree boundary with no network namespace on Linux or a deny-network
sandbox on macOS. A pinned Node preload denies common network APIs in the main
process as defense in depth. The report binds the isolation executable and
policy, Node executable, Node,
V8, ICU/Unicode, platform, architecture, the exact installed dependency tree, evaluator,
candidate source tree, and network preload. Provider credentials and proxy
variables are not inherited. A host without the required isolation mechanism
cannot run or qualify. `score` accepts only a mode-`0600`, current-user
owned run whose independently retained digest is supplied explicitly, and it
re-verifies the exact clean Git candidate and installed runtime before scoring.

The headline is the three-bucket decomposition excluding math: `pass`,
`failed_flagged`, and `failed_silent`. Percentages use attempted tests only;
`not_run` remains a separate count. Math is shown separately because it uses
a normalized-string containment proxy rather than the upstream rendered-bbox
symbol-layout test. Exact Unicode superscript and subscript presentation forms
are folded back to their base characters for matching because the corpus uses
flat TeX-like math strings and the retained reference predates the product's
presentation-preserving script projection. `failed_flagged` requires a gap relevant to the test: a
whole-text failure or truncation can cover missing content, table gaps cover
only table tests, and the math gap covers only math. Image/OCR gaps cover a
failure only when the scored extraction body is empty; they never excuse
forbidden text emitted by an `absent` failure. It is not a correctness pass.
The JavaScript fuzzy and table approximations are useful for internal
directional regression tracking only.
Every report therefore sets `benchmark_claim_ready` to false and prohibits a
public benchmark claim. A limited run, dirty candidate, conversion failure,
corpus mismatch, or binding mismatch is non-qualifying.

The `score` command is an executable gate, not just a report generator. It
exits `0` only when the run is qualifying and the pinned no-regression policy
passes: non-math pass count cannot fall, non-math silent failures cannot rise,
math silent failures cannot rise, and every category must preserve its pass
and silent-failure bounds. It writes the report before returning exit `2` for a
qualification or regression failure so the blocking evidence is retained.
The manifest binds the reference run, scorer digest, and exact reference
counts. Changing scorer semantics requires an explicit baseline review and
re-pin.

Ordinary candidate scores include a `deprecated_candidate_profile` section to
show how that candidate would look under the discarded first-run rules. It is
not a historical-compatibility assertion and is never gating. Reproducing the
original 2026-08-19 result is a separate exact-byte operation: use the retained
run whose digest is pinned in the manifest.

```bash
npm run eval:olmocr -- verify-reference \
  --bench-root /absolute/path/to/olmOCR-bench \
  --run /private/evidence/pinned-first-run.jsonl \
  --output /private/evidence/reference-verification.json
```

That command refuses any other run bytes and succeeds only when the deprecated
profile reproduces 921 / 2,922 / 3,176 and the primary scorer reproduces every
threshold used by the tracked regression gate.

### Executable corpus v0

The first executable slice lives at `test/fixtures/eval/manifest.v1.json` and is
defined by `manifest.schema.json`. Stable fixture IDs begin with
`pdf-tools.eval.v1.`. Every entry records its exact SHA-256, manifest-relative
path, provenance, redistribution terms, privacy class, partition, category, and
expected deterministic properties.

The ordinary run selects only `development`:

```bash
node scripts/eval-run.mjs
```

The release partition is deliberately separate and must be named explicitly:

```bash
node scripts/eval-run.mjs --partition held_out_release
```

This split prevents ordinary development runs from continually exercising every
release example. The committed release fixture is public for auditability, so
this is an operational holdout rather than a secret benchmark. Future private
release fixtures must remain outside Git and use a separately controlled
manifest; they must never be copied into this public corpus.

Synthetic PDFs are tiny and reproducible with
`node scripts/eval-generate-fixtures.mjs`. The manifest also references the
existing blank 2014 IRS W-9 golden fixture in place. Its upstream source is the
[IRS prior-year form](https://www.irs.gov/pub/irs-prior/fw9--2014.pdf), and its
redistribution basis is recorded as a United States government work under
[17 U.S.C. section 105](https://www.copyright.gov/title17/92chap1.html#105).
The signature-zone golden set includes a SHA-bound synthetic `/Rotate 90` page
with a nonzero CropBox. Regenerate it with
`node scripts/generate-golden-fixtures.mjs`; its test requires byte-for-byte
reproducibility and a 1.0 native-coordinate placement score.

The v0 scorers cover parseability, exact page and form-field counts,
tolerance-bounded media/crop boxes, rotation, basic per-page text extraction
through an independent parser, exact created/modified/deleted file sets, and
source-file immutability. The development corpus includes a
visibly reversed two-page PDF: it remains non-empty, parseable, and has the
correct page count, but the geometry scorer rejects the swapped page order.
This is the minimum adversarial guard against tests that only prove a PDF was
written.

## Scoring contracts

Accessibility claims have an additional fail-closed evidence ladder. The
executable catalog-level screen, adversarial false-certification fixtures,
claim taxonomy, provenance rules, human-review boundary, and standards sources
are defined in [Accessibility Evaluation and Claim Safety](ACCESSIBILITY_EVALUATION.md).
Passing that screen is explicitly not evidence of PDF/UA or WCAG conformance.

### Deterministic graders

- protocol negotiation, tool-list stability, JSON Schema validity, and result shape;
- exact or tolerance-bounded form-field values and CSV round trips;
- page count/order/rotation/crop boxes and expected filesystem effects;
- signature and annotation geometry, including coordinate-system conversion;
- output readability across independent PDF parsers;
- text coverage, reading order, page anchors, table-cell structure, and schema validity;
- visual pixel or region differences with documented tolerances;
- no unintended mutation, overwrite, partial output, external request, or data escape;
- artifact contents, native binary inventory, startup, and render output;
- latency and peak-memory budgets on named hardware classes.

### Model graders

Use rubric-scored model judgment only for qualities such as error clarity,
workflow choice, summary usefulness, comparison salience, and whether a visual
change matches the user's intent. Pin the grader prompt and model, retain the
reasoning-independent score record, calibrate it against human labels, and do
not let it override a deterministic failure.

### Human gates

Human review remains mandatory for release authorization, signature intent,
claims of accessibility or legal compliance, destructive or externally shared
outputs, and ambiguous fidelity decisions. Human approval is a product boundary,
not a missing automation feature.

## Agent-workflow trials

Each task specifies the user job, starting files and permissions, allowed side
effects, expected evidence, success rubric, and failure conditions. Run multiple
unique trials when agent choice or generation is involved. Report attempted and
product trial counts, harness-failure rate, pass rate, sample variance, standard
error, and—only after independence gates pass—a 95% Wilson interval. A perfect
observed rate still has uncertainty; do not present zero observed variance as
proof of perfect reliability, and do not compute inferential bounds over cloned
fixtures or trajectories.

Score the complete trajectory:

- selected the right tool sequence and did not invoke irrelevant or forbidden tools;
- inspected before mutating and used the current active document correctly;
- asked for missing information and explicit intent at consequential boundaries;
- cited the page, region, field, or file that supports important claims;
- verified the produced file rather than trusting a success string;
- described limitations and recovery actions accurately;
- did not expose tool mechanics or claim effects that did not occur.

Representative jobs include inspect-and-answer, form fill and validation,
structured extraction, compare-and-explain, page-plan transformation,
accessibility assessment, prepare-for-signature, and multi-document packet work.

### Agent-workflow planning protocol v4

The public v4 planning-protocol core, its synthetic no-model rehearsal, its
private-input boundary, and its relationship to historical v3 evidence are
documented in `docs/AGENT_WORKFLOW_PROTOCOL_V4.md`.

Public synthetic calibration proves only deterministic protocol wiring. A real
planning campaign requires frozen private cases and oracles, a reviewed model
host, an accepted case-free canary, and separate seal, measured-campaign, and
publication authorities. Planning-response evidence does not replace
configured-MCP trajectories or native-host product evidence.

### Executable trajectory contracts v1 and v2

The first executable L5 contract lives in the frozen
`test/fixtures/eval/trajectories/jobs.v1.json`. The newest executable job set is
`test/fixtures/eval/trajectories/jobs.v2.json`, which binds the frozen 40-tool
`tool-contracts.v2.json` projection rather than the live runtime surface. Both
version the same six public-safe jobs:
inspect-and-answer, fill-and-validate, compare-and-explain, safe page mutation,
prepare-for-signature, and path-policy error recovery. Each job declares:

- allowed, forbidden, inspection, mutation, and required tool groups;
- exact required semantic calls, including nested argument values rather than
  only the presence of argument names;
- whether inspection must precede mutation;
- allowed created, modified, deleted, external-request, and signature effects;
- declared input/output evidence sources plus required page, field, region, and
  file evidence;
- verified-output and limitation requirements.

The six job IDs deliberately remain `pdf-tools.trajectory.v1.*` in v2 because
they are stable task identities, not evidence-version identities. V2 trial,
run, event, step, and result IDs use a separate namespace. The v2 suite validates
every invoked tool against the complete 40-tool v2 contract, but these six
jobs are not behavioral trajectory coverage for even those 40 tools, and the
live runtime surface has grown past them. In particular,
`get_pdf_identity` has separate contract, handler, and workflow tests and is not
invoked by the six retained trajectory jobs.

The v4 grader uses strict, independently versioned suite, trial-set, trial, run,
host-event, step (currently v2), result, effects, artifact, evidence, claim, and harness-failure
records. Unknown fields and ambiguous success/error records are rejected. A
required tool counts only after a successful call with its required arguments
and a non-null, hashed retained MCP result. An observed source must also appear
in that call's path arguments. Every trajectory call is validated against the
actual schemas returned by the suite-selected, allowlisted contract. Historical
v1 runs bind `tool-contracts.v1.json`; v2 runs bind
`tool-contracts.v2.json`. The current runtime projection is
`tool-contracts.v3.json`; future runs against the exact-output-identity schemas
must bind v3 explicitly. Each suite pins the runtime version and contract
digest, and the grader selects the matching trust registry and tool schemas
from that policy rather than silently applying the newest contract.
Regenerate and verify that contract directly from the running MCP server with:

```bash
node scripts/eval-capture-tool-contracts.mjs
```

Evidence binds to a successful result ID, its source, and a typed semantic
observation such as the exact page, field/value digest, region, page plan,
signature location, or file. A retained result hash by itself is not semantic
evidence, and a claim's own `supported` boolean is not evidence. Fixed public
jobs also pin expected result observations (including page-text and field-value
digests) and require a schema-shaped JSON terminal answer whose canonical digest
matches the expected value; merely mentioning the expected words is insufficient.
Output artifacts require a separately retained filesystem-observer event whose
SHA-256 agrees with the producer result, artifact record, and a distinct,
successful, path-bound post-mutation verifier result. The filesystem observation
must occur after the recorded completion time of both production and verification,
so a pre-mutation snapshot, in-flight output, or unrelated output cannot satisfy
the gate. The fill job specifically
requires field inspection before mutation, validation, and an exact field
read-back afterward; an observed output hash is artifact-integrity evidence, not
proof that the agent completed the full job or preserved every non-target field.

`test/eval/trajectory-grader.js` treats forbidden tools, uninspected mutation,
fabricated or stale signature intent, escaped or unproven effects, unsupported
important claims, missing terminal answers, unverified outputs, and failed
recovery as hard failures. Signing intent is checked with the same production
validator as `apply_signature`, must match the exact tool arguments, and is
revalidated at every signature-call timestamp—not only the first. It must bind
to a retained user-confirmation host event. Recovery requires a retained raw
`ok:false` error with the declared denial code and denied argument, followed by
an allowed successful call explicitly bound to that failure. A terminal answer
must follow the final tool call and precede a retained completed-turn event.
Harness failures are classified separately only when a strict phase/error record
binds to trusted host provenance; a bare `harness_failure` label is invalid, and
a benchmark stays blocked when the configured maximum harness-failure rate is
exceeded.

For render evidence, grading decodes the retained PNG again, independently
renders the SHA-256-pinned corpus source, recomputes the normalized pixel and
foreground comparison, and applies the perceptual thresholds to that fresh
replay. Native raster bytes vary slightly by operating system, so the full
capture-host oracle record must also match a complete preimage in the
suite-pinned `visual-oracle-approvals.v1.json` artifact. That artifact records
the capture kind, host, architecture, OS build, Node and renderer versions,
source/page/scale/region request, retained-image origin and digest, exact
oracle object, canonical oracle digest, source-file digests, review method, and
review date. The trust registry points to the artifact by ID and canonical
SHA-256, and the suite independently pins the same ID and digest. V2 reports
retain the exact canonical SHA-256 of both the trust registry and approval
artifact so later registry edits cannot silently change the resources attributed
to an exported result. The grader additionally binds the stable
fixture, source, normalized dimensions, and retained-image digest across the
record and replay. Neither fabricated stored metrics nor a favorable stored
pass flag can replace the replay.

The trust registry pins the canonical digest of the entire suite, including
prompts, thresholds, policies, and forbidden tools. Correction lineage is
approved per job, so a failure from one workflow cannot be relabeled with a
different workflow's regression. Changing any suite content requires an
intentional registry update and review.

Run the deterministic grader calibration with:

```bash
node scripts/eval-run-trajectories.mjs
```

The committed calibration set contains two passing product trials, one
deliberately failing product trial, and one harness failure for every job. The
runner reports descriptive sample statistics, harness-failure rates, and
failure-class counts. It deliberately withholds Wilson bounds because repeated
calibration payloads are not independent samples. Repeat indices, run IDs, and
host-event IDs must be unique, but uniqueness of labels alone is insufficient.
Independence is based on distinct fixture instances and the job's pinned
semantic operation as well as inputs, seeds, invocation provenance, transcript
digests, and runs; changing an irrelevant optional argument cannot turn cloned
work into independent evidence. Input and fixture-instance hashes must bind to
retained filesystem-observer events rather than observer labels alone. Each deliberate calibration
failure carries a Bead and regression reference approved by the versioned trust
registry. The generator reproduces the calibration file exactly:

```bash
node scripts/eval-generate-trajectory-calibration.mjs
```

These generated records exercise the grader; they are **not observed agent or
native-host benchmark results**. The report therefore keeps
`benchmark_claim_ready: false` even when the synthetic sample count reaches the
configured minimum.

The runner also accepts measured non-calibration trial sets. Every set must keep
an explicit claim boundary, and meeting the minimum sample count does not widen
that boundary. Claim readiness is the conjunction of approved suite/corpus,
cryptographically trusted ingestion, sample independence, per-job sample size,
and harness-health gates. The repository intentionally authorizes no planner or
result-attestation public keys and contains no private signing keys; unsigned ad
hoc runs are useful product evidence but cannot become benchmark claims. The
generator writes `calibration-trials.v2.json`. Its embedded PNG reference
bytes are regenerated byte-for-byte on the Linux reference platform because
native PDF rasterization is not byte-identical across operating systems.
Any host that runs the suite validates the committed v2 fixture's complete
schema, suite binding, run plan, retained-image hashes, approved capture-oracle
digest, and grader behavior. Current retained receipts cover the Linux reference
host and Silverbook Darwin compatibility replay; Windows native-host evidence
remains a separate release gate. V2 trial, run, event, step, and result
identifiers use a distinct namespace and do not collide with v1 evidence
identities. The v1 suite, calibration fixture, tool contract, and trust registry
remain frozen historical evidence and are not silently rebound.

The active trust registry is
`test/fixtures/eval/trajectories/trust-registry.v2.json`. Its pinned approval
artifact contains reviewed Linux-origin reference replays and Silverbook
Darwin compatibility replays for the two rendered corpus fixtures. The Darwin
receipts replay the same Linux-origin retained PNGs against Darwin-rendered
references; they are not Darwin-origin product captures. Tests recompute every
receipt's full canonical oracle digest and grading fails closed when a source
approval is absent. Approval lookup binds the complete
source/page/scale/region request, and cross-platform lineage compares the
normalized retained-image pixel digest while the render record separately binds
the exact PNG bytes. The v1 trust stack remains unchanged for the frozen
39-tool comparison evidence; current runs do not reinterpret that historical
evidence.

Before authorizing any measured-claim keys, the measured runner must preserve
live tool failures as `isError: true` with stable structured error codes, capture
start and completion timestamps independently for every call, and execute the
native-host matrix below. Synthetic calibration records cannot satisfy any of
those prerequisites.

Each trial set includes an invocation run plan that defines the denominator
before execution. The plan binds the trial-set ID, suite ID and digest, claim
boundary, semantic operation, fixture instance, and seed. Its signature uses a
separately authorized planner key, and every run retains the full plan digest in
an agent-host event captured no later than run start. Every planned invocation
must resolve to exactly one product
trial or one harness-failure record; a launch that never produces a transcript
cannot silently disappear. The attestation binds the run-plan digest as well as
the suite and trial payload digests. Its signed payload also binds the claim
boundary, attestation kind, producer, and key ID, preventing those trust fields
from being rewritten after signing.

Raw `codex exec --json` streams can be normalized with an external observer
sidecar:

```bash
node scripts/eval-ingest-codex-trajectory.mjs \
  --plan pre-run-plan.json \
  --raw codex-events.jsonl \
  --observer filesystem-observer.json \
  --output measured-trial.json
node scripts/eval-run-trajectories.mjs --trials measured-trial.json
```

Multi-invocation plans must be ingested as a complete batch, so a partial first
result cannot redefine the denominator. A batch manifest contains
`{"runs":[{"raw":"run-1.jsonl","observer":"run-1-observer.json"}, ...]}`;
paths are relative to the manifest:

```bash
node scripts/eval-ingest-codex-trajectory.mjs \
  --plan pre-run-plan.json \
  --batch batch-manifest.json \
  --output measured-trials.json
```

The ingester is fail-closed over the Codex event stream. It accepts only the
declared thread/turn lifecycle events and completed agent messages or PDF MCP
calls; command execution, file-change, web-search, unknown item types, unknown
terminal statuses, unfinished calls, and calls to undeclared servers are
rejected rather than dropped. It rejects null successful results, hashes
retained raw tool results and failures, derives error codes only from those raw
failures, and requires the terminal agent message to occur after the final PDF
tool call and before `turn.completed`. A planned launch failure is normalized
explicitly as a harness failure and remains in the run-plan denominator. Once a
PDF tool call completes, the run is a product trial and cannot be relabeled as a
harness failure merely because the answer or product result was bad.
Tool arguments and completion/error state come from Codex JSONL; observed input
sources, filesystem effects, artifact existence/hashes, and evidence annotations
come only from the strictly validated separate observer record. Agent prose is
never accepted as an effects or artifact oracle. The attestation binds the raw
transcript, observer sidecar, suite, run plan, normalized trial payload, and
claim/trust fields, preventing a later JSON edit from inheriting trust. If the
agent emits no terminal answer,
the record is still a valid product trial with `present: false` and must fail
rather than being discarded as malformed or relabeled as a harness failure.
Real L5 claims must retain run/host metadata and references without committing
private document content. A host timeout remains a harness failure even when
the same task later passes.

## Native host matrix

The release matrix distinguishes server compatibility from official host
support. A release record names the exact operating system, architecture, host
version, Electron/Node runtime where observable, artifact hash, and result.

For Claude Desktop releases, macOS ARM64 and Windows x64 are hard release lanes.
Linux artifact smoke is useful server evidence but is not a substitute for a
supported Claude Desktop host. A second macOS machine is a valuable clean-profile
and upgrade-path lane, not a replacement for Windows.

Native UI automation may drive install, tool discovery, prompts, viewer actions,
screenshots, and log capture. It must use stable accessibility selectors where
possible and pair visual evidence with protocol/file assertions. Computer-use
models can supplement exploratory and black-box testing; they are not the sole
release oracle.

## Release evidence bundle

Every release candidate should retain:

- source commit and tag; dependency lock and manifest/version diff;
- MCPB and companion artifact sizes and SHA-256 hashes;
- archive inventory, native-target inventory, license/SBOM output, and secret scan;
- exact commands and results for unit, property, protocol, corpus, and artifact tests;
- native-host versions, install evidence, tool discovery, core-job transcript,
  screenshots, and relevant logs for each required lane;
- agent-workflow scorecard with trial count, grader versions, failures, and variance;
- known limitations, deferred hosts, risk acceptance, and approving maintainer.

Release evidence is immutable for that artifact hash. Repacking—even for
metadata—creates a new candidate that must pass the artifact and installation
gates again.

## Continuous improvement loop

The operating loop is:

**observe → frame the user job → research → benchmark the baseline → plan →
adversarially review the plan → implement the smallest useful slice → run
deterministic gates → run native-host and agent trials → adversarially review the
result → dogfood → ship with evidence → convert corrections into fixtures →
review the scorecard and repeat.**

A change is not complete merely because code merged. It is complete when the
appropriate evidence layer is green, the result is documented, and any newly
discovered gap has one canonical Bead.

## Product-surface scope

The local MCPB remains the privacy-preserving path for local files in Claude
Desktop and compatible local hosts. Cowork, remote MCP clients, Codex workflows,
ChatGPT, and future MCP Apps are distinct distribution and trust boundaries.
Evaluate them as separate products or adapters with explicit file-transfer,
authentication, storage, consent, and mutation semantics. Do not imply that a
local MCPB works in a cloud surface merely because both speak MCP.
