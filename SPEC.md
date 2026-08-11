# SPEC — Verified Vision B1: proposal-packet emission

Bead: `pdf-toolkit-mcp-14o.2` (child of epic `pdf-toolkit-mcp-14o`)
Branch: `claude/verified-vision-b1-proposal-packet` (refreshed onto `origin/master` @ 0600e32, which now carries IR 1.5.0, painted_rectangles, and both table gap codes; original implementation base was `windows-canvas-latch` @ d734f74).
Lane host: silvercloud VM. node_modules is a symlink to the canonical clone — do NOT run npm/pnpm install here.

## Context (why this lane exists)

Epic `14o` adds a two-tool "verified vision" flow: extraction emits a *proposal packet* for each table region it abandons; the host model proposes a table structure; a later read-only `verify_table_proposal` tool (bead `14o.3`/B2) deterministically accepts or rejects it. This lane (B1) builds **only the packet-emission half**. B2/B3 (the verifier) are separate lanes.

B0 measurement (bead `14o.1`) established the go signal: on a 90-doc real-world sample, 14 docs had detectable tables and **all 14 abstained, 0 reconstructed**; abstention causes split 8 topology-unreconstructable / 6 no-header-evidence (all `TABLE_TOPOLOGY_UNKNOWN`). Packet emission must fire on exactly the `TABLE_TOPOLOGY_UNKNOWN` / `TABLE_RULING_UNSUPPORTED` abandonment points.

## Objective

When `convert_pdf_to_markdown` abandons a table region (emits `TABLE_TOPOLOGY_UNKNOWN` or `TABLE_RULING_UNSUPPORTED`), also emit — behind an opt-in flag — a bounded, deterministic **proposal packet** per abandoned region containing everything the host model needs to propose a structure and everything B2 needs to verify one:

