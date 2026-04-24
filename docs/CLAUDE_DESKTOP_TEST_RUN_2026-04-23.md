# Claude Desktop MCPB Test Run - 2026-04-23

This document is the durable handoff ledger for validating the PDF Tools MCPB
in Claude Desktop. Keep it current after each testing batch so another Codex
session can resume without relying on chat context.

## Ground Rules

- Update this file after every meaningful test batch, especially before long
  Claude Desktop interaction runs.
- Use normal Claude Desktop Chat for local MCPB validation.
- Do not use Cowork as a release-blocking target for this MCPB. Cowork appears
  to use remote/cloud tools and did not expose local desktop extensions in this
  run.
- Start a fresh Claude Chat periodically to avoid Claude chat compaction slowing
  or distorting the test. Practical cadence: new chat after 4-6 tool-heavy
  prompts, any long signing/page-management flow, or any unexplained slowdown.
- Keep test PDFs in already-allowed Claude Desktop directories unless the test
  explicitly covers allowed-directory settings. Prefer copying anonymized
  fixtures to `~/Downloads` instead of broadening local filesystem access.
- Do not use real sensitive PDFs, signatures, financial data, IDs, or personal
  details in this test run.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-04-23 |
| Repo | `/Users/silverbook/Sites/pdf-toolkit-mcp` |
| Branch | `master` |
| Latest pushed commit | `9aa68dd chore(release): tighten mcpb package ignores` |
| MCPB artifact | `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb` |
| Original MCPB SHA1 | `71cd7ae1a650e0c2f92a2156de3b8a12353473a6` |
| Rebuilt fixed MCPB SHA1 | `c7cbfe3831386efce4b44e672908e312421466cb` |
| Latest hardened MCPB SHA1 | `8dd4a308bbd183bfd3738ae4f79826c00c51e095` |
| Installed extension id | `local.mcpb.open-document-alliance.pdf-toolkit` |
| Installed version | `0.8.4` by backed-up manual overlay; normal Claude Desktop installer UI was blocked, and chat-level runtime retest remains blocked by Claude Desktop windowlessness |
| Claude Desktop modes | Chat supported; Cowork boundary confirmed unsupported for local MCPB |

## Fixtures

| Fixture | Path | Notes |
| --- | --- | --- |
| W-9 sample source | `/Users/silverbook/Sites/pdf-toolkit-mcp/example-fw9.pdf` | Repo anonymized fixture |
| W-9 allowed-folder copy | `/Users/silverbook/Downloads/pdf-toolkit-smoke-example-fw9.pdf` | Used for Claude Desktop Chat smoke |
| Batch test folder | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23` | Dedicated allowed-folder outputs |
| Batch 1 W-9 source copy | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/w9-form-source.pdf` | SHA1 `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1` |
| Batch 1 filled W-9 output | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/w9-filled-batch1.pdf` | SHA1 `a962504b160091735124c23637ba7af3f384e46d` |

## Claude Chat Ledger

| Chat | Mode | URL / Identifier | Purpose | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Cowork | `claude.ai/local_sessions/local_7f48421e-a345-46cc-851d-22b461fa790f` | Boundary test | Expected fail | Cowork did not find PDF Tools in deferred registry; treated as product boundary, not MCPB failure |
| 2 | Chat | `claude.ai/chat/48a5b9cf-bbaa-4206-849d-baafd302edd9` | Packaged MCPB smoke | Pass | `display_pdf` rendered inline viewer for W-9 sample |
| 3 | Chat | `claude.ai/chat/f3a5d11c-192b-41f5-8e93-39f51a3059ea` | Batch 1 form workflow | Pass | Sonnet 4.6 ran `display_pdf`, `read_pdf_fields`, `fill_pdf`, `display_pdf`, `validate_pdf` |
| 4 | Chat | `claude.ai/chat/22ce6b12-2415-48e0-a3f4-9e46de6d8d56` | Batch 2 viewer/file workflow | Pass | Sonnet 4.6 ran `display_pdf`, `list_pdfs`, `get_pdf_info`, `get_pdf_resource_uri`; manual viewer controls passed |
| 5 | Chat | `claude.ai/chat/33f761d2-0cdb-42be-a42b-aa208f1c2f68` | Batch 3 profile/CSV workflow | Fail | Profiles passed, but CSV comma round-trip failed by local CSV inspection; Sonnet overclaimed pass without direct CSV evidence |
| 6 | Chat | `claude.ai/chat/e7ee5dc5-9716-4cb2-8c5b-395566cbb872` | Batch 3 rerun after reinstall | Pass with host caveat | Tool/file-level CSV round-trip passed after reinstall; Sonnet correctly marked visible `structuredContent` preview-row evidence insufficient because Claude Desktop did not render row-level JSON |

## Completed Evidence

| Area | Status | Evidence |
| --- | --- | --- |
| UI build | Pass | `npm run build:ui` passed again during this run; `dist-ui/index.html` built as a 3,448.53 kB single-file viewer |
| Unit/integration tests | Pass | `npm test` passed: 16 files, 169 tests; known Vitest shutdown warning after success |
| Dev viewer smoke | Pass | `npm run smoke:ui-dev` passed; viewer and MCP bridge responded |
| Sign-mode smoke | Pass | `npm run smoke:ui-sign` passed after escalation for `~/.agent-browser` socket access |
| Inspect-region smoke | Pass | `npm run smoke:ui-inspect` passed after escalation for `~/.agent-browser` socket access |
| Preview-to-zone smoke | Pass | `npm run smoke:ui-preview-zone` passed after escalation for `~/.agent-browser` socket access |
| Draw-signature smoke | Pass | `npm run smoke:ui-draw` passed after escalation for `~/.agent-browser` socket access |
| CSV comma regression | Pass locally | `npx vitest run test/csv-roundtrip.test.js` passed after parser fix |
| Full test suite after CSV fix | Pass locally | `npm test` passed: 17 files, 172 tests after adversarial-review hardening; same post-success Vitest shutdown warning |
| MCPB packaging | Pass | `mcpb pack` produced 33 MB artifact |
| Package hygiene | Pass | Archive grep showed no `.beads`, `.test-tmp`, local plans, Vitest, or dev-only package helper files |
| Claude install | Pass | Installed manifest is version `0.8.1` and includes `allowed_directories` user config |
| Claude host startup | Pass | `mcp.log` shows server initialized, tools listed, resources listed |
| Viewer smoke in Chat | Pass | `display_pdf` called on `/Users/silverbook/Downloads/pdf-toolkit-smoke-example-fw9.pdf` |
| MCP app resource | Pass | `resources/read` fetched `ui://pdf-toolkit/viewer` |
| PDF byte streaming | Pass | `read_pdf_bytes` streamed both chunks for 126218-byte sample |
| Active document sync | Pass | `set_active_document` synced W-9 sample after viewer load |
| Cowork boundary | Confirmed | Cowork did not expose local PDF Tools desktop extension |

