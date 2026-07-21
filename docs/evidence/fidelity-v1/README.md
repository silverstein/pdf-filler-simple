# PDF mutation fidelity V1 baseline

This evidence records the first complete run of the strict mutation-fidelity
contract in `test/fixtures/eval/fidelity/manifest.v1.json`. It is a red
baseline, not a release-readiness claim.

## Result

- Generated: 2026-07-21T19:07:20.282Z
- Planned cells: 21
- Observed unique cells: 21
- Report validity: valid
- Overall result: fail
- Source-server revision: `b724d9278a7e8c255b1cb211062beaab3515d9d1`
- Engines: pinned PDF.js/canvas product lane and Poppler 24.02.0 independent lane
- Rendering: 144 DPI, full-page comparison before intended-region classification
- Failure evidence: 72 before, after, and delta-image bundles with verified SHA-256 bindings

Four cases passed every required hard gate in all three fresh-process runs:

- fill a form field to a new output;
- stamp text while preserving protected content;
- prepare a signing packet without applying a signature;
- perform two normal same-path fills while retaining one immutable H0 backup.

Three cases failed consistently in all three runs:

- `apply_page_plan` lost the reachable AcroForm field and source metadata, and
  left an orphan page widget;
- `merge_pdfs` and the subsequent `split_pdf` lost the reachable AcroForm field
  and source metadata, and left orphan page widgets on form-bearing outputs;
- after the recorded original backup was deleted, a second same-path mutation
  succeeded, changed the working PDF, advanced active-document state, and
  created a replacement backup from already-mutated bytes.

The rotation comparison uses a source-derived reference transform rendered
through each engine. No output-derived mask or post-run alignment is used.
Required gates are conjoined. There is no weighted score and no failing channel
can be averaged away.

## Artifact bindings

The full reports, generated PDFs, and raster evidence remain in maintainer-held
private evidence storage. The privacy-reviewed public summary is bound to them
by SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| Raw report | `ce179eb4e539a8598bc916285e01e12f510a2ad9bf58859cd69a9a95dd957662` |
| Conjunction score | `94630720255b18a7820da6f8d9b2db581f10355046f774258eaa101a8086266b` |
| Run index | `1691902562ff45102782b8385cc4472b8b3f29282b482b4e7b22951dc5413cf9` |
| Manifest | `2af8fd64b0a85c9f2406d925a99b63aad8eeba4d53ef5e33a0e095195a498995` |
| Runner | `47546f430bec2ddcbc07fcf54d817c46644583f1ef897931220c464da08ebd37` |

## Claim boundary

This is Linux source-server evidence using PDF.js 5.4.624 and installed Poppler
at 144 DPI. It does not prove the packed MCPB, Claude Desktop, macOS, Windows,
PDF/A, PDF/UA, OCR, cryptographic signatures, tagged-PDF preservation, or
universal document compatibility. Those remain separate corpus and release
gates.
