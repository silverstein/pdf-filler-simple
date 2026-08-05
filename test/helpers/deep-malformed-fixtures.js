/**
 * Deep malformed PDF corpus (bead pdf-toolkit-mcp-33l).
 *
 * The fast 20-fixture matrix in fuzz-malformed-pdfs.test.js covers structural
 * corruption and transactional containment with cheap inputs. It deliberately
 * omits the adversary classes whose whole point is that a small file provokes
 * disproportionate work:
 *
 *   deep     nesting that drives recursive descent toward stack exhaustion
 *   sparse   tiny files declaring enormous object-number or xref ranges
 *   compressed  streams that expand by orders of magnitude when decoded
 *   extreme  declared geometry or page counts far beyond anything real
 *
 * These matter because the input-size limits (250 MiB per file, 500 MiB
 * aggregate merge) bound *input* bytes, not the work those bytes request. A
 * 12 KiB file that asks for a 512 MiB inflate, or a 2 KiB file that declares
 * 100,000,000 objects, passes every size check before the expensive part
 * starts. That is exactly the gap this corpus exercises.
 *
 * Every fixture is generated deterministically so digests are stable across
 * runs and machines. Nothing here is fetched, and nothing depends on wall
 * clock or randomness.
 */

import zlib from "node:zlib";