## Current Test Matrix

| Category | Test | Status | Notes |
| --- | --- | --- | --- |
| Viewer | `display_pdf` W-9 sample | Pass | Inline viewer rendered, page `1 of 4`, `Fields (22)` visible |
| Viewer | Page navigation | Pass in Claude Chat | Manual embedded viewer click moved from page `1` to page `2 of 4` |
| Viewer | Zoom controls | Pass in Claude Chat | Manual embedded viewer click changed zoom from `100%` to `125%` |
| Viewer | Search | Pass in Claude Chat | Search panel opened; query `FATCA` showed `7 of 15` with visible highlights |
| Viewer | Fullscreen | Pass in Claude Chat | Fullscreen mode opened and exit control returned the viewer to embedded state |
| Viewer | Non-form PDF render | Not run | Need non-form fixture in allowed folder |
| Forms | `read_pdf_fields` | Pass in Claude Chat | 22 fields enumerated; representative names included `f1_1`, `f1_2`, `c1_1`, `f1_7`, `f1_14`/`f1_15` |
| Forms | `fill_pdf` | Pass in Claude Chat | Synthetic values written to `w9-filled-batch1.pdf`; tool reported 14 field writes |
| Forms | `validate_pdf` partially filled | Pass in Claude Chat | Output reported 13 filled / 9 empty; empty fields were optional or intentionally blank in test |
| Profiles | `save_profile` / `load_profile` / `list_profiles` | Pass in Claude Chat | Throwaway profile `pdf_toolkit_batch3_profile_20260423`; comma-bearing value was intact in profile storage |
| Profiles | `fill_with_profile` | Pass in Claude Chat | Output `w9-profile-batch3.pdf`; 6 fields filled |
| CSV | `bulk_fill_from_csv` | Pass after reinstall | Original installed MCPB failed on quoted commas; fixed MCPB rerun preserved `"789 Comma Blvd, Suite 5"` through generated CSV -> bulk fill -> re-extract |
| CSV | `extract_to_csv` | Pass with host caveat | Generated valid quoted CSV and returns row previews in `structuredContent`; Claude Desktop did not render row-level preview JSON visibly to Sonnet in the chat UI |
| Text/visual | `read_pdf_content` text PDF | Not run | Need fixture |
| Text/visual | scanned/image PDF behavior | Not run | Need fixture or generated image-only PDF |
| Text/visual | `read_pdf_pages` | Not run | Use W-9 sample |
| Text/visual | `search_pdf_text` | Not run | Search known W-9 text |
| Text/visual | `render_pdf_page` | Not run | Use W-9 page 1 |
| Text/visual | `render_pdf_region` | Not run | Use a visible W-9 region |
| Files | `list_pdfs` allowed folder | Pass in Claude Chat | Found `w9-form-source.pdf` and `w9-filled-batch1.pdf` in the dedicated Downloads test folder |
| Files | `get_pdf_info` form PDF | Pass in Claude Chat | Source: 4 pages, 123.26 KB, 22 fields, not encrypted; filled: 4 pages, 128.38 KB, 22 fields, not encrypted |
| Files | `get_pdf_info` non-form PDF | Not run | Need fixture |
| Files | `get_pdf_resource_uri` | Pass in Claude Chat | Returned `pdf:///Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/w9-form-source.pdf` |
| Page ops | `merge_pdfs` success | Not run | Need two fixture copies |
| Page ops | `merge_pdfs` empty array error | Not run | Verify clear error |
| Page ops | `merge_pdfs` same input/output error | Not run | Verify rejection |
| Page ops | `split_pdf` exact ranges | Not run | Use 4-page W-9 or generated fixture |
| Page ops | `split_pdf` every-N pages | Not run | Use 4-page W-9 or generated fixture |
| Page ops | `split_pdf` invalid range | Not run | Verify clear error |
| Page ops | `rotate_pdf_pages` | Not run | Verify output visually |
| Page ops | `reorder_pdf_pages` | Not run | Verify output visually |
| Page ops UI | Manage tab rotate/reorder/delete/save | Not run | Needs Chat UI interaction |
| Signatures | `detect_signature_zones` | Not run | Use W-9 or signing fixture |
| Signatures | Sign tab opens | Pass in dev smoke | `smoke:ui-sign` opened Sign mode and signing modal in real browser dev harness |
| Signatures | `create_signature` typed | Not run | Synthetic test name only |
| Signatures | `list_signatures` / `load_signature` | Not run | Synthetic test signature |
| Signatures | `add_signature_field` placeholder | Not run | Does not sign document |
| Signatures | `apply_signature` missing intent rejection | Not run | Must verify legal guard |
| Signatures | `apply_signature` stale timestamp rejection | Not run | Must verify legal guard |
| Signatures | `apply_signature` fresh intent success | Not run | Use synthetic signature and explicit test intent only |
| Permissions | Allowed directory succeeds | Not run | `~/Downloads` |
| Permissions | Disallowed directory rejected | Not run | Use repo path without adding allowed directory |
| Permissions | User config allowed directory update | Not run | Only if needed; avoid broad access |
| Security | `fetch_pdf_from_url` public URL | Not run | Use safe public PDF if network allowed |
| Security | `fetch_pdf_from_url` private/metadata blocked | Not run | Automated tests already cover helper-level SSRF |
| Model behavior | Sonnet tool choice | Partial | Sonnet in Chat selected PDF Tools correctly across Batches 1-3 |
| Model behavior | Sonnet evidence discipline | Fail observed | In Batch 3 Sonnet marked CSV round-trip PASS without direct access to CSV contents; local inspection showed failure |
| Model behavior | Opus tool choice | Not run | Start a separate fresh Chat if available |
| Model behavior | Error recovery | Not run | Use intentional permission/range errors |

