# macOS Claude Desktop host evidence — 2026-07-21

## Outcome and claim boundary

The exact candidate MCPB was installed by Claude Desktop's registered MCPB file
handler on the designated Apple Silicon Mac. The installed tree matches every
file extracted from the candidate, the concise `PDF Toolkit` name is active,
and Claude requested the candidate's MCP tool list. The installed server then
passed deterministic text, raster, filesystem-policy, repeated-session,
fresh-session, and safe-mutation tests on that Mac.

This is a **conditional native-host pass**, not a complete chat-level pass.
Claude's web content was unavailable to Accessibility, loopback CDP could not be
enabled, and the SSH session did not have Screen Recording access. Two
content-blind attempts to focus a new blank chat generated no candidate tool
calls. Therefore repeated calls in one Claude chat, a call in a second fresh
chat, screenshots, and the host UI's propagation of a custom allowed-directory
selection remain unclaimed. Direct installed-server sessions cover the same
functional calls but are intentionally reported as a lower evidence layer.

No signature tool was called, no signature intent was supplied or fabricated,
and no private document or existing chat was inspected, captured, or copied.

## Candidate and host

| Item | Observed value |
|---|---|
| Candidate | `pdf-toolkit-mcp.mcpb`, version `0.8.6` |
| Candidate size | `75,681,413` bytes |
| Candidate SHA-256 | `9278d89b493380b1d656feee5c5d0d83babaded4f440efd9b71401635c3c9ecb` |
| Installed extension ID | `local.mcpb.open-document-alliance.pdf-toolkit` |
| Installed display name | `PDF Toolkit` |
| macOS | `26.6` (`25G5065a`), arm64 |
| Claude at inventory/install | `1.22209.0` |
| Claude after authorized restart | `1.22209.3` |
| Host timezone | PDT (`UTC-07:00`) |
| Lane base commit | `ff4da56` |

Claude had already staged `1.22209.3`. The restart performed for the bounded
CDP fallback activated that staged update. The host log records
`Version changed since last launch: 1.22209.0 → 1.22209.3`; the lane did not
download or invoke an updater directly.

## Safety inventory and recovery

Before staging or installing the candidate, the lane inventoried only the
existing PDF Tools extension, its settings, the extension installation registry,
Claude version, and relevant log pointers. It copied those items to this
mode-restricted, recoverable host-local path:

`~/Library/Application Support/Claude/PDF Tools Host Validation Backups/20260721T060500Z`

The backup is 93 MB and passed recursive comparison against the pre-install
extension plus byte comparisons of the settings and registry. Key hashes are:

| Backup item | SHA-256 |
|---|---|
| Inventory | `d466e65a5ebebc194cc801b5c6e044f553ce64f74b7cdea05475de9836feae5a` |
| Legacy installed manifest | `8cdcdc08020740fe67935699b219e707c478a086b35acf8168349c8be27ccd9c` |
| Legacy installed server | `d1bd8c2a6a675acca9b6fd92995969b370fed0388c414c0f65621e8ade5ab40c` |
| Legacy settings | `4629008374656b0b1141bec3779a32cb7835679fda907eae07e813c216584b3d` |
| Pre-install registry | `83a2984f370ec371ee3c69c59624e0df7a59f76b6966e3deecc88231f55ce5de` |

A second `post-install-pre-config` snapshot preserves both extension settings
files and the post-install registry before the lane disabled the legacy
long-name extension and configured the candidate. The candidate was never
manually overlaid.

## Artifact transfer and installation

The source candidate was hashed before any host mutation. The first staged copy
was incomplete: `51,440,640` bytes with SHA-256
`d5456a00baab86973a1a8055bbfad61809696cdcb759996c346e1b7153e22ef4`.
Installation was stopped at the hash gate. A checksum-aware retransmission
replaced only the dedicated staging copy; the Mac then reported `75,681,413`
bytes and the exact expected SHA-256.

Opening that verified file through Claude's registered `.mcpb` file handler
produced these correlated host-log events (main log uses PDT):

```text
2026-07-20 23:02:24 Handling DXT/MCPB file: ~/Downloads/PDFToolsHostValidation-20260721/pdf-toolkit-mcp.mcpb
2026-07-20 23:02:28 Installing unsigned extension from .../pdf-toolkit-mcp.mcpb
2026-07-20 23:02:30 Successfully installed extension local.mcpb.open-document-alliance.pdf-toolkit v0.8.6
2026-07-20 23:02:30 [localMcpBridge] announcing PDF Toolkit: 36 tool(s)
```