/** Serialize numbered objects into a minimal, correctly cross-referenced PDF. */
export function buildPdf(objects, rootObjectNumber, trailerExtra = "") {
  const chunks = ["%PDF-1.7\n"];
  let serializedBytes = Buffer.byteLength(chunks[0], "latin1");
  const offsets = [0];
  const byNumber = new Map(objects);
  const maxNumber = Math.max(...byNumber.keys());
  for (let n = 1; n <= maxNumber; n += 1) {
    const body = byNumber.get(n);
    if (body === undefined) continue;
    const serialized = `${n} 0 obj\n${body}\nendobj\n`;
    offsets[n] = serializedBytes;
    chunks.push(serialized);
    serializedBytes += Buffer.byteLength(serialized, "latin1");
  }
  const xrefOffset = serializedBytes;
  const entries = ["0000000000 65535 f "];
  for (let n = 1; n <= maxNumber; n += 1) {
    entries.push(offsets[n] === undefined
      ? "0000000000 00000 f "
      : `${String(offsets[n]).padStart(10, "0")} 00000 n `);
  }
  chunks.push(
    `xref\n0 ${maxNumber + 1}\n${entries.join("\n")}\n` +
      `trailer\n<< /Size ${maxNumber + 1} /Root ${rootObjectNumber} 0 R${trailerExtra} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return Buffer.from(chunks.join(""), "latin1");
}

/** A deterministic FlateDecode stream object that inflates to a repeated pattern. */
function flatePatternStreamObject(expandedBytes, pattern) {
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes < 1) {
    throw new Error("expandedBytes must be a positive safe integer");
  }
  const patternBytes = Buffer.isBuffer(pattern) ? pattern : Buffer.from(pattern, "latin1");
  if (patternBytes.length < 1 || expandedBytes % patternBytes.length !== 0) {
    throw new Error("expandedBytes must be an exact multiple of the non-empty pattern");
  }
  const raw = Buffer.allocUnsafe(expandedBytes);
  for (let offset = 0; offset < raw.length; offset += patternBytes.length) {
    patternBytes.copy(raw, offset);
  }
  const deflated = zlib.deflateSync(raw, { level: 9 });
  return {
    body: `<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated.toString("latin1")}\nendstream`,
    compressedLength: deflated.length,
    expandedLength: expandedBytes,
  };
}

/** A deterministic FlateDecode stream object that inflates to `expandedBytes`. */
function flateStreamObject(expandedBytes, fillByte = 0x41) {
  return flatePatternStreamObject(expandedBytes, Buffer.from([fillByte]));
}

/**
 * Build one targeted compressed content-stream fixture without materializing
 * the rest of the campaign corpus. The hard ceiling protects the measuring
 * process itself; product behavior beyond this range belongs behind an
 * external supervisor, not in an ordinary test generator.
 */
export function makeCompressedContentFixture({
  name,
  expandedBytes,
  pattern,
  filterForm = "name",
  note,
} = {}) {
  if (typeof name !== "string" || !/^[a-z0-9-]{1,80}$/.test(name)) {
    throw new Error("Compressed fixture name must be a short kebab-case identifier");
  }
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes < 1 || expandedBytes > 16 << 20) {
    throw new Error("Targeted compressed fixtures are limited to 16 MiB expanded");
  }
  if (!["name", "array"].includes(filterForm)) {
    throw new Error("filterForm must be name or array");
  }
  const patternBytes = Buffer.isBuffer(pattern) ? pattern : Buffer.from(pattern ?? "", "latin1");
  if (patternBytes.length < 1 || patternBytes.length > 32) {
    throw new Error("Compressed fixture pattern must contain 1 to 32 bytes");
  }
  const stream = flatePatternStreamObject(expandedBytes, patternBytes);
  const filterDeclaration = filterForm === "name" ? "/FlateDecode" : "[/FlateDecode]";
  const body = stream.body.replace("/Filter /FlateDecode", `/Filter ${filterDeclaration}`);
  return {
    name,
    klass: "compressed",
    note: typeof note === "string" && note ? note : "Targeted compressed content-stream fixture.",
    filterForm,
    pattern: patternBytes.toString("latin1"),
    expansionRatio: stream.expandedLength / stream.compressedLength,
    compressedLength: stream.compressedLength,
    expandedLength: stream.expandedLength,
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
      [4, body],
    ], 1),
  };
}

/** Nested filter chain: the same payload deflated `depth` times. */
function nestedFlateStreamObject(expandedBytes, depth) {
  let payload = Buffer.alloc(expandedBytes, 0x42);
  for (let i = 0; i < depth; i += 1) {
    payload = zlib.deflateSync(payload, { level: 9 });
  }
  const filters = Array.from({ length: depth }, () => "/FlateDecode").join(" ");
  return {
    body: `<< /Length ${payload.length} /Filter [${filters}] >>\nstream\n${payload.toString("latin1")}\nendstream`,
    compressedLength: payload.length,
  };
}

const PAGE_LEAF = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>";

/**
 * Build the deep corpus.
 *
 * `scale` trades depth for runtime so the same generator serves both the
 * cheap default gate and the full campaign. Keep every fixture small on disk;
 * the danger is what it asks the parser to do, not what it costs to store.
 */
export const DEEP_FIXTURE_CATALOG = Object.freeze([
  Object.freeze({ name: "deep-nested-arrays", klass: "deep" }),
  Object.freeze({ name: "deep-nested-dictionaries", klass: "deep" }),
  Object.freeze({ name: "deep-linear-page-tree", klass: "deep" }),
  Object.freeze({ name: "sparse-enormous-declared-size", klass: "sparse" }),
  Object.freeze({ name: "sparse-high-object-numbers", klass: "sparse" }),
  Object.freeze({ name: "sparse-xref-range-overflow", klass: "sparse" }),
  Object.freeze({ name: "compressed-single-filter-name", klass: "compressed" }),
  Object.freeze({ name: "compressed-single-filter-array", klass: "compressed" }),
  Object.freeze({ name: "compressed-inflate-bomb", klass: "compressed" }),
  Object.freeze({ name: "compressed-valid-operator-bomb", klass: "compressed" }),
  Object.freeze({ name: "compressed-delimited-paint-operators", klass: "compressed" }),
  Object.freeze({
    name: "compressed-discarded-compatibility-operators",
    klass: "compressed",
  }),
  Object.freeze({ name: "compressed-nested-filter-chain", klass: "compressed" }),
  Object.freeze({ name: "compressed-length-understates-stream", klass: "compressed" }),
  Object.freeze({ name: "extreme-declared-page-count", klass: "extreme" }),
  Object.freeze({ name: "extreme-media-box-dimensions", klass: "extreme" }),
  Object.freeze({ name: "extreme-long-name-token", klass: "extreme" }),
  Object.freeze({ name: "extreme-wide-page-tree", klass: "extreme" }),
]);

export const DEEP_FIXTURE_NAMES = Object.freeze(
  DEEP_FIXTURE_CATALOG.map(entry => entry.name),
);

// Frozen expensive campaign base conceived before the later causal-attribution
// and operator-semantics controls were added. The native v2 qualification runs
// this exact 13-fixture set; widening it requires a new protocol version.
export const DEEP_FULL_SCALE_BASE_FIXTURE_NAMES = Object.freeze([
  "deep-nested-arrays",
  "deep-nested-dictionaries",
  "deep-linear-page-tree",
  "sparse-enormous-declared-size",
  "sparse-high-object-numbers",
  "sparse-xref-range-overflow",
  "compressed-inflate-bomb",
  "compressed-nested-filter-chain",
  "compressed-length-understates-stream",
  "extreme-declared-page-count",
  "extreme-media-box-dimensions",
  "extreme-long-name-token",
  "extreme-wide-page-tree",
]);

export function makeDeepMalformedFixtures({ scale = "full", only = null } = {}) {
  if (!["quick", "full"].includes(scale)) {
    throw new Error("Deep malformed fixture scale must be quick or full");
  }
  if (only !== null && !DEEP_FIXTURE_NAMES.includes(only)) {
    throw new Error("Unknown deep malformed fixture name");
  }
  const wanted = name => only === null || only === name;
  // Keep the quick arm above the product's 256-level limit but below the
  // dependency parser's opaque-object fallback, so it exercises our guard
  // instead of being discarded as an unreachable invalid object.
  const deepDepth = scale === "quick" ? 1_000 : 50_000;
  const pageTreeDepth = scale === "quick" ? 500 : 5_000;
  const inflateBytes = scale === "quick" ? 4 << 20 : 512 << 20;
  const nestedDepth = scale === "quick" ? 4 : 12;

  const fixtures = [];

  // --- deep -----------------------------------------------------------------
  if (wanted("deep-nested-arrays")) fixtures.push({
    name: "deep-nested-arrays",
    klass: "deep",
    note: "Recursive descent over a single deeply nested array must not exhaust the stack.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, PAGE_LEAF],
      [4, `${"[".repeat(deepDepth)}0${"]".repeat(deepDepth)}`],
    ], 1),
  });

  if (wanted("deep-nested-dictionaries")) fixtures.push({
    name: "deep-nested-dictionaries",
    klass: "deep",
    note: "Same as above through dictionary nesting, which uses a different parse path.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, PAGE_LEAF],
      [4, `${"<< /A ".repeat(deepDepth)}0${" >>".repeat(deepDepth)}`],
    ], 1),
  });

  if (wanted("deep-linear-page-tree")) {
    // A page tree that is a linear chain rather than a broad tree. Walking it
    // recursively is the natural implementation and the one that breaks.
    const objects = [[1, "<< /Type /Catalog /Pages 2 0 R >>"]];
    for (let level = 0; level < pageTreeDepth; level += 1) {
      const self = 2 + level;
      const child = self + 1;
      objects.push([self, `<< /Type /Pages /Kids [${child} 0 R] /Count 1 >>`]);
    }
    const leaf = 2 + pageTreeDepth;
    objects.push([leaf, `<< /Type /Page /Parent ${leaf - 1} 0 R /MediaBox [0 0 100 100] /Resources <<>> >>`]);
    fixtures.push({
      name: "deep-linear-page-tree",
      klass: "deep",
      note: `Page tree ${pageTreeDepth} levels deep with a single real leaf.`,
      bytes: buildPdf(objects, 1),
    });
  }

  // --- sparse ---------------------------------------------------------------
  if (wanted("sparse-enormous-declared-size")) fixtures.push({
    name: "sparse-enormous-declared-size",
    klass: "sparse",
    note: "Trailer declares 100,000,000 objects; allocating an xref table for that is the trap.",
    bytes: Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
        `3 0 obj\n${PAGE_LEAF}\nendobj\n` +
        "trailer\n<< /Size 100000000 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n",
      "latin1",
    ),
  });

  if (wanted("sparse-high-object-numbers")) fixtures.push({
    name: "sparse-high-object-numbers",
    klass: "sparse",
    note: "Three real objects at very high numbers; a dense index would be enormous.",
    bytes: Buffer.from(
      "%PDF-1.7\n999999997 0 obj\n<< /Type /Catalog /Pages 999999998 0 R >>\nendobj\n" +
        "999999998 0 obj\n<< /Type /Pages /Kids [999999999 0 R] /Count 1 >>\nendobj\n" +
        "999999999 0 obj\n<< /Type /Page /Parent 999999998 0 R /MediaBox [0 0 100 100] /Resources <<>> >>\nendobj\n" +
        "trailer\n<< /Size 1000000000 /Root 999999997 0 R >>\nstartxref\n0\n%%EOF\n",
      "latin1",
    ),
  });

  if (wanted("sparse-xref-range-overflow")) fixtures.push({
    name: "sparse-xref-range-overflow",
    klass: "sparse",
    note: "xref subsection header claims a range far larger than the entries that follow.",
    bytes: Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n" +
        "xref\n0 4294967295\n0000000000 65535 f \n0000000009 00000 n \n" +
        "trailer\n<< /Size 4294967295 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n",
      "latin1",
    ),
  });

  // --- compressed -----------------------------------------------------------
  if (wanted("compressed-single-filter-name")
    || wanted("compressed-single-filter-array")) {
    // Causal attribution pair. The compressed payload, page graph, object
    // numbers, and every other byte are identical after normalizing this one
    // dictionary token. The prior campaign compared a name-form filter against
    // a multi-filter array with different expanded sizes, so it could not
    // identify whether declaration form itself caused the resource outlier.
    const stream = flateStreamObject(1 << 20, 0x44);
    const objects = filterDeclaration => [
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
      [4, stream.body.replace("/Filter /FlateDecode", `/Filter ${filterDeclaration}`)],
    ];
    if (wanted("compressed-single-filter-name")) fixtures.push({
      name: "compressed-single-filter-name",
      klass: "compressed",
      note: "Attribution control: one FlateDecode declared as a name.",
      attributionPair: "single-filter-declaration-form",
      filterForm: "name",
      compressedLength: stream.compressedLength,
      expandedLength: stream.expandedLength,
      bytes: buildPdf(objects("/FlateDecode"), 1),
    });
    if (wanted("compressed-single-filter-array")) fixtures.push({
      name: "compressed-single-filter-array",
      klass: "compressed",
      note: "Attribution treatment: the identical FlateDecode payload declared as a one-element array.",
      attributionPair: "single-filter-declaration-form",
      filterForm: "array",
      compressedLength: stream.compressedLength,
      expandedLength: stream.expandedLength,
      bytes: buildPdf(objects("[/FlateDecode]"), 1),
    });
  }

  if (wanted("compressed-inflate-bomb")) {
    const stream = flateStreamObject(inflateBytes);
    fixtures.push({
      name: "compressed-inflate-bomb",
      klass: "compressed",
      note: `${stream.compressedLength} compressed bytes inflate to ${stream.expandedLength} invalid operator bytes.`,
      expansionRatio: stream.expandedLength / stream.compressedLength,
      compressedLength: stream.compressedLength,
      expandedLength: stream.expandedLength,
      expandedFillByte: 0x41,
      bytes: buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
        [4, stream.body],
      ], 1),
    });
  }

  if (wanted("compressed-valid-operator-bomb")) {
    // PDF.js recovers each contiguous "B" byte as the valid zero-argument
    // fill-and-stroke operator while it rejects a contiguous "A" token after
    // 128 bytes. Contiguous B bytes are not claimed to be a strictly
    // conforming token sequence; the delimited arm below tests that separately.
    // This arm uses one ordinary name-form FlateDecode, just like
    // compressed-inflate-bomb above.
    const stream = flateStreamObject(inflateBytes, 0x42);
    fixtures.push({
      name: "compressed-valid-operator-bomb",
      klass: "compressed",
      note: `${stream.compressedLength} compressed bytes inflate to ${stream.expandedLength} contiguous B bytes recovered by PDF.js as paint operators.`,
      expansionRatio: stream.expandedLength / stream.compressedLength,
      compressedLength: stream.compressedLength,
      expandedLength: stream.expandedLength,
      expandedFillByte: 0x42,
      operatorPattern: "B",
      operatorCount: stream.expandedLength,
      bytes: buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
        [4, stream.body],
      ], 1),
    });
  }

  if (wanted("compressed-delimited-paint-operators")) {
    const pattern = Buffer.from("B\n", "latin1");
    const expandedLength = Math.floor(inflateBytes / pattern.length) * pattern.length;
    const stream = flatePatternStreamObject(expandedLength, pattern);
    fixtures.push({
      name: "compressed-delimited-paint-operators",
      klass: "compressed",
      note: `${stream.compressedLength} compressed bytes inflate to ${stream.expandedLength} bytes containing ${stream.expandedLength / pattern.length} whitespace-delimited B operators.`,
      expansionRatio: stream.expandedLength / stream.compressedLength,
      compressedLength: stream.compressedLength,
      expandedLength: stream.expandedLength,
      operatorPattern: "B\\n",
      operatorCount: stream.expandedLength / pattern.length,
      bytes: buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
        [4, stream.body],
      ], 1),
    });
  }

  if (wanted("compressed-discarded-compatibility-operators")) {
    const pattern = Buffer.from("BX\n", "latin1");
    const expandedLength = Math.floor(inflateBytes / pattern.length) * pattern.length;
    const stream = flatePatternStreamObject(expandedLength, pattern);
    fixtures.push({
      name: "compressed-discarded-compatibility-operators",
      klass: "compressed",
      note: `${stream.compressedLength} compressed bytes inflate to ${stream.expandedLength} bytes containing ${stream.expandedLength / pattern.length} recognized compatibility operators that PDF.js does not retain in the operator list.`,
      expansionRatio: stream.expandedLength / stream.compressedLength,
      compressedLength: stream.compressedLength,
      expandedLength: stream.expandedLength,
      operatorPattern: "BX\\n",
      operatorCount: stream.expandedLength / pattern.length,
      bytes: buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
        [4, stream.body],
      ], 1),
    });
  }

  if (wanted("compressed-nested-filter-chain")) {
    const stream = nestedFlateStreamObject(inflateBytes, nestedDepth);
    fixtures.push({
      name: "compressed-nested-filter-chain",
      klass: "compressed",
      note: `Payload deflated ${nestedDepth} times; each decode stage re-expands.`,
      bytes: buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
        [4, stream.body],
      ], 1),
    });
  }

  if (wanted("compressed-length-understates-stream")) fixtures.push({
    name: "compressed-length-understates-stream",
    klass: "compressed",
    note: "Declared /Length is far shorter than the actual deflate payload.",
    bytes: (() => {
      const stream = flateStreamObject(1 << 20, 0x43);
      return buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
        [4, stream.body.replace(/\/Length \d+/, "/Length 12")],
      ], 1);
    })(),
  });

  // --- extreme --------------------------------------------------------------
  if (wanted("extreme-declared-page-count")) fixtures.push({
    name: "extreme-declared-page-count",
    klass: "extreme",
    note: "Page tree declares 100,000,000 pages while holding one.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 100000000 >>"],
      [3, PAGE_LEAF],
    ], 1),
  });

  if (wanted("extreme-media-box-dimensions")) fixtures.push({
    name: "extreme-media-box-dimensions",
    klass: "extreme",
    note: "MediaBox spans 1e9 x 1e9 points; naive rasterization would allocate absurdly.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000000 1000000000] /Resources <<>> >>"],
    ], 1),
  });

  if (wanted("extreme-long-name-token")) fixtures.push({
    name: "extreme-long-name-token",
    klass: "extreme",
    note: "A single name token of 1,000,000 characters.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /${"A".repeat(1_000_000)} 0 >> >>`],
    ], 1),
  });

  if (wanted("extreme-wide-page-tree")) fixtures.push({
    name: "extreme-wide-page-tree",
    klass: "extreme",
    note: "One /Pages node referencing 100,000 dangling children.",
    bytes: (() => {
      const kids = Array.from({ length: 100_000 }, (_, i) => `${i + 10} 0 R`).join(" ");
      return buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, `<< /Type /Pages /Kids [${kids}] /Count 100000 >>`],
      ], 1);
    })(),
  });

  return fixtures;
}

export const DEEP_FIXTURE_CLASSES = Object.freeze(["deep", "sparse", "compressed", "extreme"]);

export function makeDeepMalformedFixture({ scale = "full", name } = {}) {
  const fixtures = makeDeepMalformedFixtures({ scale, only: name });
  if (fixtures.length !== 1) throw new Error("Deep malformed fixture selection was not unique");
  return fixtures[0];
}
