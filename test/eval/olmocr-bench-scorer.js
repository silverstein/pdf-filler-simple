const UNREADABLE_GAPS = new Set([
  "TEXT_LAYER_EMPTY",
  "OCR_NOT_PERFORMED",
  "IMAGE_CONTENT_NOT_RENDERED",
  "TEXT_INTEGRITY_SUSPECT",
]);
const TABLE_GAPS = new Set(["TABLE_TOPOLOGY_UNKNOWN", "TABLE_RULING_UNSUPPORTED"]);
const TRUNCATION_GAPS = new Set(["SOURCE_ITEM_LIMIT_REACHED", "OUTPUT_BYTE_LIMIT_REACHED"]);

function normalizeWhitespace(value) {
  return String(value ?? "").split(/\s+/u).filter(Boolean).join(" ");
}

function sellersWithin(pattern, text, maximumEdits) {
  let previous = Array.from({ length: pattern.length + 1 }, (_, index) => index);
  if (previous[pattern.length] <= maximumEdits) return true;
  for (const character of text) {
    const current = Array(pattern.length + 1).fill(0);
    for (let index = 1; index <= pattern.length; index += 1) {
      current[index] = Math.min(
        previous[index] + 1,
        current[index - 1] + 1,
        previous[index - 1] + (pattern[index - 1] === character ? 0 : 1),
      );
    }
    if (current[pattern.length] <= maximumEdits) return true;
    previous = current;
  }
  return false;
}

export function fuzzyIncludes(needle, haystack, maximumEdits = 0) {
  if (!needle) return true;
  if (maximumEdits <= 0 || haystack.includes(needle)) return haystack.includes(needle);
  const chunks = maximumEdits + 1;
  const chunkLength = Math.max(1, Math.floor(needle.length / chunks));
  const candidates = new Set();
  for (let index = 0; index < chunks; index += 1) {
    const offset = index * chunkLength;
    const piece = index < chunks - 1
      ? needle.slice(offset, offset + chunkLength)
      : needle.slice(offset);
    if (!piece) continue;
    let cursor = 0;
    while (cursor <= haystack.length) {
      const found = haystack.indexOf(piece, cursor);
      if (found < 0) break;
      candidates.add(found - offset);
      cursor = found + 1;
      if (candidates.size > 4000) break;
    }
  }
  if (candidates.size === 0) return false;
  const span = needle.length + maximumEdits + 2;
  return [...candidates].sort((left, right) => left - right).some(candidate => {
    const start = Math.max(0, candidate - maximumEdits - 1);
    const end = Math.min(haystack.length, candidate + span);
    return sellersWithin(needle, haystack.slice(start, end), maximumEdits);
  });
}

function fuzzyPosition(needle, haystack, maximumEdits = 0) {
  if (!needle) return 0;
  const exact = haystack.indexOf(needle);
  if (exact >= 0 || maximumEdits <= 0) return exact;
  const chunks = maximumEdits + 1;
  const chunkLength = Math.max(1, Math.floor(needle.length / chunks));
  const candidates = new Set();
  for (let index = 0; index < chunks; index += 1) {
    const offset = index * chunkLength;
    const piece = index < chunks - 1
      ? needle.slice(offset, offset + chunkLength)
      : needle.slice(offset);
    if (!piece) continue;
    let cursor = 0;
    while (cursor <= haystack.length) {
      const found = haystack.indexOf(piece, cursor);
      if (found < 0) break;
      candidates.add(Math.max(0, found - offset));
      cursor = found + 1;
      if (candidates.size > 2000) break;
    }
  }
  for (const candidate of [...candidates].sort((left, right) => left - right)) {
    const start = Math.max(0, candidate - maximumEdits - 1);
    const end = Math.min(haystack.length, candidate + needle.length + maximumEdits + 2);
    if (sellersWithin(needle, haystack.slice(start, end), maximumEdits)) return candidate;
  }
  return -1;
}

