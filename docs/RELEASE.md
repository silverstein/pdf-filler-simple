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

## 4) Publish

- Create a GitHub release.
- Attach the generated `.mcpb` and `pdf-toolkit-mcp.zip` files.
- Do not commit binary artifacts into main.

## 5) Post-release

- Verify the Releases page links in README still point to the latest build.
- Confirm Claude Desktop installation and Cursor install flow with a clean machine.
