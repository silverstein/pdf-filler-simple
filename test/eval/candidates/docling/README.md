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

An existing `uv` installation is a human prerequisite. The builder does not
bootstrap or select `uv` from the network. It resolves the existing binary to a
single-link regular file and binds its exact path, bytes, SHA-256, and reported
version into the receipt. Production host identity is read on the Mac from the
actual process, `sw_vers`, and kernel; the synthetic host seam is test-only.

It creates content-addressed inputs under these private local roots:

- `~/Library/Caches/oda-pdf-tools-extraction/uv`
- `~/Library/Caches/oda-pdf-tools-extraction/models`
- `~/Library/Caches/oda-pdf-tools-extraction/runs`
- `~/Sites/pdf-tools-extraction-sidecars`

The builder refuses destinations under Documents, iCloud, Dropbox, or another
configured protected root. It copies only PDF bytes into the candidate handoff,
not the Phase 0 manifest, case IDs, expected values, or ground truth. The JSON
receipt contains the exact setup/execution recipe and hashes for every retained
input. Its SHA-256 must be carried out of band. Before either setup or execution,
run the retained verifier with that digest; the adapter independently requires
the same receipt and digest. A mutable receipt, config, adapter, fixture, helper,
or `uv` binary fails closed.

The networked setup phase resolves and hashes the full Python lock, then fetches
the exact layout-model repository revision. The model setup helper verifies the
receipt-bound config SHA-256, expected weight byte length and SHA-256, exact
config files, file modes, and complete file inventory. A valid existing
content-addressed model root is reused; any extra or changed file fails closed.
No model is downloaded by the handoff builder itself. `UV_PYTHON_INSTALL_DIR`
is pinned below the private cache, and `PYTHONDONTWRITEBYTECODE=1` applies to
setup and execution.

The execution phase sets the Hugging Face and Transformers offline variables,
uses the explicit local artifacts directory, and disables Docling remote
services. This is offline intent, not enforced network isolation. The Phase 1
runner must continue to report `network_isolation: false`.

The handoff is not a benchmark result or a packaging, product, redistribution,
or release decision. A complete private bakeoff still requires three fresh
process repetitions per case, immutable generation publication, scoring, and
independent review. Runtime evidence must inventory the exact managed Python,
virtual environment, resolved lock, and model tree before and after three
distinct fresh processes, with no `.pyc` or `__pycache__` drift.

The adapter bounds source/request/output sizes and its own translation
accumulation. Docling conversion and `export_to_dict()` are non-streaming in the
pinned API, so their peak memory is not bounded by the adapter. Closing this
residual requires a separately designed native supervisor with process-group
monitoring, termination, and retained resource evidence; the runtime inventory
gate is not hard memory isolation.
