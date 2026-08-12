# ODA QPDF WebAssembly build recipe

This directory contains a reproducible, ODA-controlled build of the QPDF
command-line interface for Node.js WebAssembly. The generated JavaScript and
WebAssembly are shipped in both the MCPB and the share ZIP, from
`vendor/qpdf-wasm/runtime/`. Packaging was deliberately a separate step from
integration: the artifact was proven to arrive intact and loadable in a
packaged tree before any tool was allowed to rely on it.

## Who loads it

Exactly one module: `server/qpdf-decrypt.js`. It decrypts encrypted PDFs in
memory for the three read-only tools — `read_pdf_fields`, `validate_pdf` and
`extract_to_csv` — and for the mutation tools, which additionally use it to
restore a source's own encryption onto the changed document before it is
written. Re-protection uses `--copy-encryption`, so the only protection it can
write is the one the document already had: nothing here mints, removes or
weakens protection, and a document that cannot be faithfully re-protected fails
the operation rather than being written out decrypted. It implements the production wrapper this
README asks for below: callers receive plaintext bytes and a permission
decision, never the module or its `FS`. Passwords reach QPDF through
`--password-file=` in the module's private MEMFS, never through argv, and QPDF
diagnostics are never passed through to a caller.

The single-importer property is asserted by
`test/qpdf-wasm-runtime-artifact.test.js`. A second `server/` module reaching
for the runtime directly would bypass the password rules, the `/P` permission
enforcement and the encrypted-input size cap, so it fails there rather than in
review. See the `## Password Support` section of `CLAUDE.md` for the scope
rule those checks implement.

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

`scripts/qpdf-wasm-sbom.mjs` reads that same provenance record and derives the
CycloneDX components both packagers put in `SBOM.cdx.json`: one component per
pinned source, one per Emscripten-supplied library that is statically linked
into `qpdf.wasm`, and one for the runtime artifact they all hang off. The
Emscripten image itself is recorded as `metadata.tools`, not as a component —
it built the artifact, it is not inside it. Nothing in that list is written by
hand, so bumping a source in `sources.lock.json` and promoting the build is
enough to move the bill of materials with it;
`test/sbom-native-components.test.js` fails if it ever does not.

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

The gate list below was written before any integration. Read-only decryption
satisfies part of it; the rest still stands, and several items gate the *write*
path specifically, which has not been attempted.

Met by the read-only integration:

- **enforce encrypted-document permissions explicitly** — `/P` `extract` is
  required whenever the caller supplied no accepted password, and the refusal
  names the denied permission;
- **PDF size and memory limits** — encrypted inputs are capped at 16 MiB,
  separate from the 250 MiB mutation cap, derived from a measured
  `16 x input + 45 MB` peak RSS;
- **correct, missing, wrong, user, and owner passwords** — all five are tested,
  including the case that matters most: a wrong password against a document
  whose user password is empty must fail rather than open;
- **malformed and hostile PDFs** — truncated, headerless, empty, non-PDF, and
  body-shredded encrypted inputs are tested to produce a fixed message and
  never echo QPDF output;
- **backup, journal, concurrency, and atomic-output behavior** — not
  applicable: these tools write no PDF. Plaintext never reaches the disk.

Still open:

- **adversarially review the wrapper and password handling.** The wrapper is
  written to be reviewable and is covered by tests, but no adversarial review
  by a second person has happened.
- **warning and execution-time limits.** Neither exists. `callMain` is a
  synchronous WebAssembly call and cannot be interrupted from the calling
  thread, so a real timeout needs the operation moved to a worker. Today the
  only bound on the work is the 16 MiB input cap. This is a smaller change in
  posture than it sounds — pdf-lib parsing on the same path is also
  synchronous and unbounded — but qpdf is a much larger parser, and the gate is
  not met.
- **recursion and page-tree hostile cases.** Covered downstream of decryption
  by the existing page-tree validation, which runs on the plaintext, but not
  yet driven adversarially through the decrypting path itself.
- **preserve source encryption on every successful mutation.** Untouched, and
  deliberately so. No write path loads this runtime. Re-encryption is the
  capability the scope rule withholds, because it is what would turn the
  owner-locked shape into a permissions-circumvention tool.
- **add qpdf, zlib and libjpeg-turbo to the share bundle's CycloneDX SBOM.**
  The notice inventories are verified automatically in the source tree, the
  MCPB and the share ZIP, and `SHARE-PROVENANCE.json` hashes every shipped
  file, but `SBOM.cdx.json` is generated from `package-lock.json` and therefore
  still describes npm packages only.
- **repeat the native Claude Desktop host smoke on supported platforms.**

The protected `pdfjs-dist` dependency remains exactly 5.4.624. This recipe does
not change or replace it.
