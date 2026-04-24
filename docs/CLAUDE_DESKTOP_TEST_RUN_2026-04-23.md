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
| Latest pushed commit | `c09a34d fix(render): fall back to macos pdf renderer` |
| MCPB artifact | `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb` |
| Original MCPB SHA1 | `71cd7ae1a650e0c2f92a2156de3b8a12353473a6` |
| Rebuilt fixed MCPB SHA1 | `c7cbfe3831386efce4b44e672908e312421466cb` |
| Latest hardened MCPB SHA1 | `8dd4a308bbd183bfd3738ae4f79826c00c51e095` |
| Installed extension id | `local.mcpb.open-document-alliance.pdf-toolkit` |
| Installed version | `0.8.4` by backed-up manual overlay; normal Claude Desktop installer UI was blocked, but final Claude chat/runtime render retest passed after window recovery |
| Claude Desktop modes | Chat supported; Cowork boundary confirmed unsupported for local MCPB |

## Fixtures

| Fixture | Path | Notes |
| --- | --- | --- |
| W-9 sample source | `/Users/silverbook/Sites/pdf-toolkit-mcp/example-fw9.pdf` | Repo anonymized fixture |
| W-9 allowed-folder copy | `/Users/silverbook/Downloads/pdf-toolkit-smoke-example-fw9.pdf` | Used for Claude Desktop Chat smoke |
| Batch test folder | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23` | Dedicated allowed-folder outputs |
| Batch 1 W-9 source copy | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/w9-form-source.pdf` | SHA1 `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1` |
| Batch 1 filled W-9 output | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/w9-filled-batch1.pdf` | SHA1 `a962504b160091735124c23637ba7af3f384e46d` |
| Non-form text fixture | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/non-form-text-084.pdf` | Generated harmless one-page fixture; SHA1 `b054e95a10a123d439b4f95155528498b8678ea1` |
| Image-only fixture | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/image-only-084.pdf` | Generated harmless one-page image-only fixture; SHA1 `7fbbc752eddb41520715b2e73849ecc34b413292` |
| Public URL fetch fixture | `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/fetched-dummy-084.pdf` | W3C dummy PDF fetched through installed MCP; SHA1 `90ffd2359008d82298821d16b21778c5c39aec36` |

## Claude Chat Ledger

| Chat | Mode | URL / Identifier | Purpose | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Cowork | `claude.ai/local_sessions/local_7f48421e-a345-46cc-851d-22b461fa790f` | Boundary test | Expected fail | Cowork did not find PDF Tools in deferred registry; treated as product boundary, not MCPB failure |
| 2 | Chat | `claude.ai/chat/48a5b9cf-bbaa-4206-849d-baafd302edd9` | Packaged MCPB smoke | Pass | `display_pdf` rendered inline viewer for W-9 sample |
| 3 | Chat | `claude.ai/chat/f3a5d11c-192b-41f5-8e93-39f51a3059ea` | Batch 1 form workflow | Pass | Sonnet 4.6 ran `display_pdf`, `read_pdf_fields`, `fill_pdf`, `display_pdf`, `validate_pdf` |
| 4 | Chat | `claude.ai/chat/22ce6b12-2415-48e0-a3f4-9e46de6d8d56` | Batch 2 viewer/file workflow | Pass | Sonnet 4.6 ran `display_pdf`, `list_pdfs`, `get_pdf_info`, `get_pdf_resource_uri`; manual viewer controls passed |
| 5 | Chat | `claude.ai/chat/33f761d2-0cdb-42be-a42b-aa208f1c2f68` | Batch 3 profile/CSV workflow | Fail | Profiles passed, but CSV comma round-trip failed by local CSV inspection; Sonnet overclaimed pass without direct CSV evidence |
| 6 | Chat | `claude.ai/chat/e7ee5dc5-9716-4cb2-8c5b-395566cbb872` | Batch 3 rerun after reinstall | Pass with host caveat | Tool/file-level CSV round-trip passed after reinstall; Sonnet correctly marked visible `structuredContent` preview-row evidence insufficient because Claude Desktop did not render row-level JSON |
| 7 | Chat | `claude.ai/chat/23676ac8-d714-4682-ae02-a153c82bcfdf` | 0.8.4 render retest | Pass with host caveat | `render_pdf_page` and `render_pdf_region` returned PNGs via `macos-sips`; `get_page_analysis` structuredContent was present in MCP log but Claude visible text underreported it |
| 8 | Chat | `claude.ai/chat/6d708ca8-de66-48c1-bc3f-1158aa5cdc74` | 0.8.4 positive page ops | Pass with host caveat | Merge/split/rotate/reorder/apply-plan passed; Claude duplicated `split_pdf` once |
| 9 | Chat | `claude.ai/chat/48f5a78a-2bd4-4447-beec-1d5aeb917967` | 0.8.4 page-op error paths | Pass with host caveat | Five intentional errors returned clear text errors; Claude showed empty embedded viewers for two error results even though no output files were written |
| 10 | Chat | `claude.ai/chat/7cc9b84e-a216-418f-aba9-31ef65639597` | 0.8.4 signature guardrails | Pass with model caveat | Detection/create/list/load and intent rejections passed; Sonnet guessed placeholder coordinates instead of using detected zone coordinates |
| 11 | Direct stdio | Installed extension server | Corrective signature coordinate check | Pass with host caveat | Claude Desktop window disappeared after restart, so exact detected-zone placeholder was verified through the installed MCP server directly |
| 12 | Direct stdio | Installed extension server | Non-form/image/permissions checks | Pass with host caveat | Claude Desktop window still unavailable; installed MCP server passed fixture and permission checks directly |
| 13 | Direct stdio | Installed extension server | URL fetch security checks | Pass with host caveat | Public PDF download passed with documented parameters; loopback URL rejected |

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
| Claude install | Pass | Installed manifest is version `0.8.4` after backed-up manual overlay; Claude runtime initialized PDF Tools with `serverInfo.version` `0.8.4` |
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
| Viewer | Non-form PDF render | Pass direct installed MCP | `non-form-text-084.pdf` rendered page 1 to PNG `698 x 903 px`; direct stdio renderer `native-canvas` |
| Forms | `read_pdf_fields` | Pass in Claude Chat | 22 fields enumerated; representative names included `f1_1`, `f1_2`, `c1_1`, `f1_7`, `f1_14`/`f1_15` |
| Forms | `fill_pdf` | Pass in Claude Chat | Synthetic values written to `w9-filled-batch1.pdf`; tool reported 14 field writes |
| Forms | `validate_pdf` partially filled | Pass in Claude Chat | Output reported 13 filled / 9 empty; empty fields were optional or intentionally blank in test |
| Profiles | `save_profile` / `load_profile` / `list_profiles` | Pass in Claude Chat | Throwaway profile `pdf_toolkit_batch3_profile_20260423`; comma-bearing value was intact in profile storage |
| Profiles | `fill_with_profile` | Pass in Claude Chat | Output `w9-profile-batch3.pdf`; 6 fields filled |
| CSV | `bulk_fill_from_csv` | Pass after reinstall | Original installed MCPB failed on quoted commas; fixed MCPB rerun preserved `"789 Comma Blvd, Suite 5"` through generated CSV -> bulk fill -> re-extract |
| CSV | `extract_to_csv` | Pass with host caveat | Generated valid quoted CSV and returns row previews in `structuredContent`; Claude Desktop did not render row-level preview JSON visibly to Sonnet in the chat UI |
| Text/visual | `read_pdf_content` text PDF | Pass in Claude Chat | W-9 text extraction returned 32,942 characters in Batch 4 |
| Text/visual | scanned/image PDF behavior | Pass direct installed MCP | `image-only-084.pdf` returned no text, `extraction_mode=image-fallback`, `has_images=true`, and page render PNG `698 x 903 px` |
| Text/visual | `read_pdf_pages` | Pass in Claude Chat | Page-scoped snippets returned for W-9 pages 1 and 2 in Batch 4 |
| Text/visual | `search_pdf_text` | Pass in Claude Chat | `FATCA` returned 10 matches across pages 1-2 in Batch 4 |
| Text/visual | `render_pdf_page` | Pass in Claude Chat | Final 0.8.4 chat retest returned PNG, `1236 x 1600 px`, `scale=2.02`, `renderer=macos-sips` |
| Text/visual | `render_pdf_region` | Pass in Claude Chat | Final 0.8.4 chat retest returned PNG crop, `1200 x 320 px`, `scale=4`, `renderer=macos-sips` |
| Files | `list_pdfs` allowed folder | Pass in Claude Chat | Found `w9-form-source.pdf` and `w9-filled-batch1.pdf` in the dedicated Downloads test folder |
| Files | `get_pdf_info` form PDF | Pass in Claude Chat | Source: 4 pages, 123.26 KB, 22 fields, not encrypted; filled: 4 pages, 128.38 KB, 22 fields, not encrypted |
| Files | `get_pdf_info` non-form PDF | Pass direct installed MCP | `non-form-text-084.pdf`: 1 page, 0.97 KB, no form fields, encrypted no |
| Files | `get_pdf_resource_uri` | Pass in Claude Chat | Returned `pdf:///Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/w9-form-source.pdf` |
| Page ops | `merge_pdfs` success | Pass in Claude Chat | `pageops-merged-084.pdf`, 8 pages, SHA1 `7839fb61aed4fd930082f6a79226e5dfd7decb40` |
| Page ops | `merge_pdfs` empty array error | Pass in Claude Chat | MCP log id `32`: `Error: input_paths must be a non-empty array of PDF file paths.`; no error-output file written |
| Page ops | `merge_pdfs` same input/output error | Pass in Claude Chat | MCP log id `34`: `Error: output_path must be different from all input paths to prevent file corruption.`; source SHA1 remained `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1` |
| Page ops | `split_pdf` exact ranges | Pass in Claude Chat | `1-2,3-4` produced two 2-page PDFs; SHA1s `a8fbb09c81428bff97a08ba3e129f2d56e62f814`, `226907c084b92129dfd3ab1bd73af044d4fa1130` |
| Page ops | `split_pdf` every-N pages | Not run | Use 4-page W-9 or generated fixture |
| Page ops | `split_pdf` invalid range | Pass in Claude Chat | MCP log id `35`: `Error: Page 100 is out of range (1-4).`; no output directory/file written |
| Page ops | `rotate_pdf_pages` | Pass in Claude Chat | `pageops-rotated-084.pdf`, 4 pages, 22 form fields preserved, SHA1 `e2bdee07ecd3ad2b92bb89ffc063f47a9b7bd783` |
| Page ops | `rotate_pdf_pages` invalid page | Pass in Claude Chat | MCP log id `37`: `Error: Page 99 is out of range (1-4).`; no error-output file written |
| Page ops | `reorder_pdf_pages` | Pass in Claude Chat | `pageops-reordered-084.pdf`, 4 pages, SHA1 `3218dc9ad97257481ce488430122ba9c64f511cd` |
| Page ops | `apply_page_plan` | Pass in Claude Chat | `pageops-plan-084.pdf`, 2 pages, 2 pages removed and 1 rotated, SHA1 `810228e1047114a0f1c76ae06c16ef3a03fd8bc7` |
| Page ops | `apply_page_plan` invalid page | Pass in Claude Chat | MCP log id `38`: `Error: Page 99 is invalid (must be integer 1-4).`; no error-output file written |
| Page ops UI | Manage tab rotate/reorder/delete/save | Not run | Needs Chat UI interaction |
| Signatures | `detect_signature_zones` | Pass in Claude Chat | MCP log id `39`: found 2 zones; signature zone page 1 `x=79`, `y=502.1`, `width=260`, `height=18`, confidence `0.92`; date zone page 1 `x=381.6`, `y=510.8`, `width=110`, `height=18` |
| Signatures | Sign tab opens | Pass in dev smoke | `smoke:ui-sign` opened Sign mode and signing modal in real browser dev harness |
| Signatures | `create_signature` typed | Pass in Claude Chat | MCP log id `40`: saved typed synthetic local asset `pdf-toolkit-synthetic-typed-084`; no PDF signed |
| Signatures | `list_signatures` / `load_signature` | Pass in Claude Chat | MCP log ids `41` and `42`: listed 5 signatures and loaded `pdf-toolkit-synthetic-typed-084` with display name `PDF Toolkit Synthetic Tester` |
| Signatures | `add_signature_field` placeholder | Pass with model caveat | MCP log id `43`: wrote `sign-placeholder-084.pdf`, SHA1 `0e52bf134f446718ffa29422d3a5d40889b7ab00`; Sonnet guessed `(72,670,200,36)` instead of using detected zone `(79,502.1,260,18)` |
| Signatures | `add_signature_field` exact detected zone | Pass direct installed MCP | Direct installed stdio call wrote `sign-placeholder-detected-084.pdf` at `(79,502.1,260,18)`, SHA1 `5788441716a373279661ef2b592f89e0c594e466`; `get_pdf_info` verified 4 pages and 22 fields |
| Signatures | `apply_signature` missing intent rejection | Pass in Claude Chat | MCP log id `44`: rejected empty intent/timestamp; no `sign-error-missing-intent-084.pdf` written |
| Signatures | `apply_signature` stale timestamp rejection | Pass in Claude Chat | MCP log id `45`: rejected `2026-04-22T00:00:00Z` as more than 24 hours old; no `sign-error-stale-intent-084.pdf` written |
| Signatures | `apply_signature` fresh intent success | Deferred | Do not run until the user provides a verbatim signing-intent sentence for this exact synthetic signing test |
| Permissions | Allowed directory succeeds | Pass direct installed MCP | `list_pdfs` with `ALLOWED_DIRECTORIES=~/Downloads` found 13 PDFs in the dedicated Downloads test folder |
| Permissions | Disallowed directory rejected | Pass direct installed MCP | `get_pdf_info` on repo `example-fw9.pdf` rejected with allowed-directory error listing `~/Downloads` and `~/.pdf-toolkit-files` |
| Permissions | User config allowed directory update | Not run | Only if needed; avoid broad access |
| Security | `fetch_pdf_from_url` public URL | Pass direct installed MCP | W3C dummy PDF fetched to `fetched-dummy-084.pdf`, 13 KB, 1 page, SHA1 `90ffd2359008d82298821d16b21778c5c39aec36` |
| Security | `fetch_pdf_from_url` private/metadata blocked | Pass direct installed MCP | Loopback URL `http://127.0.0.1:80/private.pdf` rejected: `Refusing to download from private/loopback host "127.0.0.1"` |
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