Claude's candidate MCP log independently records a host `tools/list` request at
`2026-07-21T06:02:30.398Z`, with additional requests after subsequent normal
restarts.

The installed directory contains 3,172 regular files and no symlinks. A sorted
SHA-256 hash-of-hashes over every relative file and byte is identical for the
locally extracted candidate and Claude's installed tree:

`49fe9f3624912795975d9b73f2483c58d2d6b3751ea26a584703aafd10e8c592`

This full-tree result includes, but is stronger than, the independently matching
manifest, server, helper, and UI hashes.

## Deterministic fixtures

The lane generated both fixtures with
`scripts/macos-claude-host-fixtures.mjs` and placed them only in the dedicated
test directory `~/PDFToolsHostValidation-20260721`:

| Fixture | Property | SHA-256 |
|---|---|---|
| `synthetic-text-two-page.pdf` | Two pages with a PDF text layer and synthetic markers | `a6bd6f4bfc26fcde294ad058c61c6050506d778f47ee3995b38410598f9fdcd8` |
| `synthetic-raster-only.pdf` | One image-only page with no PDF text layer | `d24fea6f696f51e4fae0eb5baf6968c8b93932bca4155701fdd0702dd9d8cff2` |

macOS PDFKit independently reopened the raster fixture and found one page with
no `BLUEHARBOR` text marker, confirming that the raster test did not silently
use an embedded text layer.

## Results

| Acceptance item | Result | Evidence and boundary |
|---|---|---|
| Exact artifact hash installed | Pass | Verified before open; Claude install log; 3,172-file installed-tree aggregate matches extracted MCPB |
| Concise display name | Pass | Installed manifest is `PDF Toolkit`; host bridge announces `PDF Toolkit` |
| All 37 MCP tools discoverable | Pass at installed MCP server; partial at chat layer | `tools/list` returned 37 unique names, including app-only `read_pdf_bytes`; Claude logs its request but the bridge announces the 36 manifest-declared user-facing tools |
| Generated tool ID length | Pass | Longest concise-name ID is `mcp__PDF_Toolkit__prepare_signing_packet`, 40 characters |
| Repeated calls in one session | Pass at installed MCP server | Six successful calls over one MCP connection |
| Call in a fresh session | Pass at installed MCP server | A second connection rediscovered 37 tools and reopened a mutation output |
| Repeated calls in one Claude chat | Blocked by automation harness | New-conversation focus attempts produced no tool calls; no chat content was read |
| Call in a fresh Claude chat | Blocked by automation harness | Same gate; not inferred from direct MCP success |
| Configured allowed directory | Direct pass; host-UI propagation unproven | Dedicated directory allowed; staged MCPB path outside it denied with the policy-specific error. Candidate settings were configured and the host restarted, but no chat call proved UI-to-runtime substitution |
| Text PDF | Pass | `read_pdf_content` extracted `BLUEHARBOR-TEXT-20260721` |
| Raster/native rendering | Pass | `render_pdf_page` returned PNG SHA-256 `2c091ce5a7ed045beda03ba13ed04e67347b2d5bad16652d1f160e6685e27e01` on macOS arm64 |
| Safe non-signature mutation | Pass | `split_pdf` created two outputs from the two-page text fixture |
| Independent reopen | Pass | macOS PDFKit reopened both outputs as one-page PDFs and found their synthetic marker |
| Error recovery / policy denial | Pass at installed MCP server | Outside-directory request returned the expected policy-specific denial; the session continued to the mutation call |
| Screenshots | Blocked by harness | SSH `screencapture` lacked display/Screen Recording access; no screenshot was captured or committed |
| Signature safety | Pass | No signature tool or signing action was invoked |

The host bridge's count of 36 is consistent with the package's 36 manifest tools
plus one server-only/app-only `read_pdf_bytes` tool. The direct server list of 37
is retained in local evidence; this report does not claim that the model-facing
chat UI exposed `read_pdf_bytes`.

## Mutation and independent verification

The installed candidate produced:

| Output | SHA-256 | PDFKit result |
|---|---|---|
| `synthetic-text-two-page_pages_1-1_1.pdf` | `07415a41f62f22f97d58b1500e88f7c1b9900d3fb05e845c9128c977a1702135` | One page; expected synthetic marker present |
| `synthetic-text-two-page_pages_2-2_2.pdf` | `e34005b1444a3d843ab3d8cf213d0091cbf73f6fc4a32287365c19712cef09b6` | One page; expected synthetic marker present |

