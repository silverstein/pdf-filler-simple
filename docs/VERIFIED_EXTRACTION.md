# Verified extraction workspaces

Verified extraction is an experimental, model-free PDF Tools workflow for
turning a local PDF into schema-shaped values with replayable source evidence.
It does not ask PDF Tools to guess a completed object. Instead, the MCP host or
agent proposes one schema leaf at a time, cites exact bytes from source-bound
chunks, and asks PDF Tools to replay the claim deterministically.

## Workflow

1. Call `create_extraction_workspace` with a local `pdf_path`, a short
   `workspace_id`, and a supported JSON Schema object. PDF Tools reads every
   admitted page locally, binds the exact PDF and schema bytes, compiles the
   schema's leaf obligations, and creates a private transactional workspace.
2. Call `read_extraction_workspace` for `document_map_chunks` and
   `pending_leaves`. Use its cursor when `next_cursor` is non-null.
3. Call `read_extraction_chunk` with the same PDF path and one returned
   `chunk_id`. PDF Tools reparses the current PDF and refuses source drift or an
   omitted/unknown chunk.
4. Call `submit_extraction_proposal` with one pending JSON Pointer, a proposed
   JSON value, the exact current generation, and the chunks used. The proposal
   is retained as `unverified`; caller text, geometry, or confidence is never
   treated as proof.
5. Call `verify_extraction_proposal` with the proposal generation/event,
   citations expressed as exact UTF-8 byte ranges plus quote SHA-256, and one
   supported method. PDF Tools reparses the PDF and schema, replays the quoted
   bytes, derives the typed result, and appends that result as a new immutable
   generation.
6. Read `results` and `pending_leaves`, or call
   `inspect_extraction_state`. A citation or missing-chunk failure leaves the
   leaf pending so a corrected proposal can be submitted. A settled result
   closes the leaf and rejects later replacement.
7. Call `delete_extraction_workspace` only with the exact current workspace
   identity, exact current generation, and `confirm: "DELETE"`.

## Supported verification methods

- `exact_projection`: a value is projected from one replayed citation using a
  supported literal normalization.
- `calculation`: an exact rational calculation is derived from replayed inputs.
- `interpretation`: a typed, source-supported interpretation remains visibly
  distinct from an exact projection.
- `ambiguous`: competing replayed values are retained as typed uncertainty.
- `not_found`: allowed only with `null`, no citations, the complete returned
  chunk set, and complete admitted page/search coverage.

The verifier returns typed statuses such as `verified_exact`,
`computed_with_inputs`, `source_supported`, `ambiguous`, `not_found`,
`citation_mismatch`, `chunk_missing`, and `unverified_reasoning`. It does not
return numeric confidence.

## Privacy and boundaries

- PDF parsing, workspace state, citation replay, and verification happen
  locally. The MCP server makes no model or provider call.
- Content returned through MCP may still be sent by the selected host to its
  model provider. The host/provider data terms therefore remain relevant.
- Workspace data lives under
  `~/.pdf-toolkit-files/verified-extraction-workspaces` (or the configured
  private profiles root), not beside the source PDF.
- POSIX hosts require physical `0700` workspace directories and `0600` state
  files. Windows does not expose useful POSIX permission bits through Node, so
  the workflow instead relies on the current-account ACL of the configured
  private profiles root while retaining physical-file, canonical-path,
  no-symlink, file-index, size, timestamp, and digest checks.
- Retained files are individually flushed before publication on every host.
  Node cannot portably `fsync` NTFS directories, so Windows does not claim the
  same power-loss directory-metadata guarantee as POSIX hosts; process-crash
  recovery and fail-closed generation replay remain enforced.
- The source PDF must remain inside the configured allowed-directory boundary.
  The private workspace root cannot widen that boundary.
- This surface does not run OCR. Raster-only or truncated evidence stays a gap;
  `not_found` cannot pass when admitted search coverage is incomplete.
- Arrays are one leaf obligation in this first version. It verifies the array
  value as a whole and supports exact uniqueness or keyed-item schema checks;
  it does not expose per-index editing.
- Verification proves the stated replay or calculation under the exact local
  inputs. It is not legal review, semantic completeness, model-quality proof,
  or a public benchmark claim.

## Recovery and retention

Every mutation publishes an append-only generation under an exclusive local
transaction. Inspection reports incomplete or active transaction state rather
than silently repairing it. The current public tools intentionally expose the
ordinary create/read/propose/verify/delete lifecycle; maintainers use the
lower-level exact recovery functions for a crashed mutation after inspecting
its retained transaction authority. No automatic pruning occurs.
