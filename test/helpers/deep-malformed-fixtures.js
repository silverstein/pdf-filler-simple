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
  const offsets = [0];
  const byNumber = new Map(objects);
  const maxNumber = Math.max(...byNumber.keys());
  for (let n = 1; n <= maxNumber; n += 1) {
    const body = byNumber.get(n);
    if (body === undefined) continue;
    offsets[n] = Buffer.byteLength(chunks.join(""), "latin1");
    chunks.push(`${n} 0 obj\n${body}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "latin1");
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

/** A deterministic FlateDecode stream object that inflates to `expandedBytes`. */
function flateStreamObject(expandedBytes, fillByte = 0x41) {
  const raw = Buffer.alloc(expandedBytes, fillByte);
  const deflated = zlib.deflateSync(raw, { level: 9 });
  return {
    body: `<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated.toString("latin1")}\nendstream`,
    compressedLength: deflated.length,
    expandedLength: expandedBytes,
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
export function makeDeepMalformedFixtures({ scale = "full" } = {}) {
  const deepDepth = scale === "quick" ? 2_000 : 50_000;
  const pageTreeDepth = scale === "quick" ? 500 : 5_000;
  const inflateBytes = scale === "quick" ? 4 << 20 : 512 << 20;
  const nestedDepth = scale === "quick" ? 4 : 12;

  const fixtures = [];

  // --- deep -----------------------------------------------------------------
  fixtures.push({
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

  fixtures.push({
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

  {
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
  fixtures.push({
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

  fixtures.push({
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

  fixtures.push({
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
  {
    const stream = flateStreamObject(inflateBytes);
    fixtures.push({
      name: "compressed-inflate-bomb",
      klass: "compressed",
      note: `${stream.compressedLength} compressed bytes inflate to ${stream.expandedLength}.`,
      expansionRatio: stream.expandedLength / stream.compressedLength,
      bytes: buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>"],
        [4, stream.body],
      ], 1),
    });
  }

  {
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

  fixtures.push({
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
  fixtures.push({
    name: "extreme-declared-page-count",
    klass: "extreme",
    note: "Page tree declares 100,000,000 pages while holding one.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 100000000 >>"],
      [3, PAGE_LEAF],
    ], 1),
  });

  fixtures.push({
    name: "extreme-media-box-dimensions",
    klass: "extreme",
    note: "MediaBox spans 1e9 x 1e9 points; naive rasterization would allocate absurdly.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000000 1000000000] /Resources <<>> >>"],
    ], 1),
  });

  fixtures.push({
    name: "extreme-long-name-token",
    klass: "extreme",
    note: "A single name token of 1,000,000 characters.",
    bytes: buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /${"A".repeat(1_000_000)} 0 >> >>`],
    ], 1),
  });

  fixtures.push({
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