The verifier uses macOS PDFKit through JXA rather than the extension's PDF
libraries, so the reopen check is independent of the mutation implementation.

## Host UI and CDP harness findings

Accessibility exposed the Claude process, window, native menu bar, and the
`File → New Conversation` command, but returned no web-content descendants or
focused composer element. Enabling `AXManualAccessibility` did not change that.

At maintainer direction, the lane evaluated one bounded CDP fallback:

1. Claude was quit normally.
2. It was relaunched with a debugger explicitly bound to `127.0.0.1`.
3. Port 9222 was rejected because an unrelated local process already owned it;
   that process was not queried beyond the listener check.
4. A verified-free port, 9333, was tried next. Claude exited before creating a
   listener, and no target list or existing chat was enumerated.
5. Claude was relaunched normally. Port 9333 is closed and the current process
   has no remote-debugging argument.

Two later content-blind attempts opened a new conversation and tried to focus
the known composer area. Candidate log length and tool-call count remained
unchanged. These are harness failures, not product failures.

The remaining human checkpoint is narrow: on the designated Mac, click the
composer in the already dedicated synthetic test chat, send the prepared
text/raster prompt, confirm the candidate tool calls, then open one additional
fresh conversation for a single `get_pdf_info` call. Any screenshots must crop
or hide unrelated chat history.

## Local-only evidence retained on the Mac

Nothing in this list is committed. All content is synthetic or sanitized.

| Evidence | Host-local path | SHA-256 |
|---|---|---|
| Installed-server result | `~/PDFToolsHostValidation-20260721/evidence/installed-smoke.json` | `1d6e9077f11f6939c1a8d3f1237bbec18a284dcc379d4fc47c1cf0ff17b0ee1c` |
| PDFKit reopen result | `~/PDFToolsHostValidation-20260721/evidence/pdfkit-reopen.json` | `e8260708edfb93709545f711807866a5cad814cf0f530212c506d755941e5efa` |
| Pre-install recovery backup | `~/Library/Application Support/Claude/PDF Tools Host Validation Backups/20260721T060500Z` | Inventory hash recorded above |
| Claude installation/discovery logs | `~/Library/Logs/Claude/main.log`, `mcp.log`, and `mcp-server-PDF Toolkit.log` | Not copied or committed; excerpts above are path-sanitized |

## Issue implications

- **#42:** The exact candidate enforces a custom allow-list correctly when
  launched with that configuration, denies an external path, and renders the
  image-only fixture on macOS arm64. The Claude settings UI-to-runtime path was
  not proven in chat, and the issue's Windows behavior is not covered; do not
  close #42 from this lane.
- **#43:** Native rasterization passes on macOS arm64 with the packed candidate,
  which is useful packaging/runtime evidence but does not prove Windows Node or
  Electron behavior. Do not close #43 without the Windows host lane.
- **#44:** The installed manifest and host bridge both use `PDF Toolkit`; the
  longest generated tool ID is 40 characters. This lane supports resolving the
  long-display-name defect for this candidate.
- **#47:** Claude successfully installed, enabled, announced, and sent
  `tools/list` to the concise-name candidate, so the extension is not absent at
  the local bridge layer. Chat-call exposure remains blocked by the automation
  harness, so #47 should be treated as improved/conditionally addressed rather
  than closed solely from this report.

An adversarially important upgrade-path finding is that official local MCPB
installation created `local.mcpb.open-document-alliance.pdf-toolkit` alongside
the pre-existing directory install
`ant.dir.gh.silverstein.pdf-filler-simple`; it did not replace it. Both were
initially announced until the backed-up legacy settings entry was disabled.
Release guidance should avoid treating a duplicate mixed-ID install as a clean
upgrade test.

## Reproduction helpers

The committed public-safe helpers are:

- `scripts/macos-claude-host-fixtures.mjs` — generate the two deterministic PDFs.
- `scripts/macos-claude-installed-smoke.mjs` — exercise 37-tool discovery,
  same/fresh sessions, policy behavior, text, raster, and split mutation against
  an installed extension directory.
- `scripts/macos-claude-pdfkit-verify.js` — independently reopen fixtures and
  outputs using macOS PDFKit.

The installed-smoke JSON records all 37 names. It performs no signature call and
prints only synthetic paths, counts, booleans, and hashes.