## Claude Desktop Chat Batch 1 - 2026-04-23 16:03 PT

| Step | Status | Evidence |
| --- | --- | --- |
| Fresh Chat started | Pass | `claude.ai/chat/f3a5d11c-192b-41f5-8e93-39f51a3059ea` |
| `display_pdf` on input | Pass | Viewer loaded `w9-form-source.pdf`, page `1 of 4`, `Fields (22)` |
| `read_pdf_fields` | Pass | 22 fields enumerated |
| `fill_pdf` synthetic output | Pass | `w9-filled-batch1.pdf` created; 128 KB on disk; SHA1 `a962504b160091735124c23637ba7af3f384e46d` |
| `display_pdf` on output | Pass | Output viewer loaded; 22 fields still detected |
| `validate_pdf` on output | Pass | Validation report: total 22, filled 13, empty 9 |

Notes:

- Claude requested approval for `fill_pdf` and `validate_pdf`; approvals were granted for this synthetic test batch.
- `fill_pdf` reported 14 field writes because some intentionally blank optional fields were included in the field map. `validate_pdf` counted 13 non-empty filled fields.
- Synthetic values used: `PDF Toolkit Test LLC`, `Batch One QA`, `123 Test Lane`, `Testville, CA 90000`, EIN split as `12` and `3456789`.
- Claude followed the "PDF Tools only" instruction and did not use fallback filesystem/bash/Python/Drive tools.

## Claude Desktop Chat Batch 2 - 2026-04-23 16:06 PT

| Step | Status | Evidence |
| --- | --- | --- |
| Fresh Chat started | Pass | `claude.ai/chat/22ce6b12-2415-48e0-a3f4-9e46de6d8d56` |
| `display_pdf` on input | Pass | Viewer loaded `w9-form-source.pdf`, page `1 of 4`, `Fields (22)` |
| `list_pdfs` test folder | Pass | Found both `w9-form-source.pdf` and `w9-filled-batch1.pdf` |
| `get_pdf_info` source | Pass | 4 pages, 123.26 KB, 22 form fields, not encrypted |
| `get_pdf_info` filled | Pass | 4 pages, 128.38 KB, 22 form fields, not encrypted |
| `get_pdf_resource_uri` source | Pass | Returned `pdf:///Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/w9-form-source.pdf` |
| Page navigation | Pass | Manual embedded viewer click moved to page `2 of 4` |
| Zoom controls | Pass | Manual embedded viewer click changed zoom from `100%` to `125%` |
| Search controls | Pass | Search query `FATCA` showed `7 of 15` matches with visible highlights |
| Fullscreen controls | Pass | Fullscreen mode opened and exit control returned the app to embedded state |