Installed Claude Desktop runtime is now verified on `0.8.4`, including the
macOS `sips` render fallback. Final Chat retest returned PNGs from
`render_pdf_page` and `render_pdf_region` with structured
`renderer=macos-sips` metadata. Positive page operations are green:
merge/split/rotate/reorder/apply-plan all produced valid PDFs and were verified
with `get_pdf_info` plus local SHA1 evidence.

The page-operation error-path batch is also green. Empty merge, same
input/output merge, out-of-range split, out-of-range rotate, and invalid
`apply_page_plan` all returned clear error text and wrote no error-output files.
The source fixture checksum stayed `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1`
after the self-overwrite rejection test.

Four host/model caveats remain on the docket. Claude Desktop sometimes renders
empty embedded PDF viewers after tool calls that actually returned text errors,
it still does not visibly expose all structuredContent details to Sonnet for
evidence-heavy claims, Sonnet ignored detected signature-zone coordinates in
the first signature placeholder batch by guessing `(72,670,200,36)`, and
Claude Desktop's accessibility window disappeared again after restart. The
exact detected-zone placeholder was verified through the installed MCP server
directly at `(79,502.1,260,18)`. Non-form, image-only, permission, and URL
fetch security checks also passed through direct installed MCP stdio while the
Claude window was unavailable. For release confidence, continue pairing Claude
visible chat output with MCP log and local file/hash inspection.

