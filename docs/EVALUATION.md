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

The v0 scorers cover parseability, exact page and form-field counts,
tolerance-bounded media/crop boxes, rotation, basic per-page text extraction
through an independent parser, exact created/modified/deleted file sets, and
source-file immutability. The development corpus includes a
visibly reversed two-page PDF: it remains non-empty, parseable, and has the
correct page count, but the geometry scorer rejects the swapped page order.
This is the minimum adversarial guard against tests that only prove a PDF was
written.

## Scoring contracts

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
trials when agent choice or generation is involved and report both pass rate and
variance.

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
