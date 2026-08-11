# SPEC — Verified Vision B2: source-replayed proposal verifier

Bead: `pdf-toolkit-mcp-14o.3` (child of epic `pdf-toolkit-mcp-14o`)
Branch: `codex/verified-vision-b2`
Stack base: B1 exact SHA `b063563` plus B0 fixture commit `0532438`; both local-only and based on `origin/master` `0600e32`.

## Objective

Add a read-only `verify_table_proposal` tool. The caller submits only a source path, B1 region/token identity, and structural cell assignments. The tool reparses the current source PDF, regenerates the abandoned region from the validated extraction IR, and accepts only when the B2 renderer predicates pass.

The tool never accepts caller-supplied text, geometry, header evidence, or packet contents. Accepted cell text is deterministically constructed from source text items.

## Input contract

- `pdf_path` (absolute or `~/`), optional `password`.
- `region_id` in B1 form `p{page}-t{ordinal}`.
- `proposal_token`: B1 SHA-256 binding over `(current source sha256, current IR version, region_id)`.
- `cells[]`: bounded objects containing `row`, `column`, `rowspan`, `colspan`, and `item_ids[]`. No text or geometry input is accepted.

## B2 checks

1. Reparse the exact source through the existing PDF.js subprocess and independent source-evidence replay.
2. Regenerate B1 proposal regions for the target page and bind the requested region by deterministic `region_id`.
3. Recompute and constant-time compare the proposal token.
4. Refuse truncated region evidence.
5. Require every non-whitespace source item in the region exactly once: no unknown, duplicate, or missing item IDs.
6. Require a source line's items to remain in one proposed row.
7. Require proposed rows and columns to be monotone in source reading order.
8. Require the existing independent first-row line-height evidence; the model cannot declare its own header.
9. Construct accepted cell text only from source item text in source reading order and assert that construction before returning it.

B3 deliberately owns rectangular tiling, global x/y cut consistency, ruling-line agreement, and dual-valid ambiguity rejection. A B2 acceptance is therefore `renderer_predicates_passed`, not a final verified-table claim.

## Result contract

Return a typed, numeric-confidence-free result:

- `status: "accepted" | "rejected"`
- `reason_codes[]` from a bounded `TABLE_PROPOSAL_*` vocabulary
- current source and IR identity, region identity, and `source_reparsed: true`
- per-check `passed | failed | not_run` statuses
- `table` only on acceptance, with source-derived cell text and source item IDs
- an explicit claim boundary: content is source-derived; topology is not proven unique and still requires B3

Token/region failures are ordinary typed rejections. Source I/O, password, resource, or semantic-validation failures remain typed tool errors under existing server policy.

## Hard constraints

- No model, OCR, network, mutation, saved output, session state, numeric confidence, or caller-supplied content.
- Read-only/destructive false/idempotent true/open-world false annotations.
- Named input bounds and strict unknown-argument rejection.
- Source/share byte parity for every runtime file.
- The pdfjs version and IR identity remain unchanged.
- No public push, merge, release, external send, or claim-language approval in this lane.

## Acceptance tests

Add `test/verified-vision-verifier.test.js` and prove:

1. Tool discovery and read-only annotations.
2. A valid token is recomputed from the reparsed source, never trusted from packet fields.
3. Source mutation/token mismatch rejects.
4. Missing, duplicated, and unknown source items reject with distinct typed reasons.
5. A source line split across proposed rows rejects.
6. Non-monotone row/column assignments reject.
7. Uniform-header evidence rejects the authored-looking borderless proposals.
8. A pure unit case with independent taller-first-row evidence accepts and returns only source-derived content.
9. Caller-supplied text/geometry and unknown arguments are refused.
10. Deterministic repeated verification is byte-identical.

Run the focused verifier suite, B0/B1 suites, conversion/Markdown regressions, share contract, and diff checks. Full `test:all` remains the B5 integration gate.

## Definition of done

The new tool is callable and schema-valid in source and share mirrors; it reparses source, binds token/region identity, passes the B2 predicates, returns deterministic typed rejection or source-derived acceptance, and makes no final topology claim. Exact-SHA focused/regression/share gates are green and Bead `14o.3` records the local evidence.