Cowork did not expose local PDF Tools desktop extension tools. This confirms the
local MCPB should be tested and documented as Claude Desktop Chat/local MCP host
functionality, while Cowork requires a separate remote connector path.

## Next Batch

Recommended next step: recover Claude Desktop's visible/accessibility window if
possible, then continue with permissions, non-form/image-only PDFs, and optional
Opus tool-choice behavior if the model picker exposes Opus. Keep using local
CSV/file/hash inspection for any data-integrity claims that Claude Desktop does
not render directly.

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

## Claude Desktop 0.8.4 Final Chat Retest - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Claude Desktop window recovery | Pass | User confirmed Claude Desktop was open; Computer Use attached successfully to `com.anthropic.claudefordesktop` on `claude.ai/new` |
| Runtime before chat retest | Pass | Previous Claude MCP log initialization showed PDF Tools `serverInfo.version` `0.8.4` after final overlay/restart |
| Fresh chat started | Pass | `claude.ai/chat/23676ac8-d714-4682-ae02-a153c82bcfdf`, titled `PDF Tools 0.8.4 render testing`, on Sonnet 4.6 |
| Installed MCP runtime in chat | Pass | Claude MCP log initialized PDF Tools with `serverInfo.version` `0.8.4` at `2026-04-24T01:33:05.998Z` |
| Tool selection discipline | Pass / extra call | Claude used the installed `PDF Tools - View, Fill, Merge, Split, Manage Pages, Extract` integration. It made one extra `render_pdf_page` call without `max_dimension_px` before the exact requested call. |
| `render_pdf_page` exact call | Pass | MCP log id `4`: `page=1`, `max_dimension_px=1600`, returned PNG image; structured metadata `rendered_width_px=1236`, `rendered_height_px=1600`, `scale=2.02`, `renderer=macos-sips`, `mime_type=image/png` |
| `render_pdf_region` exact call | Pass | MCP log id `5`: `page=1`, `x=20`, `y=20`, `width=300`, `height=80`, `max_dimension_px=1200`, returned PNG image; structured metadata `rendered_width_px=1200`, `rendered_height_px=320`, `scale=4`, `renderer=macos-sips`, `mime_type=image/png` |
| `get_page_analysis` exact call | Pass / host-partial | MCP log id `6` returned structuredContent with `total_pages=4`, `majority_orientation=portrait`, and per-page width/height/display width/display height/rotation/orientation/text_length/text_snippet/has_images. Claude visible chat incorrectly summarized that structured per-page metadata was not returned. |

