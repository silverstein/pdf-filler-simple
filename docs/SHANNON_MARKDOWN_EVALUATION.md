# Shannon Markdown evaluation

This companion evaluates deterministic Markdown extraction against Claude
Shannon's 1948 paper, *A Mathematical Theory of Communication*. It exists to
reproduce concrete extraction failures reported against `pdf-inspector`; it is
not a public benchmark, a complete ground truth, or authorization to add an
external dependency.

The paper is not redistributed. The manifest binds the external Harvard-hosted
PDF by URL, byte count, page count, and SHA-256. The runner refuses a different
file. It also binds `pdf-inspector` to an exact Git revision, generated
`Cargo.lock`, release binary, and MIT license declaration. Generated Markdown
and reports must be written to a new private directory outside this repository.

## What is compared

The initial candidate slots are:

- `control.current_product.v0`: PDF Tools' shipped
  `convert_pdf_to_markdown` path, called in six bounded page ranges;
- `candidate.direct_pdf.v1`: the pinned `pdf-inspector` `pdf2md` binary, for
  evaluation only;
- `candidate.layout_ir.v1`: reserved for a stronger layout-aware reference and
  explicitly `not_run` until a Shannon-specific hash-bound handoff exists.

Each runnable candidate starts in a fresh process three times. Output must be
byte-deterministic across repetitions. The report keeps headings, reading
order, paragraph continuity, equations, footnotes, table topology,
omission/duplication, evidence, latency, memory, and artifact size separate. It
never blends them into an overall score.

Equation anchors must occur on their declared source page, in order, within a
200-character span, with token boundaries. Table-header terms must occur in the
actual Markdown header row rather than elsewhere in a table. The source PDF and
candidate executable run from private verified snapshots; the PDF Tools runtime
files are revalidated after every repetition.

The sampled oracle is deliberately narrow. A missing anchor can identify a
regression, but a passing anchor set cannot prove complete 55-page fidelity.

## Reproduction

Download the PDF and clone/build the candidate outside the repository. Verify
their bytes against `test/fixtures/eval/shannon/manifest.v1.json`, then run:

```sh
node scripts/eval-run-shannon-markdown-bakeoff.mjs \
  --source /absolute/path/to/shannon-entropy.pdf \
  --pdf-inspector-root /absolute/path/to/pdf-inspector-pinned \
  --output-dir /absolute/new/private/output-directory
```

The upstream project does not commit `Cargo.lock`. The evaluated lock must be
generated at the pinned revision and must match the manifest before building
with `cargo build --release --locked --bin pdf2md --bin detect-pdf`.

The runner is initially restricted to macOS arm64 because its resource
observation uses `/usr/bin/time -l`. It does not impose a hard memory limit or
syscall-level network isolation, and reports those limitations explicitly.

## Decision boundary

Use the report to decide whether to keep ideas, investigate a focused product
fix, or run a stronger candidate. Do not infer any of the following from a
successful run:

- that `pdf-inspector` should be bundled or added as a dependency;
- that PDF Tools or another candidate is state of the art;
- that a packed MCPB, desktop host, or release artifact passed;
- that an external maintainer should be told the reported extraction problem
  is solved.

An external reply requires a public commit that materially fixes the reported
failure modes, a rerun bound to that code, and a candid description of any
remaining hierarchy, equation, table, ordering, or fidelity gaps.
