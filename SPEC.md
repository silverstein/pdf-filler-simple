# SPEC — Verified vision B3: deterministic grid consistency

Bead: `pdf-toolkit-mcp-14o.4`
Branch: `codex/verified-vision-b3`
Stack base: ruling-evidence exact SHA `0598f7b` (local B0-B2 plus 14o.8).

## Objective

Extend the source-replayed `verify_table_proposal` gate from B2 content/ordering predicates to a deterministic structural-consistency proof. Accept only a rectangular proposed grid whose assignments agree with every preserved source ruling segment. This proves consistency with available evidence, never unique topology.

## Checks

- **Rectangular grid:** proposed row/column spans must tile one bounded rectangle exactly once. Holes, overlaps, empty outer dimensions, duplicate anchors, and out-of-bounds spans reject.
- **Global cuts:** source-replayed interior horizontal/vertical rulings define ordered cuts. Proposed dimensions and assigned item boxes must agree with those cuts; items cannot escape their proposed span.
- **Ruling agreement:** for every source cut and every row/column band, a source segment must exist exactly when the proposal places a cell boundary there. A ruling may neither bisect a proposed cell nor be absent where the proposal invents a boundary.
- **Header evidence:** a complete source ruling between proposed rows 0 and 1 is independent header-band evidence, alongside the existing taller-first-row predicate.
- **Ambiguity:** regions without ruling-segment evidence remain structurally ambiguous and reject. The verifier is stateless and does not remember prior proposals; it derives this refusal from the regenerated source region itself.

## Wire contract

- Add typed B3 checks and rejection reasons; bump verifier identity to 0.2.0.
- Update the claim boundary: accepted content is source-derived and the grid is consistent with all source-replayed geometry, but consistency is not uniqueness.
- No numeric confidence, caller geometry/text, state, model, OCR, network, mutation, or acceptance based on packet evidence alone.
- Existing B2 failures remain independently visible; B3 checks do not erase earlier reasons.

## Evidence target

- The authored merged-header proposal accepts because x=372 has no header-band segment and the cell spans columns 1-2.
- The text-conserving invented header cut rejects because it requires x=372 across row 0 where the source has no segment.
- The line-table two-column merge rejects because x=372 bisects its merged second column.
- The existing row split remains rejected by B2 line non-straddle.
- Both borderless alternatives reject as ambiguous.
- Report the seeded text-conserving catch delta explicitly: B2 structural predicates alone do not distinguish the authored/invented merged cut or the column merge; B3 ruling checks catch both.

## Acceptance

Focused source-replay, verifier, adversarial baseline, schemas, source/share parity, tool-contract, packaging, and aggregate release gates pass on the exact committed tree. B3 remains local-only; integration, push, release, and public claim language remain protected gates.