## Claude Desktop 0.8.4 Page Ops Batch - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Fresh chat cadence | Pass | Started a new Claude Desktop chat after the render batch to avoid compaction/tool-history drag |
| Chat | Pass | `claude.ai/chat/6d708ca8-de66-48c1-bc3f-1158aa5cdc74`, titled `PDF Tools 0.8.4 page operations batch test` |
| Batch scope | Pass | Positive page operations: `merge_pdfs`, `split_pdf`, `rotate_pdf_pages`, `reorder_pdf_pages`, `apply_page_plan`, and `get_pdf_info` verification on outputs |
| `merge_pdfs` | Pass | MCP log id `9`: merged `w9-form-source.pdf` + `w9-filled-batch1.pdf` into `pageops-merged-084.pdf`, 8 pages, 116 KB; `get_pdf_info` id `25` verified 8 pages |
| `split_pdf` exact ranges | Pass / duplicate call | MCP log ids `13` and `14`: split `w9-form-source.pdf` by `1-2,3-4`; both calls produced `w9-form-source_pages_1-2_1.pdf` and `w9-form-source_pages_3-4_2.pdf`; `get_pdf_info` ids `29` and `30` verified 2 pages each |
| `rotate_pdf_pages` | Pass | MCP log id `16`: rotated pages `[1,3]` by 90 degrees into `pageops-rotated-084.pdf`; `get_pdf_info` id `26` verified 4 pages and 22 form fields |
| `reorder_pdf_pages` | Pass | MCP log id `21`: reordered pages `[4,3,2,1]` into `pageops-reordered-084.pdf`; `get_pdf_info` id `27` verified 4 pages |
| `apply_page_plan` | Pass | MCP log id `24`: wrote `pageops-plan-084.pdf` with `page_order=[2,1]` and rotation on original page 2; tool reported 2 pages removed and 1 rotated; `get_pdf_info` id `28` verified 2 pages |
| Host/tool-loading behavior | Noted | Claude loaded the PDF Tools app resource and embedded viewers for page-operation outputs, which triggered `read_pdf_bytes` and `set_active_document` calls. This is host UI behavior, not a server failure. |
| Output file evidence | Pass | Local SHA1s: merged `7839fb61aed4fd930082f6a79226e5dfd7decb40`; rotated `e2bdee07ecd3ad2b92bb89ffc063f47a9b7bd783`; reordered `3218dc9ad97257481ce488430122ba9c64f511cd`; plan `810228e1047114a0f1c76ae06c16ef3a03fd8bc7`; split files `a8fbb09c81428bff97a08ba3e129f2d56e62f814` and `226907c084b92129dfd3ab1bd73af044d4fa1130` |

## Claude Desktop 0.8.4 Page Ops Error Batch - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Fresh chat cadence | Pass | Started a new Claude Desktop chat after the positive page-ops batch to avoid compaction/tool-history drag |
| Chat | Pass | `claude.ai/chat/48f5a78a-2bd4-4447-beec-1d5aeb917967`, titled `PDF Tools error path testing batch`, on Sonnet 4.6 |
| Batch scope | Pass | Intentional error cases for `merge_pdfs`, `split_pdf`, `rotate_pdf_pages`, and `apply_page_plan` using only the installed PDF Tools MCP extension |
| `merge_pdfs` empty array | Pass | MCP log id `32`: `Error: input_paths must be a non-empty array of PDF file paths.` No `pageops-error-empty-merge.pdf` exists on disk |
| `merge_pdfs` same input/output | Pass | MCP log id `34`: `Error: output_path must be different from all input paths to prevent file corruption.` Source file SHA1 remained `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1`, matching repo `example-fw9.pdf` |
| `split_pdf` invalid range | Pass | MCP log id `35`: `Error: Page 100 is out of range (1-4).` No output files were created in `pageops-error-invalid-range` |
| `rotate_pdf_pages` invalid page | Pass | MCP log id `37`: `Error: Page 99 is out of range (1-4).` No `pageops-error-rotate.pdf` exists on disk |
| `apply_page_plan` invalid page | Pass | MCP log id `38`: `Error: Page 99 is invalid (must be integer 1-4).` No `pageops-error-plan.pdf` exists on disk |
| Host error-result caveat | Noted | Claude displayed empty embedded PDF viewers for the two `merge_pdfs` error responses even though the MCP log shows text-only errors and no output files. Treat as Claude host/UI behavior to watch, not server data loss. |

Next action: start a fresh Claude Desktop chat for signature/legal guardrails,
then non-form/image-only fixtures and permissions.

## Claude Desktop 0.8.4 Signature Guardrail Batch - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Fresh chat cadence | Pass | Started a new Claude Desktop chat after the page-op error batch |
| Chat | Pass | `claude.ai/chat/7cc9b84e-a216-418f-aba9-31ef65639597`, titled `PDF signature guardrail batch testing`, on Sonnet 4.6 |
| Batch scope | Pass | Signature-zone detection, synthetic typed signature asset create/list/load, placeholder field write, and two intentional `apply_signature` rejection cases |
| `detect_signature_zones` | Pass | MCP log id `39`: found 2 zones; signature zone page 1 `x=79`, `y=502.1`, `width=260`, `height=18`, confidence `0.92`; date zone page 1 `x=381.6`, `y=510.8`, `width=110`, `height=18` |
| `create_signature` typed asset | Pass | MCP log id `40`: saved `pdf-toolkit-synthetic-typed-084` at `~/.pdf-toolkit-files/signatures/pdf-toolkit-synthetic-typed-084.json`; local SHA1 `220285cc2c180c28b968c737a4016f0e0e578b46`; this does not sign a PDF |
| `list_signatures` / `load_signature` | Pass | MCP log ids `41` and `42`: listed 5 signatures and loaded the synthetic typed signature with display name `PDF Toolkit Synthetic Tester` |
| `add_signature_field` placeholder | Pass with model caveat | MCP log id `43`: wrote `sign-placeholder-084.pdf`, size 126,765 bytes, SHA1 `0e52bf134f446718ffa29422d3a5d40889b7ab00`. Sonnet guessed coordinates `(72,670,200,36)` instead of using detected zone `(79,502.1,260,18)` despite being asked to use a detected zone. |
| `apply_signature` empty intent | Pass | MCP log id `44`: rejected with `Error: apply_signature requires 'user_intent_statement' ... Agents must elicit this from the user before calling this tool; do not invent one.` No `sign-error-missing-intent-084.pdf` exists on disk. |
| `apply_signature` stale intent timestamp | Pass | MCP log id `45`: rejected with `Error: user_confirmed_at is more than 24 hours old (50.0h). Re-confirm with the user before signing.` No `sign-error-stale-intent-084.pdf` exists on disk. |
| Fresh valid signature | Deferred | Correctly not attempted. User has not provided a verbatim signing-intent sentence for this exact synthetic signing test, and the tool instructions prohibit fabricating one. |
| Source safety | Pass | `w9-form-source.pdf` SHA1 remained `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1` after the batch |

