# ODA QPDF WebAssembly build recipe

This directory contains a reproducible, ODA-controlled research build of the
QPDF command-line interface for Node.js WebAssembly. It is a supply-chain and
runtime feasibility milestone. The generated JavaScript and WebAssembly are
not yet used by PDF Tools, included in the MCPB, or included in the share ZIP.

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

## Reproduce and smoke-test

Docker is required. Run:

```bash
npm run qpdf-wasm:verify
```

The verifier:

1. hash-verifies every source archive;
2. performs two independent `--no-cache` builds;
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
platform-specific Emscripten image digest.

To smoke an already extracted artifact directory separately, run:

```bash
npm run qpdf-wasm:smoke -- /absolute/path/to/artifacts
```

## Artifact API

The build exports an asynchronous ESM factory and a separate WebAssembly file:

```js
import createQpdf from "./qpdf.mjs";

const qpdf = await createQpdf({ print, printErr });
qpdf.FS.writeFile("/input.pdf", inputBytes);
const status = qpdf.callMain(["/input.pdf", "--check"]);
const outputBytes = qpdf.FS.readFile("/output.pdf");
```

Only `callMain`, `FS.writeFile`, `FS.readFile`, and `FS.unlink` are exported.
Create a fresh module for each application operation so filesystem contents,
password-bearing arguments, output handlers, and QPDF process state do not
cross request boundaries.

## Distribution notices

`licenses/manifest.json` binds each tracked notice to its SHA-256 and pinned
source. The build copies the complete notice directory into its export image.
It includes notices for QPDF, zlib, libjpeg-turbo, Emscripten's generated
runtime, musl, compiler-rt, libc++, libc++abi, and libunwind. These notices must
travel with any later MCPB or share artifact that contains the generated
runtime.

The notice set is deliberately conservative. Build-time tools that contribute
no code to the output remain pinned by the Emscripten image digest, while all
known runtime and static-library license texts are retained.

## Production gates

This recipe proves build and basic runtime feasibility. It does not authorize a
runtime integration. Before adding the generated files to PDF Tools:

- adversarially review the wrapper and password handling;
- enforce encrypted-document permissions explicitly;
- preserve source encryption on every successful mutation;
- set and test PDF size, memory, warning, and execution-time limits;
- test malformed and hostile PDFs, including recursion and page-tree cases;
- test correct, missing, wrong, user, and owner passwords;
- test backup, journal, concurrency, and atomic-output behavior;
- verify source, share ZIP, and MCPB notice and SBOM inventories; and
- repeat the native Claude Desktop host smoke on supported platforms.

The protected `pdfjs-dist` dependency remains exactly 5.4.624. This recipe does
not change or replace it.