Notes:

- Claude requested approval for `get_pdf_resource_uri`; approval was granted for this read-only synthetic test folder.
- Claude reported deferred loading friction: `list_pdfs` and `get_pdf_resource_uri` required a tool discovery/loading step before succeeding. This is a host/tool-loading behavior, not a PDF Tools server failure, but it is worth watching in longer chats.
- Claude followed the "PDF Tools only" instruction and did not use fallback filesystem/bash/Python/Drive tools.

## Claude Desktop Chat Batch 3 - 2026-04-23 16:12 PT

| Step | Status | Evidence |
| --- | --- | --- |
| Fresh Chat started | Pass | `claude.ai/chat/33f761d2-0cdb-42be-a42b-aa208f1c2f68` |
| `save_profile` | Pass | Profile `pdf_toolkit_batch3_profile_20260423` saved with street value `789 Comma Blvd, Suite 5` |
| `list_profiles` / `load_profile` | Pass | Claude reported the comma-bearing street value was intact in profile storage |
| `fill_with_profile` | Pass | Output `w9-profile-batch3.pdf`; 6 fields filled |
| `display_pdf` on profile output | Pass | Profile-filled PDF rendered inline in Claude Desktop |
| `extract_to_csv` from profile output | Pass with caveat | Generated `batch3-extracted-from-profile.csv`; local inspection confirmed quoted street value `"789 Comma Blvd, Suite 5"` |
| `bulk_fill_from_csv` from generated CSV | Fail | Tool produced `filled_1.pdf`, but downstream extraction showed quote/comma parsing corruption |
| `extract_to_csv` from bulk output | Pass with caveat | Generated `batch3-extracted-after-bulk.csv`; local inspection showed corrupted shifted values |
| Sonnet final comparison | Fail | Claude marked comma round-trip PASS without direct CSV row evidence; local inspection contradicted it |

Local CSV evidence:

- Before bulk fill: `batch3-extracted-from-profile.csv` contained `"789 Comma Blvd, Suite 5"` in `topmostSubform[0].Page1[0].Address[0].f1_7[0]`.
- After bulk fill: `batch3-extracted-after-bulk.csv` contained `""789 Comma Blvd"` in `topmostSubform[0].Page1[0].Address[0].f1_7[0]` and `Suite 5""` in `topmostSubform[0].Page1[0].Address[0].f1_8[0]`.
- Root cause hypothesis from code inspection: `parseCSV` in `server/index.js` splits rows with `line.split(",")`, so quoted commas are not respected.
- Product/model implication: CSV tools should return structured preview rows or validation summaries. Otherwise Claude can overclaim a data-integrity check because `extract_to_csv` only returns path and field count.

## Local Fix Batch - 2026-04-23 16:18 PT

| Change | Status | Evidence |
| --- | --- | --- |
| CSV parser fixed | Pass locally | `parseCSV` now handles quoted fields, escaped quotes, BOM-prefixed first headers, CRLF, and commas inside quoted values; malformed row-width, blank-header, and duplicate-header CSVs are rejected |
| CSV writer hardened | Pass locally | `extract_to_csv` now escapes headers/values with doubled quotes |
| Structured preview output added | Pass locally | `bulk_fill_from_csv` returns bounded `preview_records`; `extract_to_csv` returns headers/counts and bounded `preview_rows` in `structuredContent` without returning full row data |
| Regression fixture added | Pass locally | `test/fixtures/claude-batch3-bulk.csv` includes comma-bearing W-9 field values |
| Regression test added | Pass locally | `test/csv-roundtrip.test.js` validates comma preservation, escaped quotes/CRLF/BOM handling, bounded preview metadata, and malformed row-width rejection |
| Focused test | Pass locally | `npx vitest run test/csv-roundtrip.test.js`: 1 file, 1 test passed |
| Full suite | Pass locally | `npm test`: 17 files, 172 tests passed after adversarial-review hardening; known post-success Vitest close timeout warning remains |
| MCPB rebuild | Pass locally | `mcpb pack` produced `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb`, SHA1 `c7cbfe3831386efce4b44e672908e312421466cb`, 32.5 MB |
| Same-version reinstall attempt | Initially blocked, then resolved | Opening the rebuilt `.mcpb` first showed the extension details modal without overwrite; after user uninstall/reinstall flow, installed bundle changed |
| Installed bundle verification | Pass in Claude Desktop | `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.open-document-alliance.pdf-toolkit/server/index.js` contains `preview_records`, `formatCSVValue`, and `Malformed CSV`; no `line.split(',')` match |
| User uninstall | Done by user | User confirmed they uninstalled the Claude Desktop extension and asked Codex to reinstall the rebuilt MCPB |
| Reinstalled MCPB SHA | Pass in Claude Desktop | Source artifact verified as SHA1 `c7cbfe3831386efce4b44e672908e312421466cb`; installed server timestamp `Apr 23 16:29:40 2026` |
| Hardened MCPB rebuild after adversarial review | Pass locally | `mcpb pack` produced `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb`, version `0.8.2`, SHA1 `6ab474388c6445ae6c3db1533ce1d85ba8fd31c1`, 32.5 MB |

