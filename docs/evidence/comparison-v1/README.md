# PDF comparison benchmark evidence v1

This directory contains descriptive benchmark evidence for the public synthetic
comparison slice defined by `test/fixtures/eval/comparison/manifest.v1.json`.
The evidence is not a release approval and `benchmark_claim_ready` remains
false.

The shared-library baseline is truth-blind at its implementation boundary, but
it uses the same `pdf-lib`, PDF.js, and canvas families as PDF Tools. Its result
is therefore a deterministic reference and implementation sensor, not
independent confirmation. The run uses opaque `before.pdf` and `after.pdf`
filenames in an isolated temporary directory, with no network or model.

Regenerate the evidence from the repository root:

```bash
node scripts/eval-run-comparison-baselines.mjs
```

Every raw and scored report is bound by SHA-256 in `run-index.v1.json`. Timing
and RSS are measured observations and will change across runs; corpus and
renderer digests must not drift without a versioned benchmark change.

The current-product lane starts `server/index.js` over MCP stdio and uses only
the published `read_pdf_pages`, `read_pdf_fields`, and `render_pdf_page` tools.
It deliberately preserves missing metadata, annotation, and canonical
region-observation capabilities as false negatives. It does not execute the
candidate MCPB or claim native Claude Desktop coverage.

`poppler-sensor.v1.json` is a separately named external-process sensor using
the VM's installed Poppler commands. It records independent text, metadata,
page-marker, and 144-DPI PPM hashes without pretending that Poppler supplies a
semantic/event oracle. If Poppler is absent, the runner records
`engine_unavailable` and never substitutes the shared renderer.
