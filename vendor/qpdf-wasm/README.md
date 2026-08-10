# ODA QPDF WebAssembly build recipe

This directory contains a reproducible, ODA-controlled build of the QPDF
command-line interface for Node.js WebAssembly. The generated JavaScript and
WebAssembly are shipped in both the MCPB and the share ZIP, from
`vendor/qpdf-wasm/runtime/`, but no PDF Tools tool loads, executes, or depends
on them yet. Packaging is deliberately a separate step from integration: the
artifact is proven to arrive intact and loadable in a packaged tree before any
tool is allowed to rely on it.

## What ships

`vendor/qpdf-wasm/runtime/` is the promoted, committed copy of a verified
build: `qpdf.mjs`, `qpdf.wasm`, the complete `licenses/` notice directory, and
the build's own `BUILD-INPUTS.json` and `THIRD_PARTY_VERSIONS.txt`. Both
packagers stage that directory at the identical archive path, so the same
relative path resolves in the checkout, in the unpacked MCPB, and in an
installed share package.

`vendor/qpdf-wasm/runtime.provenance.json` binds it: pinned source hashes and
the Emscripten image digest from `sources.lock.json`, the artifact hashes from
`expected-output.json`, the notice hashes from `licenses/manifest.json`, and
the size and SHA-256 of every shipped file. It is generated, never hand-edited.
Promote a new build with:

```bash
node scripts/vendor-qpdf-wasm-runtime.mjs /absolute/path/to/extracted/build
```

The promotion refuses any build that does not already reproduce
`expected-output.json`, so a locally patched artifact cannot become the shipped
one.

## Pinned baseline

The complete input contract is in `sources.lock.json`:

- QPDF 12.3.2, the latest published stable release as of July 21, 2026
- zlib 1.3.2
- libjpeg-turbo 3.2.0
- Emscripten 6.0.3 on `linux/amd64`, pinned by container image digest

QPDF's online `latest` documentation currently identifies 12.4.0 as not yet
released. Do not replace the stable 12.3.2 source with a moving branch. Before
shipping this runtime, review the final 12.4 release and its malformed-PDF,
warning-limit, page-tree, annotation, and writer fixes. Upgrade only through a
new pinned source hash and the full adversarial test gate.

The build uses QPDF's native crypto provider. It does not link OpenSSL or
GnuTLS, and it does not enable insecure random numbers. The Node smoke proves
that Emscripten's virtual `/dev/urandom` path supports QPDF encryption.

## Fetch and verify sources

Run:

```bash
npm run qpdf-wasm:fetch
```

The fetcher downloads official release archives into the ignored `sources/`
directory. Every archive is verified against its SHA-256 before it is renamed
into place. A cached file is reused only after the same verification. Source
archives and `node_modules` must not be committed here.

## Two gates: which runs when

There are deliberately two, and only one of them is cheap enough to run on the
developer inner loop.

| | Fast gate | Full reproducibility gate |
| --- | --- | --- |
| Command | `npm test` (suite: `test/qpdf-wasm-runtime-artifact.test.js`) | `npm run qpdf-wasm:verify` |
| Cost | Under a second | About 45 minutes under x86-64 emulation on Apple Silicon |
| Needs | Node only | Docker |
| Runs on | Every `npm test`, every CI run | **Release and nightly only** |

The fast gate does not rebuild anything. It hashes the committed runtime and
requires it to equal `expected-output.json` byte for byte, requires the
provenance to carry the pinned source hashes and toolchain digest verbatim from
`sources.lock.json`, requires every notice to match `licenses/manifest.json`
and the recipe's own copy, requires both packager allow-lists to cover the
runtime directory exactly, and then instantiates the committed module and makes
it encrypt a PDF, reject a wrong password without producing output, decrypt
with the correct password, and pass QPDF's own structural check.

That is what a hash contract is worth without the rebuild: it proves the
shipped bytes are the bytes that were once reproduced and reviewed, not that
they can be reproduced again today. Only the full gate proves the latter, which
is why it stays a release step rather than being weakened to fit into `npm
test`. It must never be added to `npm test`, `npm run test:all`, or any other
inner-loop aggregate; the fast gate asserts that it has not been.