Important status: the final hardened `0.8.2` MCPB is active in Claude Desktop.
The installed local extension bundle contains the fixed parser/writer,
structured preview fields, row-width/header validation, and bounded
`extract_to_csv` metadata.

## Automated Batch 1 - 2026-04-23 15:59 PT

| Command | Status | Notes |
| --- | --- | --- |
| `npm run build:ui` | Pass | Built production viewer in 233 ms |
| `npm test` | Pass | 16 files, 169 tests; post-success Vite close timeout warning |
| `npm run smoke:ui-dev` | Pass | Viewer and MCP bridge responded at local dev URL |
| `npm run smoke:ui-sign` | Pass | First sandboxed run failed because `~/.agent-browser` was not writable; rerun with escalation passed |
| `npm run smoke:ui-inspect` | Pass | Inspect-region preview modal opened in real browser harness |
| `npm run smoke:ui-preview-zone` | Pass | Region preview became a custom signature zone and opened sign modal |
| `npm run smoke:ui-draw` | Pass | Draw-signature modal accepted stroke and save flow closed successfully |

## Latest Observation

Claude Desktop Chat Batches 1, 2, and the Batch 3 rerun are green at the
tool/file level. The original Batch 3 exposed a real release blocker in the
installed MCPB's CSV handling: `bulk_fill_from_csv` corrupted quoted comma
values generated by `extract_to_csv`, because the installed server CSV parser
split on every comma instead of respecting quoted fields. This is now fixed in
the local repo, covered by a regression test, rebuilt into the MCPB, verified
in the installed Claude Desktop extension bundle, and rerun successfully in a
fresh Claude Desktop chat.

Sonnet 4.6 used the installed PDF Tools MCPB correctly for display, field
reading, synthetic form fill, output display, validation, file listing, PDF
info, resource URI generation, profiles, and CSV tools. The original Batch 3
showed a model/tooling evidence gap because Sonnet marked the comma round-trip
as PASS without direct CSV row evidence. The rerun improved that behavior:
Sonnet refused to overclaim when Claude Desktop did not visibly render row-level
`structuredContent` preview data.

Manual embedded viewer controls are also green in Claude Desktop: page
navigation moved to page `2 of 4`, zoom changed to `125%`, search found
`FATCA` with `7 of 15` matches and visible highlights, and fullscreen mode
opened/exited without losing viewer state.

Automated build/test/dev-viewer gates are green. The real-browser dev harness
confirmed that Sign mode, inspect-region, preview-to-zone, and draw-signature
flows still respond after the current package build. The only failure observed
in the automated batch was sandbox-related: `agent-browser` could not write to
`~/.agent-browser` until the command was rerun with escalation.

Cowork did not expose local PDF Tools desktop extension tools. This confirms the
local MCPB should be tested and documented as Claude Desktop Chat/local MCP host
functionality, while Cowork requires a separate remote connector path.

## Next Batch

Recommended next step: continue the release docket with a fresh Claude Desktop
chat for text/visual tools (`read_pdf_content`, `read_pdf_pages`,
`search_pdf_text`, `render_pdf_page`, `render_pdf_region`) and then page
operations/signature guardrails. Keep using local CSV/file inspection for any
data-integrity claims that Claude Desktop does not render directly.

## Claude Desktop Batch 3 Rerun - 2026-04-23 16:32 PT

| Item | Status | Evidence |
| --- | --- | --- |
| Fresh chat started | Pass | `claude.ai/chat/e7ee5dc5-9716-4cb2-8c5b-395566cbb872` |
| Installed bundle before rerun | Pass | Installed server contains `preview_records`, `formatCSVValue`, and `Malformed CSV`; no `line.split(',')` match |
| Rerun scope | Complete | Profile save/load, profile fill/display, extract CSV, bulk fill from generated CSV, re-extract CSV, compare comma-bearing street field from structured preview rows |
| Claude Desktop rerun | Conditional pass from Claude | Sonnet 4.6 used the installed PDF Tools extension, saved/loaded profile, filled/displayed the PDF, extracted CSV, bulk-filled from generated CSV, and re-extracted; it correctly refused to claim preview-row proof because Claude Desktop did not render row-level `structuredContent` in the visible tool result |
| Local CSV verification | Pass | `batch3-rerun-extracted-from-profile.csv` row 2 contains `"789 Comma Blvd, Suite 5"`; `batch3-rerun-extracted-after-bulk.csv` row 2 also contains `"789 Comma Blvd, Suite 5"` |
| Regression pattern check | Pass | `rg '789 Comma Blvd|Suite 5|""789|Suite 5""' ...` found only correct quoted comma values in the rerun CSVs; the old corrupted `""789 Comma Blvd` / `Suite 5""` split did not recur |
| Post-rerun focused regression | Pass | `npx vitest run test/csv-roundtrip.test.js`: 1 file, 3 tests passed after adversarial-review hardening; known post-success Vitest close timeout warning |
| Post-rerun full suite | Pass | `npm test`: 17 files, 172 tests passed on version `0.8.2`; known post-success Vitest close timeout warning |

