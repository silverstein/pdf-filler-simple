# Release Guide

This is a lightweight checklist for shipping a new release.

## 1) Version bump

Update these files together:

- `package.json`
- `manifest.json`
- `manifest.mcpb.json`

## 2) Build artifacts (locally)

```
npm install
npm run build:ui
npm test              # Catches Chromium-incompatible APIs in the viewer
npm install -g @anthropic-ai/mcpb
mcpb pack
node package-for-friend.js
```

## 3) Manual verification

Run the manual test checklist in `docs/MAINTAINERS.md`.

**Viewer smoke test (required):** Install the `.mcpb` in Claude Desktop and run `display_pdf` on at least one PDF. Confirm pages render without "Failed to render page" errors. Check `~/Library/Logs/Claude/claude.ai-web.log` for `[viewer] Render error` if anything looks wrong.

**Release-candidate hardening gate:**

- `detect_signature_zones` must show exact coordinates in visible text, not only `structuredContent`.
- In Claude Desktop, verify W-9 page 1 signature/date zones sit on the blank signing/date row, not on the printed labels.
- Verify same-path fill/sign mutates the active PDF in place and creates exactly one backup.
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
