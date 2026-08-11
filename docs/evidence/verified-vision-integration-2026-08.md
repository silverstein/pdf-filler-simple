# Verified-vision integration evidence — 2026-08

Status: B5 local integration candidate; synthetic verification evidence plus a
private aggregate operational recheck

Bead: `pdf-toolkit-mcp-14o.6`

## What is integrated

On an opt-in table abstention path, `convert_pdf_to_markdown` emits a bounded
source-bound proposal packet without removing the typed abstention. The
read-only `verify_table_proposal` tool reparses the current PDF and treats the
submitted structure as untrusted. It checks source and region identity,
complete one-cell coverage, conservative row and column order, independent
header evidence, rectangular-grid validity, cut consistency, agreement with
available source-replayed rulings, and ambiguity. Rejected proposals emit no
cells or Markdown. Accepted cells are built only from the fresh PDF text layer
and include a deterministic GFM projection.

## Authored synthetic results

The committed suite contains six proposals over three locally generated,
born-digital PDFs:

| Class | Result |
|---|---:|
| Authored recoverable control | 1 accepted / 1 submitted |
| Seeded known-wrong topology | 3 rejected / 3 submitted (100%) |
| Deliberately ambiguous topology | 2 rejected / 2 submitted (100%) |
| All submitted proposals | 1 accepted, 5 rejected / 6 submitted |

The one accepted table has 11 structured cells containing 55 source characters.
Comparison with the authored truth found 0 character errors: exact source-cell
content agreement was 55/55 (1.0). This is the content component commonly
described as GriTS-Con, but the denominator here is one small authored table;
it is not a model or corpus benchmark.

Among the three known-wrong proposals, the B2 coverage/order/header predicates
alone reject 1/3 (33.3%). The full verifier rejects 3/3 (100%): B3 grid and
ruling consistency supply the two additional catches. The two ambiguous
proposals are reported separately and both remain rejected. The authored
recoverable control is 1/1 accepted; that is fixture coverage, not a real-world
recovery-rate estimate.

These denominators and the zero-content-error comparison are enforced by
`test/verified-vision-verifier.test.js`, not calculated only in this note.

## Private aggregate operational recheck

`scripts/eval-probe-table-abstention-frequency.mjs` repeats the original
deterministic, evenly spaced 90-document sampling method over a locally chosen
directory, reading at most the first six pages per PDF. It uses the actual MCP
server over stdio and emits only aggregate counts and gap histograms. It never
prints or retains file names or PDF content.

The resulting counts are operational frequency evidence only. The directory is
unlabeled, selection-biased, and may change over time; first-six-page sampling
undercounts later tables, and the Markdown separator detector is only a routing
heuristic. These counts must not be combined with the authored suite into an
accuracy, recovery, or benchmark claim.

The 2026-08-11 integration run found 923 PDFs in the private directory and
sampled 90 deterministically. All 90 completed without an encrypted, oversized,
or other tool error. Fifteen sampled documents had a table signal; all 15
retained `TABLE_TOPOLOGY_UNKNOWN` and none emitted a reconstructed Markdown
table. Six were classified as lacking independent header evidence and nine as
having unreconstructable column topology. No file names or content were emitted
or retained. Claude's earlier same-day run found 14 signal documents (six
header, eight topology) in its then-current deterministic sample, so the
one-document difference is recorded as corpus/sample drift rather than a
product improvement or regression. This probe measures where the existing
converter abstains; it does not exercise a model-generated proposal or measure
verified recovery.

## Package and contract checks

- both tools are registered in tool discovery;
- `verify_table_proposal` advertises all four read-only/closed-world MCP
  annotations;
- success and typed error schemas are advertised and validated;
- server/share mirrors are byte-identical;
- default conversion remains byte-identical when proposal emission is absent;
- rejected results carry `table: null` and no GFM table content;
- accepted GFM includes its format, span policy, UTF-8 byte count, and SHA-256.

Pre-commit integration checks:

- focused verified-vision, discovery, schema, annotation, and share-contract
  gate: 5 files passed, 89 tests passed;
- documentation, packed-manifest, and SBOM claims: 3 files passed, 107 tests
  passed;
- focused verifier evidence: 1 file passed, 14 tests passed;
- transactional share contract: 44 tools, 14 prompts, 122 SBOM components,
  reproducible SHA-256
  `5a2b356babd2b3266fa37a990ba6c34365d229fa6feba38413ae57e31eb946aa`.

Aggregate result on exact clean integration checkpoint
`ccf6a77d9b962704cbfc58041767b9fdabad7c80`:

- `npm run test:all` completed its Vitest partition with 143 files passed, 9
  failed, and 7 skipped; 2,360 tests passed, 21 failed, and 152 skipped.
- Every failure was a pre-existing fixed wall-clock or test timeout under a
  16-core shared host at approximately 48 load: 5-second, 10-second, 15-second,
  180-second, or 240-second ceilings. The four exact 15-second assertions
  missed their bounds by 5–15 ms. No verified-vision test or wrong-result
  assertion failed.
- Per the aggregate runner contract, the native partition did not run after
  Vitest returned nonzero. Run separately on the same clean checkpoint,
  `npm run test:node-native` passed 61 tests, skipped 10 platform-specific
  tests, and failed 0.
- Aggregate-gate resource stability is tracked separately as
  `pdf-toolkit-mcp-an4`; this evidence does not relabel the red aggregate run as
  a pass or weaken the containment deadlines.

## Claim boundary

- `benchmark_claim_ready: false`
- `calibration_claim_ready: false`
- `production_claim_ready: false`
- synthetic, local, born-digital verification fixtures only
- no model, OCR system, or network service was evaluated
- accepted content is proven source-derived for the reparsed text layer
- accepted topology is verified as consistent with available replayed evidence
- no claim that the topology is unique or semantically correct
- no real-world accuracy or recovery-rate claim
