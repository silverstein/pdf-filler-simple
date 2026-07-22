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
receipt contains the exact clean-launcher setup/execution recipe and hashes for
every retained input. Its SHA-256 and protected-root JSON must be carried out of
band. Before executing either receipt command, a human must authenticate that
receipt SHA-256 with a trusted system mechanism independent of the checkout.
The builder also prints the inline bootstrap SHA-256. Compare it independently
to the reviewed value
`9921055c8883627b062c4edfa8996c49ec37e6a7262374cdff27fc3ec7067b6f`; the
generator's own output is not its authority. The receipt-bound `/bin/sh`
bootstrap uses fixed system primitives to verify the exact Node binary,
launcher CLI, and launcher module before any JavaScript executes. It copies the
CLI and module into one mode-0700 seal, makes both files mode 0400, and launches
the sealed CLI with an empty, allowlisted Node environment. The sealed CLI
resolves only its sealed sibling module; the module then verifies and seals the
retained authority. Directly running
`node scripts/eval-verify-docling-macos-handoff.mjs` is a convenience diagnostic,
not the independent authority path. The adapter independently requires the same
receipt and digest. A
mutable receipt, config, adapter, fixture, helper, launcher, authority, Node, or
`uv` binary fails closed.

The networked setup phase resolves and hashes the full Python lock, then fetches
the exact layout-model repository revision. The model setup helper verifies the
receipt-bound config SHA-256, expected weight byte length and SHA-256, exact
config files, file modes, and complete file inventory. Each handoff uses a fresh
target published with an atomic no-replace operation. Only an explicit durable
publication-intent record may reconcile a post-rename parent-fsync failure; an
unmarked existing target fails closed. No model is downloaded by the handoff
builder itself. `UV_PYTHON_INSTALL_DIR` is pinned below the private cache. All
Python processes use isolated `-I -B` startup, and authority HOME/TMPDIR must
remain empty.

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
The retained finalization schema is the declarative form of the contract. The
self-contained authority enforces an exact manual mirror of all of its shape,
cardinality, version, path, mode, link, and byte constraints before live-state
comparison.

The synthetic fixture is a scrubbed DoclingDocument 1.10-shaped projection of
only the fields consumed by the adapter. Its strict local schema is not a claim
to reproduce the full upstream schema or a byte-for-byte upstream export. The
pure projection requires every retained `TableCell.text` to be a string; a
missing table-grid coordinate is represented by no cell record.

The adapter bounds source/request/output sizes and its own translation
accumulation. Its translation ceiling reserves the fixed response envelope from
the smaller of `max_report_bytes` and `max_stdout_bytes`. Docling conversion and
`export_to_dict()` are non-streaming in the pinned API, so their peak memory is
not bounded by the adapter. Closing this
residual requires a separately designed native supervisor with process-group
monitoring, termination, and retained resource evidence; the runtime inventory
gate is not hard memory isolation.