Conclusion: Batch 3 rerun is green at the tool/file level after reinstall. The
tool fix works in Claude Desktop, but Claude Desktop currently does not expose
row-level `structuredContent` preview data clearly enough for Sonnet to cite it
directly in the chat UI. That host visibility gap should remain on the testing
docket as a model/tool-evidence UX issue, not as a CSV correctness blocker.

## Adversarial Review - 2026-04-23 16:38 PT

| Finding | Status | Resolution |
| --- | --- | --- |
| CSV parser silently accepted shifted/overflow rows | Fixed | Added row-width validation so malformed unquoted comma rows return `Malformed CSV: row N has X values, expected Y` instead of silently filling shifted values |
| `extract_to_csv` returned all rows while advertising preview rows | Fixed | Removed full `rows` from `structuredContent`; kept `row_count`, `preview_row_count`, headers, and first 3 `preview_rows` |
| Ledger overclaimed parser evidence | Fixed | Updated evidence to match expanded tests and current implementation |
| Vitest close-timeout warning remains noisy | Known residual | Still documented as a post-success warning; not fixed in this tranche |

Things rechecked clean: `server/index.js` and
`pdf-toolkit-mcp-share/server/index.js` remain identical, the original
`line.split(",")` parser is gone from both bundles, CSV writer values are still
quote-escaped, and the focused CSV tests now cover the adversarial data-integrity
cases that mattered for this release candidate.

Packaging note: after this review, `mcpb pack` rebuilt
`/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb` as version
`0.8.2` with SHA1 `6ab474388c6445ae6c3db1533ce1d85ba8fd31c1`.

## Claude Desktop 0.8.2 Reinstall - 2026-04-23 16:49 PT

| Item | Status | Evidence |
| --- | --- | --- |
| User uninstall | Done by user | User confirmed they uninstalled the previous PDF Tools extension before reinstall |
| `0.8.2` MCPB opened | Pass | `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb`, SHA1 `6ab474388c6445ae6c3db1533ce1d85ba8fd31c1` |
| Install completed | Pass | Claude Desktop extension details modal shows `Uninstall`, `Enabled`, and version `0.8.2` |
| Installed manifest verification | Pass | Installed manifest reports version `0.8.2` |
| Installed server verification | Pass | Installed server contains `Malformed CSV: row`, `duplicate header`, `blank header`, `row_count`, `preview_row_count`, and `preview_rows`; no `rows: allData` or `line.split` match |
| Installed server timestamp | Pass | `Apr 23 16:49:34 2026`, size `159805` bytes |

Next action: start a fresh Claude Desktop chat for the text/visual tools batch.

## Claude Desktop Batch 4 Text/Visual Tools - 2026-04-23 16:50 PT

| Item | Status | Evidence |
| --- | --- | --- |
| Fresh chat started | In progress | `claude.ai/chat/fab75b46-1197-492e-86e0-956f9ca64c3c` |
| Installed bundle before batch | Pass | Installed PDF Tools version `0.8.2`; server contains row-width/header hardening and bounded preview metadata |
| Batch scope | In progress | `get_pdf_info`, `read_pdf_content`, `read_pdf_pages`, `search_pdf_text`, `get_page_analysis`, `render_pdf_page`, `render_pdf_region`, `display_pdf` on W-9 fixture |
| `get_pdf_info` | Pass | 4 pages, 22 form fields, 612x792 pt, 123.26 KB, not encrypted |
| `read_pdf_content` | Pass | 32,942 characters extracted; snippets included W-9 header text and page 4 identity-theft text |
| `read_pdf_pages` | Pass | Page-scoped snippets returned for pages 1 and 2 |
| `search_pdf_text` | Pass | `FATCA` returned 10 matches across pages 1-2 with page-numbered snippet evidence |
| `get_page_analysis` | Pass / host-partial | MCP log confirms structuredContent included `total_pages`, `majority_orientation`, per-page dimensions, rotation, orientation, text lengths, snippets, and image flags. Claude's visible chat only summarized `Analyzed 4 pages`. |
| `render_pdf_page` | Fail | Tool error: native canvas binding missing, `Cannot find native binding`; PNG render unavailable |
| `render_pdf_region` | Fail | Same native canvas binding failure as `render_pdf_page` |
| `display_pdf` | Pass | Viewer opened `w9-form-source.pdf`, 123 KB, 22 form fields detected |

