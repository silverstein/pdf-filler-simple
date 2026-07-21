# PDF mutation fidelity verified run

This summary records the first passing run of the strict mutation-fidelity
benchmark using report and run-index schema version 2. It supersedes the first
red baseline as current source-server evidence, while retaining that baseline
as historical evidence of the defects the benchmark found.

## Result

- Generated: 2026-07-21T20:27:01.599Z
- Planned cells: 24
- Observed unique cells: 24
- Completed cells: 24
- Harness failures: 0
- Product failures: 0
- Report validity: valid
- Overall result: pass
- Source-server revision: `10d11e05698da6b9d6340315b0072ab71ac8fdb4`
- Engines: pinned PDF.js/canvas product lane and Poppler 24.02.0 independent lane
- Rendering: 144 DPI, full-page comparison before intended-region classification

All three fresh-process repetitions passed every required hard gate for all
eight cases:

- fill an AcroForm field to a new output;
- stamp text while protecting unrelated content;
- stamp text on a rotated and cropped page;
- prepare a signing packet without applying a signature;
- reorder and rotate pages while preserving reachable form fields and metadata;
- merge and split while preserving page lineage, reachable forms, and the
  declared document-level metadata policy;
- perform two same-path fills while retaining one immutable original backup;
- fail closed after the recorded original backup is removed.

The independently recomputed verifier accepted the canonical bundle. The
adversarial verifier then rejected four hostile variants: mutated artifact
bytes, a symlinked artifact parent, a re-signed report with a stale score, and a
re-signed index with a false denominator.

## Artifact bindings

The full report and generated PDFs remain in maintainer-held private evidence
storage. The privacy-reviewed public summary is bound to them by SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| Raw report | `ef2653dd3b8aad5cfcc0a8bbd26fe3ed2875471bdce191e39122dbc3d384ef4a` |
| Conjunction score | `9746ce48484e5f318f5c2175e454a4dfb0b5f339d86a8c9de89a493196833445` |
| Run index bytes | `de973d14e4ca9ea62f976a6467c7226957f78afe6746e08eb9c08c641b51928b` |
| Canonical run identity | `55b483c270eb4b35af0f77daf55f5d7a15d7f2a77608515f66c71e0761be0c0b` |
| Manifest | `0a540aa22b78eaf9f3bf36b010779374965a14f25461503bdfc84dd420cf4d03` |
| Runner | `0614bbda1f7d4f31f4f3bcf0b91ed8570bfacf0901abf0f4386cf7854dca219b` |

## Claim boundary

This is Linux source-server evidence using PDF.js 5.4.624 and installed Poppler
at 144 DPI. It does not prove the packed MCPB, Claude Desktop, macOS, Windows,
PDF/A, PDF/UA, OCR, cryptographic signatures, tagged-PDF preservation, or
universal document compatibility. Those remain separate corpus and release
gates.
