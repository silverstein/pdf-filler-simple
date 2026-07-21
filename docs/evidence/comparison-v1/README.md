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

The `codex-*.v1.json` files retain a privacy-minimized graded projection for a
separately predeclared three-run headless Codex campaign of the
`compare-and-explain` job:

- `codex-agent-evidence-summary.v1.json` binds the private campaign, plan,
  measured trials, and report by SHA-256 while publishing the denominator,
  model, required tool-call structure, content identities, visual-oracle
  measurements, filesystem-effect counts, and claim gates; and
- `codex-trajectory-report.v1.json` retains the path-free aggregate grading
  report produced by canonical replay of the private measured trials.

The exact campaign and measured trials are maintainer-private because they
contain absolute runtime paths, host identity, environment details, raw
transcripts, and retained image bytes. The public projection excludes those
categories and is schema- and privacy-checked. Its source digests permit a
maintainer with the private inputs to prove identity and regenerate it, but the
public repository alone is deliberately not externally replay-ready.

All three trials passed, so the descriptive pass rate is 1 with observed
variance 0 and zero harness failures. This is not an independent benchmark:
the repetitions share one synthetic fixture, only one of six suite jobs has
observations, planner/result roles are unsigned, and neither native Claude
Desktop nor the packed MCPB was exercised. Trust, independence, full-suite
harness, sample-size, and benchmark-claim readiness therefore remain false.