## Reproduce and smoke-test

Docker is required. Run:

```bash
npm run qpdf-wasm:verify
```

The verifier fetches and hash-verifies the pinned source archives first. It
then gives every Docker build stage `--network=none`, so compilation cannot
reach the network. The verifier:

1. hash-verifies every source archive;
2. performs two independent `--no-cache --network=none` builds;
3. extracts every runtime, input, version, and notice file from both builds;
4. requires byte-for-byte identical inventories;
5. checks `qpdf.mjs` and `qpdf.wasm` against `expected-output.json`; and
6. runs the Node smoke against the repository's anonymized sample PDF.

The smoke covers version reporting, AES-256 encryption, rejection of a wrong
password without an output file, correct-password decryption, and QPDF's own
structural check of the decrypted result. It never signs a document.

On systems with Docker Buildx, the verifier builds and loads a pinned
`linux/amd64` image. The fallback uses the legacy Docker builder because some
maintainer VMs do not install the Buildx component. Both paths use the same
platform-specific Emscripten image digest and disable build-stage networking.
Docker may still need registry access to obtain the already-pinned base image;
`--network=none` governs the commands executed inside the build stages.

To smoke an already extracted artifact directory separately, run:

```bash
npm run qpdf-wasm:smoke -- /absolute/path/to/artifacts
```

## Artifact API

The research build exports an asynchronous ESM factory and a separate
WebAssembly file:

```js
import createQpdf from "./qpdf.mjs";

const qpdf = await createQpdf({ print, printErr });
qpdf.FS.writeFile("/input.pdf", inputBytes);
const status = qpdf.callMain(["/input.pdf", "--check"]);
const outputBytes = qpdf.FS.readFile("/output.pdf");
```

The reproduced raw module exposes `FS`, `_main`, and `callMain`. `FS` is the
broader Emscripten filesystem object, not a capability-limited facade. Treat
the raw module and its filesystem as internal implementation details. A later
production wrapper must expose only the narrow PDF operation API that the
application needs, rather than returning the module or `FS` to callers.
The runtime smoke guards this inventory and also verifies that `FS` exposes
broader methods including `mkdir`, `rename`, and `symlink`.

Create a fresh internal module for each application operation so filesystem
contents, password-bearing arguments, output handlers, and QPDF process state
do not cross request boundaries. This example demonstrates the research
artifact only; it is not the production application API.

## Distribution notices

`licenses/manifest.json` binds each tracked notice to its SHA-256 and pinned
source. The build copies the complete notice directory into its export image.
It includes notices for QPDF, zlib, libjpeg-turbo, Emscripten's generated
runtime, musl, compiler-rt, libc++, libc++abi, and libunwind. These notices
travel with the runtime: the promoted copy under `runtime/licenses/` is shipped
in full by both packagers, alongside `qpdf.mjs` and `qpdf.wasm`, and the fast
gate fails if any of them is missing, altered, or dropped from either packager
manifest.

The notice set is deliberately conservative. Build-time tools that contribute
no code to the output remain pinned by the Emscripten image digest, while all
known runtime and static-library license texts are retained.

## Production gates

Packaging the artifact is done. Integration is not, and packaging does not
authorize it. Before any PDF Tools tool loads this runtime:

- adversarially review the wrapper and password handling;
- enforce encrypted-document permissions explicitly;
- preserve source encryption on every successful mutation;
- set and test PDF size, memory, warning, and execution-time limits;
- test malformed and hostile PDFs, including recursion and page-tree cases;
- test correct, missing, wrong, user, and owner passwords;
- test backup, journal, concurrency, and atomic-output behavior;
- add qpdf, zlib and libjpeg-turbo to the share bundle's CycloneDX SBOM. The
  notice inventories are now verified automatically in the source tree, the
  MCPB and the share ZIP, and `SHARE-PROVENANCE.json` hashes every shipped
  file, but `SBOM.cdx.json` is generated from `package-lock.json` and therefore
  still describes npm packages only; and
- repeat the native Claude Desktop host smoke on supported platforms.

The protected `pdfjs-dist` dependency remains exactly 5.4.624. This recipe does
not change or replace it.