Next action: run a focused corrective batch for exact signature-zone coordinate
use. This is a Sonnet/tool-use discipline check, not a server blocker.

## Direct Installed MCP Exact Signature-Zone Check - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Claude Desktop window state | Blocked | After `osascript activate`, `open -a Claude`, quit, and relaunch, Computer Use could not reacquire a Claude Desktop accessibility window (`cgWindowNotFound`, then 120s timeout) |
| Fallback path | Pass | Ran the installed extension server directly over MCP stdio from `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.open-document-alliance.pdf-toolkit/server/index.js` with `ALLOWED_DIRECTORIES=~/Downloads` |
| Exact detected-zone placeholder | Pass | `add_signature_field` wrote `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/sign-placeholder-detected-084.pdf` at page 1, `x=79`, `y=502.1`, `width=260`, `height=18`, label `Synthetic QA detected zone` |
| Output verification | Pass | `get_pdf_info` returned 4 pages, 123.80 KB, 612x792 pt, 22 form fields, encrypted no; local SHA1 `5788441716a373279661ef2b592f89e0c594e466` |
| Region render verification | Pass | `render_pdf_region` on the exact zone returned PNG metadata `1040 x 72 px`, `scale=4`, `renderer=native-canvas`, `mime_type=image/png`. Direct stdio used `native-canvas`; Claude Desktop chat runtime render fallback remains previously verified as `macos-sips`. |

Conclusion superseded by the Sign-tab visual check below. The server handled
the exact coordinates it was given, but the detected coordinates themselves
were visually misaligned for the IRS W-9 signing row. The previous batch caught
Sonnet's guessed-coordinate issue but missed the server placement bug because
it verified metadata, hashes, and a cropped region rather than the full-page
human-visible overlay.

Next action: recover Claude Desktop's visible/accessibility window before more
Chat-level tests, or continue low-level installed-MCP validation for fixtures
that do not need model/host behavior.

## Sign-Tab Visual Regression: IRS W-9 Zone Alignment - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| User-reported visual defect | Confirmed | Screenshot `CleanShot 2026-04-23 at 20.49.08@2x.png` shows the page-1 signature zone in `pageops-merged-084.pdf` sitting too high/left relative to the visible `Signature of U.S. person` signing line; date zone is also high |
| Root cause | Confirmed | `SIGNATURE_PATTERNS` used `placement: "above"` for `Signature of...` and bare `Date`; on this W-9 the text is split across `Signature of` at `y=522.1`, `U.S. person` + arrow at `y=530.8`, and `Date` + arrow at `y=530.8`, so the old heuristic emitted `signature x=79 y=502.1` and `date x=381.6 y=510.8` |
| Why prior tests missed it | Confirmed | `test/zone-detection.test.js` only checked zone existence/bounds, and the golden fixture allowed a broad `y=490..580` region with `min_score=0.5`, so a visibly high zone still passed |
| Fix implemented | Pass local repo | Detector now anchors zones after decorative arrow markers and stops before the next same-row label; local `example-fw9.pdf` now detects `signature x=130.7 y=524.3 width=244.9 height=18` and `date x=410.2 y=524.3 width=110 height=18` |
| Regression guard | Pass local repo | Added an IRS W-9 row-placement assertion and tightened `test/fixtures/golden-forms/expected.json` for `example-fw9` to `min_score=1` with narrower signing-row bounds |
| Test command | Pass | `npm test -- --run test/zone-detection.test.js test/golden-set-placement.test.js` passed `22` tests; Vitest still reports the existing post-pass close timeout due to an open server handle |
| Full local suite | Pass | `npm test` passed `17` test files and `173` tests; same existing Vitest post-pass close timeout warning appeared |
| Adversarial review follow-up | Pass local repo | Reviewer flagged overly broad decorative-marker anchoring; code now only treats known arrow glyphs as signing anchors, falls back when marker-derived zones are too narrow, and adds a synthetic bullet regression so ordinary bullets do not move a `Signature` zone |
| Re-test after review fix | Pass | `npm test -- --run test/zone-detection.test.js test/golden-set-placement.test.js` passed `23` tests; helper files are byte-identical between `server/` and `pdf-toolkit-mcp-share/server/` |
| Full local suite after review fix | Pass | `npm test` passed `17` test files and `174` tests; same existing Vitest post-pass close timeout warning appeared |
| Rebuilt extension artifact | Pass local repo | `npm run build:ui` passed and `mcpb pack` produced `pdf-toolkit-mcp.mcpb` / `pdf-toolkit-0.8.4.mcpb`, package size `32.5MB`, shasum `e53d7f51b0fc717ae3b222afaf357d84f70aff62` |