Conclusion: text/search/viewer path is green in installed `0.8.2`, but
server-side visual rendering is release-blocked by missing native canvas binding
inside the installed MCPB runtime. Next action is to inspect package contents and
dependency resolution before rebuilding/reinstalling.

## Render Binding Follow-up - 2026-04-23 16:57 PT

| Item | Status | Evidence |
| --- | --- | --- |
| Installed native package present | Pass | Installed bundle contains `node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node` |
| Shell import from installed bundle | Pass | `import("@napi-rs/canvas")` works from the installed extension cwd and exposes `createCanvas` |
| Claude runtime failure reproduced in logs | Pass | Claude MCP log shows `render_pdf_page` and `render_pdf_region` failed with `Cannot find native binding`; Claude main log shows stack at installed `server/index.js:94` |
| Likely failure class | In progress | The installed package is present and shell-loadable, so the working hypothesis is Electron/Claude MCP utility-process module resolution or native binding loading behavior, not a missing file |
| Code mitigation | Pass locally | `server/index.js` now pre-resolves the platform native binding path and temporarily sets `NAPI_RS_NATIVE_LIBRARY_PATH` during `@napi-rs/canvas` import; failures now include nested cause-chain details |
| Version bump | Pass locally | Updated package/manifest versions to `0.8.3` so Claude Desktop can distinguish the render-binding rebuild from installed `0.8.2` |
| Full local tests | Pass | `npm test`: 17 files, 172 tests passed; known post-success Vitest close-timeout warning remains |
| Render local tests | Pass | `npx vitest run test/render-pdf-page.test.js`: 1 file, 9 tests passed; known post-success close-timeout warning remains |

Next action: pack `0.8.3`, reinstall it into Claude Desktop, restart/start a
fresh Claude chat, and rerun the two render tools plus `get_page_analysis`
visibility check.

## Claude Desktop 0.8.3 Reinstall - 2026-04-23 17:02 PT

| Item | Status | Evidence |
| --- | --- | --- |
| `0.8.3` MCPB packed | Pass | `mcpb pack` produced `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb`, SHA1 `b74ec44d010374e4852fc7dfa741e3502fecdb50`, 32.5 MB |
| Computer Use install | Pass | Used Computer Use to click Claude Desktop `Update`, `Install`, and confirmation `Install` controls |
| Claude UI state | Pass | Extension details modal shows `Uninstall`, `Enabled`, and version `0.8.3` |
| Installed manifest verification | Pass | Installed manifest reports version `0.8.3` |
| Installed server verification | Pass | Installed server contains `getCanvasNativeBindingCandidate`, `NAPI_RS_NATIVE_LIBRARY_PATH`, and `formatErrorChain` mitigation |
| Installed native package verification | Pass | Installed bundle contains `@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node` |

Next action: start a fresh Claude chat and rerun `render_pdf_page`,
`render_pdf_region`, and `get_page_analysis` on the W-9 fixture.

## Render Binding Root Cause and 0.8.4 Fix - 2026-04-23 17:14 PT

| Item | Status | Evidence |
| --- | --- | --- |
| `0.8.3` Claude render retest | Fail | Fresh chat `claude.ai/chat/5038ef66-bc5c-4513-a066-f7ef6a69e3ee`; `render_pdf_page` and `render_pdf_region` still failed |
| Root cause clarified | Pass | New error chain shows `ERR_DLOPEN_FAILED`: `@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node` code signature is not valid inside Claude UtilityProcess because mapped file and process have different Team IDs |
| `get_page_analysis` retest | Pass / host-partial | MCP log again confirms structuredContent with 4 pages, dimensions, orientation, text lengths/snippets, and `has_images`; visible chat may summarize only |
| System-renderer fallback | Pass locally | Added macOS `sips` fallback for render tools when native canvas fails or `PDF_TOOLS_FORCE_SYSTEM_RENDERER=1` is set |
| MCP server version | Pass locally | Updated hard-coded MCP `serverInfo.version` from stale `0.8.1` to `0.8.4` |
| Full local tests | Pass | `npm test`: 17 files, 172 tests passed; known post-success Vitest close-timeout warning remains |
| Forced fallback render tests | Pass | `PDF_TOOLS_FORCE_SYSTEM_RENDERER=1 npx vitest run test/render-pdf-page.test.js`: 1 file, 9 tests passed; known close-timeout warning remains |

Next action: pack and reinstall `0.8.4`, then rerun the render/page-analysis
Claude Desktop retest in a fresh chat.

## Claude Desktop 0.8.4 Reinstall - 2026-04-23 17:15 PT

