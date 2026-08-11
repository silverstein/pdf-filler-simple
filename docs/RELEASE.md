# Release Guide

This is a lightweight checklist for shipping a new release.

## 1) Version bump

Update these files together:

- `package.json`
- `manifest.json`
- `manifest.mcpb.json`

## 2) Build artifacts

```
npm ci
npm run test:all
npm run qpdf-wasm:verify
npm run build:mcpb
npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb
node package-for-friend.js
npm run test:contract:share
```

`qpdf-wasm:verify` is the only step here that needs Docker and the only one
that takes about 45 minutes; under x86-64 emulation on Apple Silicon it is the
long pole of the whole checklist. It rebuilds the vendored QPDF WebAssembly
runtime twice from pinned sources with build-stage networking disabled and
requires both results to equal `vendor/qpdf-wasm/expected-output.json` byte for
byte. It is deliberately excluded from `npm test` and from `npm run test:all`,
which instead run the sub-second
`test/qpdf-wasm-runtime-artifact.test.js`: that suite pins the committed
runtime to the same contract, to the pinned source hashes, and to the notice
manifest, and loads the committed module to prove it still works — but it does
not rebuild, so only this release step proves the artifact is still
reproducible from source. Run it nightly if a release is not imminent. If the
runtime has not changed since the last verified release, a recorded prior run
is acceptable evidence; if `vendor/qpdf-wasm/` changed at all, it is not.

Promote a rebuilt runtime with
`node scripts/vendor-qpdf-wasm-runtime.mjs <extracted-build-directory>`, which
regenerates `vendor/qpdf-wasm/runtime.provenance.json`. Never hand-edit that
file.

`build:mcpb` uses repository-pinned MCPB 2.1.2 to validate two clean production
stages, installs the five locked native targets into each, and produces both
archives with the lock-resolved `fflate@0.8.3` canonical writer. It requires
byte-identical output from isolated build processes, exact stage/archive content parity and
canonical re-encoding, normalized ZIP
metadata, safe unique paths, the protected `pdfjs-dist@5.4.624` legacy runtime,
and pinned MCPB 2.1.2 `info`/`unpack` consumption before atomically replacing
the prior artifact. Each stage also gets a generated `SBOM.cdx.json` at its
archive root, covering the locked production graph and the QPDF WebAssembly
runtime's native components, so the MCPB carries the same bill as the share ZIP. External `unzip -t` is an additional check when available,
not a Windows portability claim. The build reports its measured peak child RSS. Do not
substitute a host-local global `mcpb pack` for release builds.

Activation re-hashes and re-stats the second candidate immediately before
rename. Any mismatch or pre-rename durability failure leaves the prior artifact
untouched. A post-rename directory-fsync I/O failure is different: the new file
has already replaced the old one, so the build reports an `activated: true`
durability error with its path, size, and SHA-256. Treat that as “new artifact
present; crash durability unconfirmed,” not as a rollback.

The share-package test builds the ZIP twice, requires byte-identical hashes,
verifies full root/share lock parity, provenance and CycloneDX 1.6 SBOM
coverage, proves failed artifact builds preserve the prior ZIP, and exercises
transactional install failure, activation rollback, and signal rollback paths.
It also writes existing and new Cursor configs beneath an adversarial path and
requires exact JSON round-trip behavior with no Python runtime available. The
manual installer's printed JSON is tested from an adversarial source path too.
It then performs a clean staged install with `npm ci --omit=dev --engine-strict`
and exercises MCP discovery, resource reads, and native page rendering. Repeat
the share install on each claimed release OS; one platform's native optional
dependency does not prove another platform.

## 3) Manual verification

Run the manual test checklist in `docs/MAINTAINERS.md`.

Build and retain the evidence bundle described in `docs/EVALUATION.md`. Record
the final artifact hash, host and OS versions, tool-discovery evidence, core-job
transcript, screenshots, and relevant logs for every required host lane.

**Viewer smoke test (required):** Install the `.mcpb` in Claude Desktop and run `display_pdf` on at least one PDF. Confirm pages render without "Failed to render page" errors. Check `~/Library/Logs/Claude/claude.ai-web.log` for `[viewer] Render error` if anything looks wrong.

**Release-candidate hardening gate:**

- `detect_signature_zones` must show exact coordinates in visible text, not only `structuredContent`.
- In Claude Desktop, verify W-9 page 1 signature/date zones sit on the blank signing/date row, not on the printed labels.
- Verify same-path fill/sign mutates the active PDF in place and creates exactly one backup.
- Verify legacy `overwrite=true` remains a no-op for a new destination or same-path text/signature call, but cannot replace a distinct existing output without exact identity.
- Verify a stale same-path `expected_output_identity` leaves PDF bytes, backup inventory, pending records, and active-document state unchanged.
- Verify a distinct existing PDF output is unchanged when no `expected_output_identity` is supplied, when any identity field is stale, and when the destination is a hardlink alias to an input.
- Verify a matching exact output identity permits the intended replacement and that mixed new and approved batch outputs remain all-or-nothing.
- Verify `fetch_pdf_from_url` and `convert_pdf_to_markdown` also reject blind existing-output replacement.
- Verify page-management output becomes the active document before any follow-up fill/sign/text operation.
- Verify inspect-region, preview-to-zone, draw-signature, and rotated-page signature overlays in a real browser. If `agent-browser` is flaky, use Playwright MCP and record the evidence in the durable test ledger.
- Retest an XFA `force_xfa=true` fill output in the embedded viewer; do not ship if the viewer says "Invalid PDF structure" for an otherwise usable output.
- Reinstall the final rebuilt `.mcpb` in Claude Desktop after packaging; do not rely on source-level or previously installed-extension results.
- Before publishing the packed `.mcpb`, inspect it with `unzip -l pdf-toolkit-mcp.mcpb` and confirm generated local evidence files such as `*-sign.png`, `.playwright-mcp/`, and `.test-tmp*/` are not included.
- Run URL-backed golden fixtures online for release. `RELEASE_GATES=1 npm test -- test/golden-set-placement.test.js` must pass; required URL fixtures must not be skipped with `OFFLINE=1`.
- `npm run smoke:ui-preview-zone` is currently an `agent-browser` harness check and may be flaky. Until hardened, use Playwright MCP evidence for preview-to-zone behavior and record the harness status separately from product behavior.
- Confirm a clean-profile or second-host install path before publishing broadly. Cursor support should either be tested or explicitly scoped out for the release.

## 4) Publish

- Create a GitHub release.
- Attach the generated `.mcpb` and `pdf-toolkit-mcp.zip` files.
- Do not commit binary artifacts into main.

## 5) Post-release

- Verify the Releases page links in README still point to the latest build.
- Confirm Claude Desktop installation and Cursor install flow with a clean machine.