- `region_id` — stable within the document (e.g. `p{page}-t{ordinal}`), deterministic.
- `page` (1-based) and the region bounding box, with an explicit `coordinate_space` label matching what the IR/renderer uses so the agent can feed it to `render_pdf_region`.
- `text_items[]` — the region's items with boxes (`quad`/`bbox`/`raw_transform`), `text`, `reading_order_index`, `line_id`, `column_index`. Content the model assigns to cells; the model never transcribes — B2 fills cells from these items.
- `ruled_rects[]` and `painted_rectangles[]` intersecting the region (evidence for B3's ruled-line-agreement / cut-line checks).
- `header_hints` — whatever header-relevant signal the IR already exposes (line heights, first-row band). B1 does NOT decide the header; it ships the evidence so B2 can check header evidence independently of the model's say-so.
- `proposal_token` = SHA-256 hex over a canonical string of `(source_sha256, ir_version, region_id)`. Binds the packet to this exact document + IR so a proposal cannot be verified against a different document, and a source change between propose and verify invalidates it.

Design decision: **do NOT embed a rendered image in the packet.** Ship `page` + region bbox + `coordinate_space`; the agent renders the region itself via the existing `render_pdf_region` tool. This keeps B1 deterministic, bounded, and free of a canvas dependency, and keeps each tool single-purpose.

## Hard constraints (non-negotiable — these are the epic's moat)

1. **No model / OCR / network in the server.** This lane emits data only; it never calls a model.
2. **Opt-in, default-off.** New boolean arg `emit_table_proposals` (default `false`) on `convert_pdf_to_markdown`. When false/absent, the tool result is **byte-identical** to current behavior. Add it to the handler's `allowedArguments` set and the input schema.
3. **Deterministic.** Packet is a pure function of source bytes + options. No timestamps, no RNG, stable key ordering. `proposal_token` reproducible.
4. **No numeric confidence.** Typed fields/statuses only (`available`/`truncated`/`unavailable`), consistent with the `confidence: "not_calibrated"` house style.
5. **Do not weaken any existing gap or fail-closed guarantee.** The abstention still happens and still emits its gap; the packet is purely additive alongside it. The reconstructed-table path is untouched.
6. **Pinned pdfjs 5.4.624 stays pinned.**
7. **Bounded.** Cap items per region and regions per document with named constants and typed truncation, mirroring the IR's `max_items` discipline. Over-cap emits typed truncation, never unbounded output.
8. **Share-mirror parity.** Mirror any `server/*` change into `pdf-toolkit-mcp-share/` and pass `npm run test:contract:share`.
9. **Extend both validators.** If the packet enters the IR/renderer output, it must survive `validateMarkdownConversionSemantics` (and, if it touches the IR, the layout semantic + source-evidence second parse). Prefer computing the packet in the renderer/handler from existing IR fields WITHOUT changing the IR schema.

## Files in scope

- `server/markdown-conversion.js` — the abandonment points (search `TABLE_TOPOLOGY_UNKNOWN` / `TABLE_RULING_UNSUPPORTED`, ~lines 600/2010-2027 region) and the three table paths (text-column grid `tableStructureCells`; ruled-rect grid; solid-mask grid). The renderer is pure (no I/O) — compute region descriptors here from the layout it already holds, gated behind an internal option so default output is unchanged. Update the `LIMITATIONS` table paragraph only if wording must change (prefer not to for B1).
- `server/index.js` — `convert_pdf_to_markdown` case (~line 4512 region): new opt-in arg; assemble packets from the renderer's region descriptors + `source.sha256` + IR version (`EXTRACTION_IR_IDENTITY`/`IR_VERSION`); compute `proposal_token`; attach `table_proposals` to the payload only when opt-in.
- `server/layout-extraction.js` — read-only source of `raw_items`, `ruled_rects`, `painted_rectangles`, geometry, and the IR version constant. Do NOT change the IR schema unless strictly necessary.
- `server/output-schemas.js` — new structured sub-schema for the packet; wire into the `convert_pdf_to_markdown` success schema; extend the semantic validator if the field is present.
- `docs/OUTPUT_SCHEMAS.md`, `docs/MCP_CONTRACT.md` — discovery-matrix row / truthfulness paragraph may be finished in B5, but leave a clear TODO marker.

## Acceptance tests (exact)

Add `test/verified-vision-proposal-packet.test.js` (Vitest, ordinary project). Assert:

1. **Default off byte-identical**: with `emit_table_proposals` absent/false, `convert_pdf_to_markdown` structured result + markdown equal current output on `table-ruled-merged-negative.pdf`, `table-ruled-lines.pdf`, `table-ruled-grid.pdf`.
2. **Emission on abstention**: flag on, `table-ruled-merged-negative.pdf` emits exactly one packet with the merged-span region's items, ruled/painted evidence, page, bbox, header_hints, and a token.
3. **No emission on success**: `table-ruled-grid.pdf` (reconstructs) emits zero packets.
4. **Token binding**: `proposal_token` is a pure function of source sha + IR version + region_id; identical across two runs; differs across fixtures.
5. **Determinism**: two runs byte-identical (packet JSON stable-ordered).
6. **Per-region bounded**: a synthetic/forced over-cap region emits typed truncation, not unbounded items.
7. **Per-document bounded**: a forced over-cap region list emits reconciled returned/omitted counts instead of silently slicing packets.
8. **Gap coverage fails closed**: an opt-in result cannot report a table-abandonment gap for a page while providing no source-bound proposal region for that page.

Run gates in this worktree (must be green, paste real output in the handoff):
- `npm test -- --run test/verified-vision-proposal-packet.test.js`
- `npm test -- --run test/convert-pdf-to-markdown.test.js test/markdown-conversion.test.js`
- `npm run test:contract:share`

The intelligence fixtures above already exist and suffice for B1; B0's dedicated `test/fixtures/eval/verified-vision/` suite is only needed for B5 evidence.

## Forbidden actions

- No release, tag, or push to a public remote. Local commits only.
- Do not edit `.beads/` here (control tower owns bead state on the canonical clone).
- Do not run npm/pnpm install (node_modules symlinked).
- Do not touch `vendor/qpdf-wasm/runtime/`, the pinned pdfjs version, or unrelated tools.
- No model/OCR/network dependency.

## Definition of done

All eight acceptance assertions pass; convert/markdown/share suites green; opt-in default-off proven byte-identical; packet deterministic, bounded at both region and document level, token-bound, header-hint-bearing, and additive to (never a replacement for) the abstention gap. Hand back to control tower for review before integration (B5).

## Adversarial notes carried from the plan

- The 6 no-header-evidence real-world cases are where header misclassification (a text-conserving error) hides. B1 ships header evidence; it does not decide headers.
- The packet is untrusted-input bait for B2: B2 must re-derive geometry from source bytes and must not trust packet contents. Do not design the packet in a way that tempts B2 to trust it.
- Historical base correction: the first lane was moved from stale local `master` to `windows-canvas-latch` because the needed extraction machinery was absent from that local branch. Refreshed remote `origin/master` now contains the machinery, so that dependency is resolved. Any future refresh still changes the review SHA and requires fresh exact-SHA gates.
