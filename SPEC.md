# SPEC — Verified vision B4: source-backed Markdown projection

Bead: `pdf-toolkit-mcp-14o.5`
Branch: `codex/verified-vision-b4`
Stack base: B3 exact SHA `ef83d43` (local B0-B3 plus ruling-evidence prerequisite).

## Objective

Turn an accepted, source-replayed table proposal into useful GFM Markdown in the same `verify_table_proposal` response. Reuse the conversion renderer's table escaping rather than introducing a second Markdown dialect. Rejected proposals continue to return no table or Markdown, and ordinary `convert_pdf_to_markdown` calls continue to abstain exactly as before unless the caller opts into proposal packets.

## Projection contract

- Cell text remains exact reading-order concatenation of reparsed source text items. The caller cannot supply text, geometry, Markdown, or confidence.
- Build the rectangular GFM projection from the verifier's accepted structured cells only after every B2/B3 check passes.
- Escape GFM syntax through the existing Markdown conversion path. Escaping is syntax protection, not inferred document content.
- GFM cannot represent row or column spans. Preserve the accepted spans in structured cells; place source text only in the span's anchor slot and leave continuation slots empty. Never duplicate or invent cell content to simulate a span.
- Return typed format and span-projection metadata plus Markdown bytes and SHA-256 so the result is deterministic and independently checkable.
- Include the GFM table in the human-readable tool result only for accepted proposals. Rejections continue to say that no table content was emitted.

## Honest limitation

Update the conversion table limitation to name the verified-proposal route without weakening existing fail-closed reconstruction. State that the verifier proves source-backed content and consistency with available source-replayed rulings, not unique topology. State the GFM span projection explicitly.

## Evidence target

- The accepted ordinary ruled fixture emits a deterministic GFM table whose visible cell values come from the source text layer.
- The accepted merged-header fixture emits its source text once at the spanning cell's anchor and empty continuation slots; structured row/column spans remain intact.
- Markdown metacharacters in source cell text are escaped by the shared conversion renderer.
- Rejected, stale, ambiguous, and invalid proposals emit no Markdown.
- Default conversion without an accepted proposal remains byte-identical and retains its typed abstention gap.

## Acceptance

Focused verifier, Markdown conversion, schema, MCP contract, source/share parity, packaging, and retained-evidence gates pass on the exact committed tree. B4 remains local-only; integration, push, release, external communication, and public claim language remain protected gates.