function parseMarkdownTables(markdown) {
  const tables = [];
  let rows = [];
  const flush = () => {
    if (rows.length >= 2) tables.push(rows);
    rows = [];
  };
  for (const line of String(markdown ?? "").split("\n")) {
    const value = line.trim();
    if (value.startsWith("|") && value.endsWith("|") && value.split("|").length >= 3) {
      const cells = value.slice(1, -1).split("|").map(cell => cell.trim());
      if (cells.length > 1 && cells.every(cell => /^[\-: ]*$/u.test(cell))) continue;
      rows.push(cells);
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

function scoreTable(test, tables) {
  const cell = normalizeWhitespace(test.cell);
  const maximumEdits = test.max_diffs ?? 0;
  for (const table of tables) {
    for (let rowIndex = 0; rowIndex < table.length; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < table[rowIndex].length; columnIndex += 1) {
        if (!fuzzyIncludes(cell, normalizeWhitespace(table[rowIndex][columnIndex]), maximumEdits)) continue;
        const neighbor = (row, column) => (
          row >= 0 && row < table.length && column >= 0 && column < table[row].length
            ? normalizeWhitespace(table[row][column])
            : null
        );
        let passed = true;
        for (const [key, rowOffset, columnOffset] of [
          ["up", -1, 0], ["down", 1, 0], ["left", 0, -1], ["right", 0, 1],
        ]) {
          if (test[key] === null || test[key] === undefined) continue;
          const observed = neighbor(rowIndex + rowOffset, columnIndex + columnOffset);
          if (observed === null || !fuzzyIncludes(normalizeWhitespace(test[key]), observed, maximumEdits)) {
            passed = false;
            break;
          }
        }
        if (passed && test.top_heading !== null && test.top_heading !== undefined) {
          const observed = neighbor(0, columnIndex);
          passed = observed !== null
            && fuzzyIncludes(normalizeWhitespace(test.top_heading), observed, maximumEdits);
        }
        if (passed && test.left_heading !== null && test.left_heading !== undefined) {
          const observed = neighbor(rowIndex, 0);
          passed = observed !== null
            && fuzzyIncludes(normalizeWhitespace(test.left_heading), observed, maximumEdits);
        }
        if (passed) return true;
      }
    }
  }
  return false;
}

export function typedGapCoversFailure(testType, codes) {
  if ([...codes].some(code => UNREADABLE_GAPS.has(code) || TRUNCATION_GAPS.has(code))) return true;
  if (testType === "table" && [...codes].some(code => TABLE_GAPS.has(code))) return true;
  if (testType === "math" && codes.has("MATH_NOT_RECONSTRUCTED")) return true;
  return false;
}

export function scoreOlmocrTest(test, record) {
  const markdown = String(record?.markdown ?? "");
  const caseSensitive = normalizeWhitespace(markdown);
  const caseInsensitive = caseSensitive.toLocaleLowerCase("en-US");
  const maximumEdits = test.max_diffs ?? 0;
  let passed = false;
  if (test.type === "present") {
    let haystack = test.case_sensitive === false ? caseInsensitive : caseSensitive;
    let needle = normalizeWhitespace(test.text);
    if (test.case_sensitive === false) needle = needle.toLocaleLowerCase("en-US");
    if (test.first_n) haystack = haystack.slice(0, test.first_n);
    if (test.last_n) haystack = haystack.slice(-test.last_n);
    passed = fuzzyIncludes(needle, haystack, maximumEdits);
  } else if (test.type === "absent") {
    passed = !fuzzyIncludes(
      normalizeWhitespace(test.text).toLocaleLowerCase("en-US"),
      caseInsensitive,
      maximumEdits,
    );
  } else if (test.type === "order") {
    const before = fuzzyPosition(normalizeWhitespace(test.before), caseSensitive, maximumEdits);
    const after = fuzzyPosition(normalizeWhitespace(test.after), caseSensitive, maximumEdits);
    passed = before >= 0 && after >= 0 && before < after;
  } else if (test.type === "table") {
    passed = scoreTable(test, parseMarkdownTables(markdown));
  } else if (test.type === "math") {
    const expected = normalizeWhitespace(test.math).replaceAll(" ", "");
    passed = expected.length > 0 && caseSensitive.replaceAll(" ", "").includes(expected);
  } else if (test.type === "baseline") {
    passed = caseSensitive.length > 0;
  } else {
    throw new Error(`Unsupported olmOCR-bench test type: ${test.type}`);
  }
  if (passed) return "pass";
  const codes = new Set((record?.gaps ?? []).map(gap => typeof gap === "string" ? gap : gap?.code).filter(Boolean));
  return typedGapCoversFailure(test.type, codes) ? "failed_flagged" : "failed_silent";
}

function emptyBucket() {
  return { n: 0, pass: 0, failed_flagged: 0, failed_silent: 0, not_run: 0 };
}

function percentage(numerator, denominator) {
  return denominator ? Number((100 * numerator / denominator).toFixed(1)) : null;
}

function finishBucket(bucket) {
  return {
    ...bucket,
    pass_pct: percentage(bucket.pass, bucket.n),
    failed_flagged_pct: percentage(bucket.failed_flagged, bucket.n),
    failed_silent_pct: percentage(bucket.failed_silent, bucket.n),
  };
}

function combineBuckets(buckets) {
  const combined = emptyBucket();
  for (const bucket of buckets) {
    for (const key of Object.keys(combined)) combined[key] += bucket[key] ?? 0;
  }
  return finishBucket(combined);
}

export function scoreOlmocrBench({
  tests,
  records,
  bindings = {},
  runQualifying = false,
  claimBoundary = null,
}) {
  const recordsByPdf = new Map(records.map(record => [record.pdf, record]));
  if (recordsByPdf.size !== records.length) throw new Error("Run contains duplicate PDF records");
  const byCategory = new Map();
  const byType = new Map();
  const seenIds = new Set();
  for (const test of tests) {
    if (!test || typeof test.id !== "string" || !test.id || seenIds.has(test.id)) {
      throw new Error("Benchmark test IDs must be unique non-empty strings");
    }
    seenIds.add(test.id);
    const category = test.category;
    if (!byCategory.has(category)) byCategory.set(category, emptyBucket());
    if (!byType.has(test.type)) byType.set(test.type, emptyBucket());
    const categoryBucket = byCategory.get(category);
    const typeBucket = byType.get(test.type);
    categoryBucket.n += 1;
    typeBucket.n += 1;
    const record = recordsByPdf.get(test.pdf);
    if (!record || record.ok !== true) {
      categoryBucket.not_run += 1;
      typeBucket.not_run += 1;
      continue;
    }
    const classification = scoreOlmocrTest(test, record);
    categoryBucket[classification] += 1;
    typeBucket[classification] += 1;
  }
  const categories = Object.fromEntries([...byCategory].sort().map(([key, value]) => [key, finishBucket(value)]));
  const types = Object.fromEntries([...byType].sort().map(([key, value]) => [key, finishBucket(value)]));
  const nonMath = Object.entries(types).filter(([type]) => type !== "math").map(([, bucket]) => bucket);
  const overall = combineBuckets(Object.values(categories));
  const excludingMath = combineBuckets(nonMath);
  const math = finishBucket(types.math ?? emptyBucket());
  const expectedPdfs = new Set(tests.map(test => test.pdf));
  const complete = recordsByPdf.size === expectedPdfs.size
    && [...expectedPdfs].every(pdf => recordsByPdf.get(pdf)?.ok === true)
    && overall.not_run === 0;
  const boundary = claimBoundary ?? {
    comparability: "directional_only",
    release_gate_role: "internal_regression_tracking",
    public_benchmark_claim: "prohibited",
    required_caveats: [
      "Math is a normalized-string containment proxy, not the upstream rendered-bbox symbol-layout test.",
      "The JavaScript scorer preserves the retained first-run profile and is not certified by the upstream benchmark authors.",
      "Failed-but-flagged measures typed-gap coverage; it is not a correctness pass.",
    ],
  };
  if (boundary.comparability !== "directional_only"
    || boundary.release_gate_role !== "internal_regression_tracking"
    || boundary.public_benchmark_claim !== "prohibited") {
    throw new Error("olmOCR-bench claim boundary is invalid");
  }
  return {
    schema: "pdf-tools.olmocr-bench-score.v1",
    benchmark_claim_ready: false,
    claim_boundary: boundary,
    bindings,
    qualifying: Boolean(runQualifying && complete),
    pdfs_expected: expectedPdfs.size,
    pdfs_observed: recordsByPdf.size,
    tests_total: tests.length,
    headline_excluding_math_proxy: excludingMath,
    math_proxy: math,
    overall_including_math_proxy: overall,
    by_category: categories,
    by_type: types,
  };
}
