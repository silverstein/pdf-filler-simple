# Verified-vision adversarial baseline — 2026-08

Status: historical B0 synthetic baseline; superseded for integration evidence
by `verified-vision-integration-2026-08.md`

Control ref: `origin/master` at
`0600e32466bdfb25552841b93686fb79069e8128`

Bead: `pdf-toolkit-mcp-14o.1`

## What this evidence establishes

The dedicated `pdf-tools.verified-vision.baseline` suite freezes three authored,
born-digital PDF cases:

- a line-ruled table that current conversion detects but refuses because header
  semantics are not independently established;
- a ruled table with an authored merged header that current deterministic
  conversion refuses because it cannot establish the topology; and
- a borderless, uniformly styled region with multiple plausible structures
  whose correct truth is continued abstention.

The paired proposal manifest carries six authored proposals: one conditional
recoverable control, three known-wrong text-conserving topologies, and two
materially different plausible structures for the abstention-truth fixture.
Every proposal assigns every source text occurrence exactly once. That proves
the intended adversarial point: perfect text coverage does not prove a table's
structure.

## Exact fixture identities

| Fixture | Bytes | SHA-256 |
|---|---:|---|
| `table-ruled-lines.pdf` | 2,790 | `7b8e2d148c506eb3cfd8a0ca0bcae8d9d9549caadce2162476305cb8bbf547e7` |
| `table-ruled-merged-negative.pdf` | 2,759 | `abca089a1f67c7d0cfbd6c5345f8a80e006452dddec630295ee356bab59f6d70` |
| `table-borderless-ambiguous.pdf` | 2,406 | `77bab77059e25deb33f7551524399788fffe3a61fec37303cca3c5cbecc40989` |

The generator reproduced all three byte-identically in two independent
directories during the focused test.

## Adversarial discovery

The current layout IR returns closed `ruled_rects` and counts path segments,
but it does not preserve the coordinates of individual ruling lines. On the
merged-header fixture, the authored two-column span and an invented third-cell
split conserve identical source text. The current closed-rectangle evidence
cannot distinguish them.

This is now tracked by `pdf-toolkit-mcp-14o.8`, which blocks B3. The authored
merged proposal is therefore only an **acceptance target conditional on that
source-replayed ruling evidence existing**; this baseline does not assert that
the current product can verify it.

## Verification

- `npm test -- --run test/verified-vision-baseline.test.js`
  - 1 file passed; 8 tests passed, including source-text binding and seeded drop/duplicate mutations.
- `npm test -- --run test/extraction-intelligence-baseline.test.js`
  - 1 file passed; 8 tests passed.
- `npm test -- --run test/verified-vision-baseline.test.js test/extraction-intelligence-baseline.test.js`
  - 2 files passed; 16 tests passed.

## Claim boundary

- `benchmark_claim_ready: false`
- `calibration_claim_ready: false`
- `production_claim_ready: false`
- synthetic, local, born-digital fixtures only
- no model was evaluated
- no real-world recovery rate was measured by this suite
- no claim of uniquely proven topology

The previously recorded 90-document aggregate is separate problem-frequency
evidence. It is selection-biased, was limited to the first six pages, and was
measured on an older IR. It must be re-confirmed on the integration IR before
B5 and cannot be combined with this synthetic suite into a benchmark claim.
