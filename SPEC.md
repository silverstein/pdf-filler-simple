# SPEC — Verified Vision prerequisite: bounded ruling-segment evidence

Bead: `pdf-toolkit-mcp-14o.8`
Branch: `codex/verified-vision-ruling-evidence`
Stack base: B2 exact SHA `082120f` (which already carries local B0+B1).

## Objective

Preserve the axis-aligned straight ruling segments that the PDF.js operator list already exposes, instead of retaining only closed rectangles and aggregate path counts. B3 needs this source-derived geometry to distinguish an authored merged header span from an invented cut that conserves identical text.

## Contract

- Add `ruling_segments` to each Extraction IR page and bump the additive IR version from 1.5.0 to 1.6.0.
- Each retained item records deterministic top-left PDF.js viewport points: orientation, start/end coordinates, and source operator index.
- Retain only painted stroke-bearing straight segments after the exact graphics/display transform; reject curves, diagonals, degenerate lines, and non-finite geometry.
- Normalize orientation and endpoint order; deduplicate within the existing 0.5-point ruling tolerance.
- Bound each page with a named cap and typed observed/returned/truncated accounting.
- A parser/operator failure yields unavailable evidence with no retained geometry. Output-budget omission yields unavailable+truncated and exact observed counts.
- Extend the independent second parse so an available or typed-omitted claim must match a fresh operator-list replay.
- Add the bounded segments to B1 proposal packets and their per-region truncation accounting. Existing abstention and default-off Markdown behavior remain unchanged.

## Proof target

On the synthetic line-ruled and merged-header fixtures, evidence must be deterministic and sufficient to observe that the vertical header cut is absent across the authored merged span while body-row cuts remain present. This lane exposes evidence only; B3 owns the proposal-vs-evidence decision.

## Constraints

- No model, OCR, network, inference, numeric confidence, mutation, or public release.
- No trust in B1 packet geometry: B2/B3 always regenerate it from source.
- Source/share byte parity and all IR-version pins remain aligned.
- Existing fields and fail-closed reconstruction behavior remain unchanged apart from the additive field/version.

## Acceptance

Focused tests prove transformed line capture, diagonal/curve refusal, deterministic ordering/deduplication, cap/output-budget typing, independent replay tamper rejection, source/share schemas, exact fixture geometry, unchanged Markdown/gaps, and B1 packet propagation. Run layout, Markdown, B0-B2, source-replay, schema, packaging, and share gates before closing.
