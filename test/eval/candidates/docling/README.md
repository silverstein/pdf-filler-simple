# Docling direct-PDF evaluation adapter

This directory is an evaluation-only sidecar. It is excluded from the MCPB and
share package. The adapter accepts one Phase 1 direct-PDF request on standard
input and emits one response on standard output.

The first lane is intentionally parser-only:

- OCR is disabled. OCRMac is not selected automatically.
- TableFormer is disabled in the pinned configuration.
- Page text is labeled `visual_parser` with no ODA source-item IDs.
- Raw Docling tables are preserved if a later reviewed configuration enables
  them.
- Docling provenance stays in `native_evidence`. It is never promoted to ODA
  canonical evidence or field evidence.
- Every arbitrary target-schema leaf receives an `unsupported_modality` gap.

## macOS handoff

Run the handoff builder only on an Apple Silicon Mac from a clean checkout:

```sh
node scripts/eval-prepare-docling-macos-handoff.mjs
```

It creates content-addressed inputs under these private local roots:

- `~/Library/Caches/oda-pdf-tools-extraction/uv`
- `~/Library/Caches/oda-pdf-tools-extraction/models`
- `~/Library/Caches/oda-pdf-tools-extraction/runs`
- `~/Sites/pdf-tools-extraction-sidecars`

The builder refuses destinations under Documents, iCloud, Dropbox, or another
configured protected root. It copies only PDF bytes into the candidate handoff,
not the Phase 0 manifest, case IDs, expected values, or ground truth. The JSON
receipt contains the exact setup commands and hashes for every retained input.

The networked setup phase resolves and hashes the full Python lock, then fetches
the exact layout-model repository revision. The model setup helper verifies the
expected weight byte length and SHA-256 before writing its inventory. No model
is downloaded by the handoff builder itself.

The execution phase sets the Hugging Face and Transformers offline variables,
uses the explicit local artifacts directory, and disables Docling remote
services. This is offline intent, not enforced network isolation. The Phase 1
runner must continue to report `network_isolation: false`.

The handoff is not a benchmark result or a packaging, product, redistribution,
or release decision. A complete private bakeoff still requires three fresh
process repetitions per case, immutable generation publication, scoring, and
independent review.