## Sign-Tab Visual Regression: Rotated Page Zone Alignment - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| User-reported visual defect | Confirmed | Screenshot `CleanShot 2026-04-23 at 20.49.45@2x.png` shows `pageops-rotated-084.pdf` page 1 rotated 90 degrees while the Sign overlay remains horizontal/unrotated relative to the page content |
| Root cause | Confirmed | The PDF canvas used PDF.js viewport rotation, but Sign mode positioned zones with raw native coordinates (`x * scale`, `y * scale`) and did not transform label/preview content by page rotation |
| Fix implemented | Pass local repo | Viewer now stores the current rendered PDF.js viewport, maps native top-left zone rectangles through `convertToViewportRectangle`, maps pointer drags back through `convertToPdfPoint`, rotates zone label/preview/applied-badge content inside the native signing box, and ignores stale viewports during page/render transitions |
| Durable smoke | Pass | Added `npm run smoke:ui-sign-rotated`; it creates 90/180/270-degree W-9 fixtures and asserts expected overlay shape, position, and transform. Observed 90° `18 x 244.890625` at `left=249.65625, top=130.6875`; 180° `244.890625 x 18` at `left=236.375, top=249.65625`; 270° `18 x 244.890625` at `left=524.296875, top=236.375` |
| Full local suite | Pass | `npm test` passed `17` test files and `174` tests; same existing Vitest post-pass close timeout warning appeared |
| Packaging | Pass local repo | `npm run build:ui`, `node package-for-friend.js`, and `mcpb pack` passed; rebuilt MCPB shasum `601d5b26fc13472bfdad940076583d93a206c38e` |

## Direct Installed MCP Non-Form, Image-Only, Permissions - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Fixture generation | Pass | Created harmless fixtures in `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23`: `non-form-text-084.pdf` SHA1 `b054e95a10a123d439b4f95155528498b8678ea1`; `image-only-084.pdf` SHA1 `7fbbc752eddb41520715b2e73849ecc34b413292` |
| Hung fixture attempt | Noted | First image-fixture generation attempt hung on an invalid/overcomplicated PNG embed path and was stopped with `pkill -f "PDF Toolkit non-form text fixture"`; no repo files were touched |
| Fallback path | Pass | Ran installed extension server directly over MCP stdio with `ALLOWED_DIRECTORIES=~/Downloads` because Claude Desktop accessibility remained unavailable |
| Non-form `get_pdf_info` | Pass | `non-form-text-084.pdf`: 1 page, 0.97 KB, 612x792 pt, form fields none, encrypted no |
| Non-form `read_pdf_content` | Pass | Extracted 111 characters; `structuredContent.text_found=true`, `extraction_mode=text`, 1 page read |
| Non-form `get_page_analysis` | Pass | 1 portrait page, `text_length=111`, `has_images=false` |
| Non-form `render_pdf_page` | Pass | Returned PNG metadata `698 x 903 px`, `scale=1.14`, direct stdio renderer `native-canvas` |
| Image-only `get_pdf_info` | Pass | `image-only-084.pdf`: 1 page, 0.93 KB, 612x792 pt, form fields none, encrypted no |
| Image-only `read_pdf_content` | Pass | Returned no extracted text and image fallback: `text_found=false`, `extraction_mode=image-fallback`, `image_renderer=native-canvas` |
| Image-only `get_page_analysis` | Pass | 1 portrait page, `text_length=0`, `has_images=true` |
| Image-only `render_pdf_page` | Pass | Returned PNG metadata `698 x 903 px`, `scale=1.14`, direct stdio renderer `native-canvas` |
| Allowed directory | Pass | `list_pdfs` in the dedicated Downloads test folder found 13 PDFs with `ALLOWED_DIRECTORIES=~/Downloads` |
| Disallowed directory | Pass | `get_pdf_info` on `/Users/silverbook/Sites/pdf-toolkit-mcp/example-fw9.pdf` rejected: extension only allowed `/Users/silverbook/Downloads` and `/Users/silverbook/.pdf-toolkit-files` |

Conclusion: server-level fixture and permission behavior is green in the
installed bundle. Remaining release-confidence gaps are Claude Desktop
host/model behavior, not these underlying tool paths.

## Direct Installed MCP URL Fetch Security - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Fallback path | Pass | Ran installed extension server directly over MCP stdio with `ALLOWED_DIRECTORIES=~/Downloads` because Claude Desktop accessibility remained unavailable |
| Public fetch, wrong parameter attempt | Noted | A first call used unsupported `output_path`; tool ignored it and correctly defaulted to `/Users/silverbook/Downloads/dummy.pdf`. Follow-up `get_pdf_info` on the nonexistent requested path failed. This is caller/API-shape friction, not a server failure. |
| Public fetch, documented parameters | Pass | `fetch_pdf_from_url` with `destination_dir` and `filename` downloaded W3C dummy PDF to `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/fetched-dummy-084.pdf`, 13 KB, SHA1 `90ffd2359008d82298821d16b21778c5c39aec36` |
| Public fetch verification | Pass | `get_pdf_info` on `fetched-dummy-084.pdf`: 1 page, 12.95 KB, 595x842 pt, form fields none, encrypted no |
| Private/loopback block | Pass | `fetch_pdf_from_url` on `http://127.0.0.1:80/private.pdf` rejected with `Error: Refusing to download from private/loopback host "127.0.0.1". Set allow_private_hosts=true if this is intentional.` |
| Local artifact caveat | Noted | The initial unsupported-parameter call left `/Users/silverbook/Downloads/dummy.pdf` with the same SHA1 as the final fetched fixture. It is harmless but outside the dedicated test folder. |

Conclusion: installed MCP URL fetch works for public PDFs and blocks loopback by
default. The main product caveat is that Claude/model callers should use
`destination_dir` + `filename`, not `output_path`.