| Item | Status | Evidence |
| --- | --- | --- |
| `0.8.4` MCPB packed | Pass | `mcpb pack` produced `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb`, SHA1 `42490de9d2054f4bef7f778b1174c236d90c4d25`, 32.5 MB |
| Claude Desktop install attempt | Blocked | Opening the MCPB caused Claude main log to record `Handling DXT/MCPB file`, but no visible install/update window was controllable |
| Computer Use visibility | Blocked | `get_app_state("Claude")` timed out after 120s while Claude processes were running |
| Installed manifest after manual reinstall | Fail | Installed extension still reports version `0.8.3`; `0.8.4` is not installed yet |
| Claude Desktop relaunch recovery | Blocked | Clean quit/reopen and targeted GUI-process terminate/reopen both left Claude Desktop running with no visible window; screenshots showed only desktop wallpaper |
| Fallback decision | In progress | Normal Claude Desktop installer UI is unreachable through Computer Use. Next step is a backed-up manual overlay from the unpacked `0.8.4` MCPB into Claude's local extension directory, then manifest/server verification. |
| Manual overlay backup | Pass | Backed up installed `0.8.3` extension to `/tmp/pdf-toolkit-claude-extension-backup-0.8.3-20260423-1746` before writing new files |
| Manual overlay install | Pass | Overlaid `/tmp/pdf-toolkit-mcpb-084-unpack` into Claude's local PDF Tools extension directory using `ditto` |
| Installed manifest after overlay | Pass | Installed extension now reports version `0.8.4` |
| Installed server after overlay | Pass | Installed server contains `renderSinglePagePdfWithSips`, `PDF_TOOLS_FORCE_SYSTEM_RENDERER`, `NAPI_RS_NATIVE_LIBRARY_PATH`, and `serverInfo.version` `0.8.4`; installed server hash matches unpacked `0.8.4` server hash `be2d80a6356b5bef513ceb3751efe10169441cff` |
| Direct installed MCP render smoke | Pass | Launched the installed extension server over MCP stdio with `PDF_TOOLS_FORCE_SYSTEM_RENDERER=1`; `render_pdf_page` returned PNG + structured metadata `930x1204` scale `1.52`; `render_pdf_region` returned PNG + structured metadata `720x240` scale `4` |
| Claude Desktop chat retest | Blocked | Claude Desktop runtime starts and logs extension scanning, but no visible/accessibility window is available for Computer Use or chat entry |
| Claude window recovery attempts | Blocked | `osascript activate`, `open -a Claude`, targeted GUI-process terminate/reopen, and `open 'claude://new'` did not produce a visible/accessibility window; System Events reports zero Claude windows and Computer Use continues to time out |
| Share bundle sync | Pass | Ran `node package-for-friend.js`; copied the updated server/helpers/UI into `pdf-toolkit-mcp-share/` and rebuilt `pdf-toolkit-mcp.zip` |
| Final full test suite | Pass | `npm test`: 17 files, 172 tests passed; known post-success Vitest close-timeout warning remains |
| Final forced system-render test | Pass | `PDF_TOOLS_FORCE_SYSTEM_RENDERER=1 npx vitest run test/render-pdf-page.test.js`: 1 file, 9 tests passed; known post-success Vitest close-timeout warning remains |
| Test runner caveat | Noted | Do not run the full render suite and forced-render suite concurrently; both touch `.test-tmp-render`, and concurrent cleanup can cause a false ENOENT failure |
| Adversarial review fixes | Pass | Added renderer provenance to render tool text/structured output, tightened forced/system-renderer fallback gating, made timed-out child cleanup wait for process close, fixed top-level ledger install status, and resynced the share bundle server |
| Final `0.8.4` MCPB packed | Pass | Rebuilt `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb`, SHA1 `8dd4a308bbd183bfd3738ae4f79826c00c51e095`, 32.5 MB |
| Final installed overlay | Pass | Unpacked final MCPB to `/tmp/pdf-toolkit-mcpb-084-final-unpack` and overlaid it into Claude's local extension directory |
| Final installed hash verification | Pass | Installed server, final MCPB unpack server, root `server/index.js`, and share `pdf-toolkit-mcp-share/server/index.js` all hash to `4563518f2b032ee32083fb73c287f0438885e538` |
| Final installed MCP render smoke | Pass | Installed extension stdio smoke with `PDF_TOOLS_FORCE_SYSTEM_RENDERER=1` returned PNGs and structured `renderer: macos-sips`; page `930x1204` scale `1.52`, region `720x240` scale `4` |
| Final Claude MCP runtime reload | Pass | After terminating/reopening Claude Desktop, Claude's own MCP log initialized PDF Tools with `serverInfo.version` `0.8.4` at `2026-04-24T01:21:47.797Z` |
| Final Computer Use UI check | Blocked | `get_app_state("com.anthropic.claudefordesktop")` still timed out after runtime reload, so chat-level retest is still blocked by Claude Desktop window/accessibility state |

Next action: recover a visible Claude Desktop window/accessibility surface, then
retest `render_pdf_page`, `render_pdf_region`, and `get_page_analysis` in a
fresh Claude chat against the already-loaded `0.8.4` MCP runtime.
