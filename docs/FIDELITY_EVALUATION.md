# PDF mutation fidelity evaluation

PDF Tools treats mutation fidelity as a set of independent hard gates. A good
render cannot compensate for a lost form field, a plausible page count cannot
compensate for the wrong page lineage, and an aggregate score cannot hide a
failed backup or filesystem invariant.

The versioned contract lives in
`test/fixtures/eval/fidelity/manifest.v1.json`. It predeclares the source
documents, exact MCP calls, intended visual regions, page lineage, semantic
expectations, metadata policy, filesystem effects, active-document state, and
three fresh-process repetitions for every case. The runner must not derive or
expand masks from an observed output.

## V1 families

V1 measures seven representative workflows through the real stdio MCP server:

1. fill one AcroForm field to a new output;
2. stamp text while preserving the form and unrelated pages;
3. prepare a signing packet with one field fill and one visible sign-here zone;
4. reorder and rotate pages with `apply_page_plan`;
5. merge two synthetic PDFs and split the result back into its source ranges;
6. mutate one PDF in place twice while retaining one immutable original backup.
7. delete that recorded backup between mutations and require the next mutation
   to fail before changing the working PDF or manufacturing a replacement.

The committed fixtures are synthetic and contain no personal data. Every source
path and SHA-256 is bound in the manifest.

## Required gates

Every planned case and repetition must account for all gates required by its
family:

- artifact integrity and nonempty output;
- product-engine open and render;
- independent Poppler open and render;
- page lineage and page geometry;
- exact expected form and annotation inventory;
- operation-specific metadata preservation;
- intended visual change and forbidden visual drift;
- exact recursive filesystem effects;
- active-document state;
- immutable original-backup identity for same-path mutations.

Missing, null, unavailable, duplicated, or unplanned cells make the report
invalid. An unavailable required engine is not a pass. Overall success is the
logical conjunction of every required gate in every planned cell. Descriptive
pixel counts are retained, but there is no weighted or averaged release score.

## Visual policy

Both PDF.js and Poppler render each source/output page independently at 144 DPI.
Expected rotations are applied to the source render before comparison. The raw
maximum channel delta is counted at thresholds greater than 0, 2, and 8.
Intended regions use a fixed two-pixel halo after PDF-point to raster conversion.
The following rules are fail closed:

- any pixel outside all declared intended regions with channel delta greater
  than 8 fails forbidden-drift;
- a region marked `required_visible_delta` must contain at least one pixel with
  channel delta greater than 8;
- dimension mismatch fails;
- full-page masks are rejected by the manifest validator;
- the full-page raw diff is retained before region classification.

These thresholds are deliberately strict for the deterministic synthetic
corpus. They are not claimed as universal perceptual thresholds for arbitrary
PDFs. Broader real-world calibration must establish separate tolerances without
weakening the V1 tripwires.

## Engine and claim boundary

The product lane uses the repository-pinned PDF.js and canvas stack. The
independent lane uses the installed Poppler `pdftoppm` binary. Reports record
versions and binary fingerprints. Poppler is evaluator-only and is not bundled
with the MCPB.

V1 is source-server evidence on Linux. It does not prove the packed MCPB,
Claude Desktop, macOS, Windows, PDF/A, PDF/UA, cryptographic signature validity,
OCR fidelity, tagged-PDF preservation, or universal document compatibility.
Those remain separate release and corpus-expansion gates.

## Running

```bash
node scripts/eval-run-fidelity-campaign.mjs /path/to/private-output
```

The runner keeps generated PDFs and raster failure evidence in the requested
private output directory. Only privacy-reviewed summaries may be committed.