## Canonical Save Lifecycle: Fill, Sign, Managed Output - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| User question | Answered in local MCP test | Prior Claude Desktop batches had verified visual placement, form filling, and page outputs, but had not explicitly tested whether fill/sign mutate the existing active file or create a new chain of files |
| In-place fill behavior | Pass local repo | `fill_pdf` with `pdf_path === output_path` modified `.test-tmp-save-lifecycle/w9-working.pdf`, returned `active_path` equal to the same path, and created a first-mutation backup under the test `DEFAULT_PROFILES_DIR` |
| In-place signature behavior | Pass local repo | `apply_signature` with the same `pdf_path`/`output_path` kept `active_path` on `w9-working.pdf`, reused the same `backup_path`, and did not create a sibling signed PDF |
| Active document after sign | Pass local repo | `get_active_document` returned `active_path=.test-tmp-save-lifecycle/w9-working.pdf`, `backup_path` matching the first fill backup, and `last_mutation_tool=apply_signature` |
| Managed page edit behavior | Fixed and tested | `apply_page_plan` still writes a separate `_managed.pdf` by design, but now immediately returns structured active-document payload and updates server state so `get_active_document` points at the managed output before the viewer catch-up path runs |
| Post-managed mutation behavior | Pass local repo | `apply_text` on `.test-tmp-save-lifecycle/w9-managed-source_managed.pdf` mutated that managed output in place, created a backup for the managed file, and did not create `_managed_managed.pdf` or other sibling outputs |
| Regression guard | Pass | Added `test/save-lifecycle.test.js` covering same-path fill + actual signature and managed-output + subsequent same-path text stamp |
| Test command | Pass | `npm test -- test/save-lifecycle.test.js` passed 1 file / 3 tests; same existing Vitest close-timeout warning appeared after pass |
| Adversarial review follow-up | Pass local repo | Reviewer found that new-output helper forced `hasFormFields=false`, which would hide fields after `rotate_pdf_pages` even when rotation preserved the AcroForm. Helper now lets `buildActiveDocumentPayload` detect fields, and the lifecycle test asserts rotated W-9 output remains `hasFormFields=true` with 22 fields. |
| Backup-content guard | Pass local repo | Lifecycle test now hashes the same-path backup against the original file before mutation and hashes the managed-file backup against the managed output before the next stamp. |
| Full local suite | Pass | `npm test` passed 18 test files / 177 tests; same existing Vitest close-timeout warning appeared after pass |
| Packaging | Pass local repo | `npm run build:ui`, `node package-for-friend.js`, and `mcpb pack` passed. Rebuilt MCPB shasum `7f78a7411de83fa541480f0895d0cc0ce41d6a80`; zip shasum `1e942035fb2b8499ab63ed5b94098fc3cfdba8a1` |

Conclusion: the intended UX is now explicit and guarded. Fill/sign/date tools
can mutate the current canonical PDF in place with one backup. Page-management
tools create a new managed output by design, and that output becomes the
canonical active document for the next Claude/viewer operation. Rotating a
fillable PDF preserves immediate form metadata in the viewer payload.

## Claude Desktop Host Reinstall + Save Lifecycle - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Install artifact | Pass | User reported they installed rebuilt `pdf-toolkit-mcp.mcpb` after uninstall, and Claude Desktop subsequently loaded PDF Tools `0.8.4` tools from the installed extension. Local artifact shasum before install: `7f78a7411de83fa541480f0895d0cc0ce41d6a80` |
| Fixture setup | Pass | Created `/Users/silverbook/Downloads/pdf-toolkit-lifecycle-host-2026-04-24/lifecycle-host-w9.pdf` and `lifecycle-host-managed.pdf`, both initial SHA1 `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1` |
| Host-level lifecycle test | Pass | Fresh Claude Desktop chat `PDF Tools host-level lifecycle test` ran installed PDF Tools `0.8.4` tools: `read_pdf_fields`, `fill_pdf`, `detect_signature_zones`, `create_signature`, `apply_signature`, `get_active_document`, `apply_page_plan`, `apply_text`, and `list_pdfs` |
| Same-path fill/sign | Pass | Claude filled and signed `/Users/silverbook/Downloads/pdf-toolkit-lifecycle-host-2026-04-24/lifecycle-host-w9.pdf` with `output_path == pdf_path`; final SHA1 `f481290e30d8e2b4609bf3a2362872299c275371`; `pdf-lib` loads it as 4 pages / 22 fields with signature audit metadata |
| W-9 backup | Pass | Backup `/Users/silverbook/.pdf-toolkit-files/backups/lifecycle-host-w9__2026-04-24T14-35-18-058Z.pdf` exists and SHA1 is `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1`, matching the pre-test source |
| Managed output lifecycle | Pass | `apply_page_plan` created `/Users/silverbook/Downloads/pdf-toolkit-lifecycle-host-2026-04-24/lifecycle-host-managed_managed.pdf`; `apply_text` then mutated that same managed output in place; final SHA1 `c302c3bfa36773f58806581e80f5ae3436638644`; `pdf-lib` loads it as 1 page / 0 fields with text-stamp audit metadata |
| Managed source untouched | Pass | `/Users/silverbook/Downloads/pdf-toolkit-lifecycle-host-2026-04-24/lifecycle-host-managed.pdf` remains SHA1 `701a9e72dfe1c92ae42ce6e4b89dfa706d9c71b1` |
| Managed backup | Pass | Backup `/Users/silverbook/.pdf-toolkit-files/backups/lifecycle-host-managed_managed__2026-04-24T14-38-21-789Z.pdf` exists; SHA1 `cd2ccb55927f1495ad132a70045866a9ec518202` |
| Folder file inventory | Pass | Independent shell check found exactly three PDFs in the fixture folder: `lifecycle-host-w9.pdf`, `lifecycle-host-managed.pdf`, and `lifecycle-host-managed_managed.pdf`; no `lifecycle-host-managed_managed_managed.pdf` or signed sibling was created |
| Active-document behavior | Pass per Claude Desktop tool results | Claude reported `get_active_document` returned W-9 `active_path` with `last_mutation_tool=apply_signature`, then managed output `active_path` with `last_mutation_tool=apply_page_plan`, then managed output with `last_mutation_tool=apply_text` and backup path after stamping |
| Embedded viewer after XFA fill | Needs follow-up | After `fill_pdf` with `force_xfa=true`, the embedded viewer panel displayed `Invalid PDF structure` even though `fill_pdf` succeeded, `detect_signature_zones` and `apply_signature` worked afterward, and independent `pdf-lib` loading succeeded. Treat as a host/viewer render regression or XFA round-trip display edge case to investigate separately. |

Conclusion: the reinstalled Claude Desktop extension passes the save-lifecycle
test at host level. The canonical-file behavior is correct: same-path fill/sign
mutates the active file with backup, page management creates one managed output
by design, and subsequent edits mutate that managed output in place. The only
new follow-up is the embedded viewer's `Invalid PDF structure` display after an
XFA in-place fill despite successful tool operations and parseable output.

