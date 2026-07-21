# Deterministic release-candidate evidence — 2026-07-21

## Outcome and claim boundary

PDF Tools commit `d96239f` produced a byte-reproducible MCPB that passed the
complete integrated Linux gate and a clean extracted-server smoke on native
macOS arm64. The companion share ZIP also rebuilt to its previously reviewed
hash and passed its clean Linux contract.

This is release-candidate evidence, not a release record. The MCPB was not
published, and this run did not install or drive it through Claude Desktop's
GUI, chat tool catalog, Electron utility process, or embedded viewer. Windows
native execution remains unproved. No signature tool was called and no private
document was used.

## Exact artifacts

| Artifact | SHA-256 | Bytes | Entries |
|---|---|---:|---:|
| `pdf-toolkit-mcp.mcpb` | `b586221595cc3095d43f73daf3b66c6cc9695bddcd98365f46c445a597d9a1b4` | 72,456,666 | 2,821 |
| `pdf-toolkit-mcp.zip` | `a479b22ec797d0757072c6d0df136655b90b8fcc8e8c1662b70077bc2d2269f1` | 945,777 | 16 |

The source dependency graph retains the exact protected
`pdfjs-dist@5.4.624` version. The MCPB contains the intended Darwin arm64,
Darwin x64, Linux x64 GNU, Windows arm64 MSVC, and Windows x64 MSVC canvas
bindings. Presence of those five files is inventory evidence; only Linux x64
GNU and Darwin arm64 were executed in this run.

## Canonical MCPB build

`npm run build:mcpb` performed two clean production installs in isolated child
processes. Both produced the exact MCPB identity above. The larger measured
child peak RSS was 707,816 KiB; this is an observation, not an enforced memory
limit.

The repository-owned writer and verifier established:

- UTF-8-byte-sorted, forward-slash paths;
- fixed `1980-01-01 00:00:00` DOS timestamps in every timezone;
- regular-file mode `0100644`, deflate level 9, and no ZIP extras/comments;
- exact stage-to-archive path and byte parity;
- exact first-party inventory of five server modules and one bundled UI file;
- all five intended native packages and no forbidden production prefixes;
- no duplicate or unsafe paths, symlinks, or special files;
- high-confidence first-party secret-name/content scanning;
- pinned MCPB 2.1.2 manifest validation plus final `info` and `unpack`;
- Info-ZIP integrity before same-directory atomic activation.

Activation re-stats and re-hashes the second candidate immediately before
rename. Short and same-length candidate mutations, file/directory `fsync`
failures, and rename failures fail before activation and preserve the previous
output. If the post-rename directory `fsync` fails, the command truthfully
reports `activated: true` with the new output identity because rollback is no
longer possible.

An independent adversarial re-review returned PASS after reproducing the exact
MCPB bytes. Its 27 focused checks rejected local- and central-header mutation,
EOCD comments, trailing bytes, candidate mutation, and durability-failure
misclassification. All 418 available IANA timezones produced one artifact
hash. The reviewer also consumed the artifact with MCPB 2.1.2, Info-ZIP, Python
`zipfile`, and the packed Linux smoke.

## Integrated verification

| Gate | Result |
|---|---|
| Full Vitest suite | 32 files, 363/363 tests |
| Seed-410 shuffled suite | 32 files, 363/363 tests |
| Concurrency | Normal and shuffled full suites passed concurrently |
| Required online golden set | 2/2 |
| Viewer/UI workflows | Six passed: bridge, sign, inspect, draw, preview-to-zone, and 90°/180°/270° rotated signing geometry |
| Production dependency audit | 0 known vulnerabilities at the run time |
| Production dependency tree | `npm ls --omit=dev --all` passed; only expected platform-optional packages were absent on Linux |
| Packed Linux runtime | 37 tools, 14 prompts, canonical resources, native PNG raster |
| MCPB archive inspection | 2,821 unique entries, zero duplicates, no reviewed forbidden/secret-like paths |

The VM AppArmor policy prevents Chrome's normal sandbox from starting, so the
six browser workflows used the reviewed `agent-browser` lane with
`--no-sandbox`. That exception is specific to this VM harness and is not a
product runtime configuration.

## Native macOS arm64 direct-runtime proof

The exact MCPB bytes were copied to the designated arm64 Mac, re-hashed there,
and extracted into a fresh temporary directory. Homebrew Node 26.3.1 launched
the packaged server against two deterministic synthetic fixtures whose hashes
matched the prior host record.

The result was:

- 37 unique tools;
- exact tool-contract SHA-256
  `6ba7b256ae9fad3f91de949d847668543de559d2e14efea151226c95ee66a6ea`;
- 31 structured-output tools and 6 intentionally text-only tools;
- six calls in one MCP session plus discovery and a call in a fresh session;
- configured-directory success, outside-directory denial, and recovery after
  that denial;
- extraction of marker `BLUEHARBOR-TEXT-20260721`;
- safe two-page split into two one-page outputs; and
- native raster PNG SHA-256
  `2c091ce5a7ed045beda03ba13ed04e67347b2d5bad16652d1f160e6685e27e01`.

The normalized JSON result has SHA-256
`20240169a77ce8f84f706b3d2dc2cc9ccc8be5ca026446e5fa01dd0d68d84d64`.
This proves the packaged Darwin arm64 server and native canvas binding. It does
not prove Claude Desktop installation, chat exposure, settings propagation, or
viewer lifecycle for this exact hash.

## Companion share-package evidence

The share ZIP's exact npm v3 lock covers all 112 production package records.
Its CycloneDX 1.6 SBOM contains 112 components and 113 dependency records:

- SBOM SHA-256:
  `a5907f1bb071e0339a0c7e61c6909b1f7191490dfcb56857718f7c3f92e6b4ed`
- provenance SHA-256:
  `a44fa6bc59e8879bb750e459972e243d1d04eed3e12335a07796d991c2e974ed`

The artifact rebuilt byte-identically and passed the transactional clean Linux
install: lock equality, SBOM/provenance validation, 37 tools, 14 prompts,
resources, policy behavior, safe mutation, and native raster. A separate clean
macOS arm64 installation previously produced the same tool-contract and raster
evidence. Windows clean install/render remains the open share-package gate.

## Remaining release gates

- Install this exact MCPB through current Claude Desktop and verify fresh-chat
  discovery, repeated tool calls, prompts, viewer rendering, settings, and
  lifecycle behavior after CUA Accessibility and Screen Recording are granted.
- Run the corresponding Windows x64 Claude Desktop and share-package lanes.
- Expand packed PDF.js coverage for uncommon CMap, JPX/JBIG2, and ICC cases;
  the protected 5.4.624 pin remains unchanged until those host regressions are
  independently disproved.
- Do not describe the bounded accessibility Phase 0 pilot as PDF/UA, WCAG,
  legal-compliance, or certification evidence.

Any repack creates a new hash and must repeat the artifact and native-host gates.