## W-9 Signature Zone Placement Fix - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Bug reproduced | Pass | Screenshot showed the W-9 signature overlay sitting on the printed `Signature of U.S. person` label baseline and the date overlay slightly high/misaligned. Local render overlay confirmed the old marker-baseline output placed signature/date zones at `y=524.3`, covering the label row. |
| Root cause | Pass | `markerAnchoredZone` used arrow marker baseline for both horizontal and vertical placement. On W-9-style captioned rows, the arrow identifies the horizontal start, but the signing/date surface is the blank row above the caption/arrow baseline. |
| Fix | Pass | `server/helpers.js` now distinguishes direct markers from continuation markers. Captioned rows (`Signature`, `Initials`, `Date`, or continuation-marker layouts) use marker-x with above-line y; same-baseline `Signature of X -> line` layouts stay centered on the marker row. |
| W-9 corrected coordinates | Pass | On `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/pageops-merged-084.pdf`, `detectSignatureZones` now returns page 1 signature `x=130.7 y=510.8 width=244.9 height=18` and date `x=410.2 y=510.8 width=110 height=18`, placing both on the blank signing row rather than the printed labels. |
| Regression tests | Pass | Added/updated tests for W-9 blank-line placement, same-baseline arrow layouts, and golden fixture expectations. `npm test -- --run test/zone-detection.test.js test/golden-set-placement.test.js test/signatures.test.js` passed `66` tests. Full `npm test` passed `178` tests. Vitest still prints the existing post-pass `close timed out after 10000ms` warning. |
| Rotated overlay math | Pass with driver caveat | Deterministic PDF.js viewport check for corrected native zone produced rotated overlay positions: 90° `left=263.2/top=130.7`, 180° `left=236.4/top=263.2`, 270° `left=510.8/top=236.4`. `scripts/dev-ui-rotated-sign-smoke.mjs` expectations were updated accordingly. Browser smoke was attempted twice, but `agent-browser` failed with `Resource temporarily unavailable`; prior pre-fix smoke had passed and the failure was driver/daemon read failure, not a product assertion. |
| Adversarial review | Pass | Subagent review found three issues: runtime version still advertised `0.8.4`, same-baseline arrow layouts could be shifted too high, and rotated smoke expectations were stale. All three were addressed before packaging. |
| Package artifacts | Pass | Version bumped to `0.8.5` across `package.json`, `package-lock.json`, `manifest.json`, `manifest.mcpb.json`, share package, and runtime server info. Rebuilt `pdf-toolkit-mcp.zip` SHA256 `968e6810e2b639b3e758539a7ecac5910fec26cf323855e53b504b7c46c7c429`; rebuilt `pdf-toolkit-mcp.mcpb` SHA256 `9662465fe9ce3aeae853ab7d1e4a69f86faae2e08b3926904bf5e627f6cd7b29`. |

Conclusion: W-9 signature/date overlays now target the blank signing surface,
not the printed caption line. Rotated overlay expectations were adjusted to the
new native coordinates, but a clean browser-driver smoke rerun in a healthy
`agent-browser` session is still worth doing before calling the Claude Desktop
visual pass fully closed.

## Claude Desktop 0.8.5 Reinstall + Visual Zone Confirmation - 2026-04-24

| Item | Status | Evidence |
| --- | --- | --- |
| Start state | Pass | User requested explicit uninstall/reinstall of rebuilt `pdf-toolkit-mcp.mcpb` in Claude Desktop and visual confirmation that W-9 signature/date zones land on the signing row. Artifact installed: `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb`, SHA256 `9662465fe9ce3aeae853ab7d1e4a69f86faae2e08b3926904bf5e627f6cd7b29`. |
| Uninstall old extension | Pass | Quit Claude Desktop, backed up old `local.mcpb.open-document-alliance.pdf-toolkit` extension/settings/registry to `/tmp/pdf-toolkit-claude-extension-backup-2026-04-24`, then removed only the PDF Tools extension directory, settings file, and `extensions-installations.json` entry. Verified `extension_dir_removed`, `settings_removed`, and `registry_removed`. |
| Reinstall 0.8.5 MCPB | Pass | Opened `/Users/silverbook/Sites/pdf-toolkit-mcp/pdf-toolkit-mcp.mcpb` explicitly with Claude Desktop after uninstall. Claude installer/details dialog shows PDF Tools enabled, `Version 0.8.5`, and an `Uninstall` button, confirming the rebuilt extension is installed. |
| Installed registry verification | Pass | Claude Desktop `extensions-installations.json` contains `local.mcpb.open-document-alliance.pdf-toolkit` version `0.8.5`, hash `9662465fe9ce3aeae853ab7d1e4a69f86faae2e08b3926904bf5e627f6cd7b29`, installed at `2026-04-24T17:22:49.847Z`. Installed manifest also reports `version: 0.8.5`. |
| Claude Desktop tool run | Pass with response caveat | Fresh Claude Desktop chat `PDF Tools 0.8.5 signature zone detection test` loaded PDF Tools, ran `detect_signature_zones`, then ran `display_pdf` on `/Users/silverbook/Downloads/pdf-toolkit-test-run-2026-04-23/pageops-merged-084.pdf`. Claude's natural-language response confirmed `4 zones` (`2 signature zones and 2 date zones`) and the viewer rendered successfully, but the raw coordinate JSON was not exposed in Claude's final text. |
| Installed-code coordinate verification | Pass | Imported the installed extension's own `server/helpers.js` from `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.open-document-alliance.pdf-toolkit` and ran `detectSignatureZones` against the test PDF. Page 1 returns signature `x=130.7 y=510.8 width=244.9 height=18` and date `x=410.2 y=510.8 width=110 height=18`. |
| Desktop visual overlay verification | Pass | In the live Claude Desktop `display_pdf` embedded viewer, switched to the `Sign` tab. The page 1 W-9 overlay shows `Sign here` on the blank certification signing line and `Date` on the date line, not on the old printed-label baseline at `y=524.3`. No signing or PDF mutation was performed. |

Conclusion: 0.8.5 was fully uninstalled/reinstalled in Claude Desktop and the
installed extension is the rebuilt MCPB hash. The W-9 signature/date zone fix is
confirmed in installed-code coordinates and in the live Claude Desktop embedded
viewer. The only caveat is Claude's chat response did not surface raw zone JSON,
so exact coordinate confirmation came from the installed extension files on disk
rather than Claude's final prose.
