const WHOLE_TEXT_FAILURE_GAPS = new Set([
  "PAGE_RANGE_INCOMPLETE",
  "SOURCE_CHARACTER_LIMIT_REACHED",
  "SOURCE_ITEM_LIMIT_REACHED",
  "TEXT_INTEGRITY_SUSPECT",
  "TEXT_LAYER_EMPTY",
  "TEXT_LAYER_FAILED",
]);
const TABLE_GAPS = new Set(["TABLE_TOPOLOGY_UNKNOWN", "TABLE_RULING_UNSUPPORTED"]);
const HISTORICAL_UNREADABLE_GAPS = new Set([
  "TEXT_LAYER_EMPTY",
  "OCR_NOT_PERFORMED",
  "IMAGE_CONTENT_NOT_RENDERED",
  "TEXT_INTEGRITY_SUSPECT",
]);
const HISTORICAL_TRUNCATION_GAPS = new Set([
  "SOURCE_ITEM_LIMIT_REACHED",
  "OUTPUT_BYTE_LIMIT_REACHED",
]);

function normalizeWhitespace(value) {
  return String(value ?? "").split(/\s+/u).filter(Boolean).join(" ");
}

export function normalizeBenchmarkText(value) {
  return normalizeWhitespace(String(value ?? "")
    .replace(/<br\s*\/?\s*>/giu, " ")
    .replace(/<\/?(?:b|i)>/giu, "")
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(\*|_)(.*?)\1/gu, "$2"))
    .normalize("NFC")
    .replace(/[‘’‚]/gu, "'")
    .replace(/[“”„]/gu, '"')
    .replace(/[＿]/gu, "_")
    .replace(/[–—‑‒−]/gu, "-")
    .replace(/µ/gu, "μ");
}

export function benchmarkMarkdownBody(markdown) {
  let body = String(markdown ?? "")
    .replace(/^<!--\s*PDF page 1\s*-->\s*/u, "");
  const markers = ["\n\n## Conversion gaps\n", "\n\n## Conversion limitations\n"];
  let end = body.length;
  for (const marker of markers) {
    const found = body.lastIndexOf(marker);
    if (found >= 0) end = Math.min(end, found);
  }
  body = body.slice(0, end).trim();
  if (body === "[No source-backed text was available on this page.]") return "";
  return body;
}

function editDistanceWithin(pattern, text, maximumEdits) {
  if (Math.abs(pattern.length - text.length) > maximumEdits) return false;
  let previous = Array.from({ length: text.length + 1 }, (_, index) => index);
  for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex += 1) {
    const current = [patternIndex];
    for (let textIndex = 1; textIndex <= text.length; textIndex += 1) {
      current[textIndex] = Math.min(
        previous[textIndex] + 1,
        current[textIndex - 1] + 1,
        previous[textIndex - 1] + (pattern[patternIndex - 1] === text[textIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[text.length] <= maximumEdits;
}

function fuzzyCandidateStarts(needle, haystack, maximumEdits) {
  const pattern = [...needle];
  const text = [...haystack];
  const chunks = maximumEdits + 1;
  const chunkLength = Math.max(1, Math.floor(pattern.length / chunks));
  const codeUnitToPoint = new Map();
  let codeUnitOffset = 0;
  for (let index = 0; index < text.length; index += 1) {
    codeUnitToPoint.set(codeUnitOffset, index);
    codeUnitOffset += text[index].length;
  }
  const candidates = new Set();
  if (maximumEdits >= pattern.length) {
    for (let index = 0; index <= text.length; index += 1) candidates.add(index);
  }
  for (let index = 0; index < chunks; index += 1) {
    const offset = index * chunkLength;
    const piece = index < chunks - 1
      ? pattern.slice(offset, offset + chunkLength).join("")
      : pattern.slice(offset).join("");
    if (!piece) continue;
    let cursor = 0;
    while (cursor <= haystack.length) {
      const found = haystack.indexOf(piece, cursor);
      if (found < 0) break;
      const pointIndex = codeUnitToPoint.get(found);
      if (pointIndex !== undefined) candidates.add(pointIndex - offset);
      cursor = found + 1;
    }
  }
  return { candidates: [...candidates].sort((left, right) => left - right), pattern, text };
}

function fuzzyMatchSpans(needle, haystack, maximumEdits = 0) {
  if (!needle) return [{ start: 0, end: 0 }];
  if (maximumEdits <= 0) {
    const text = [...haystack];
    const pattern = [...needle];
    const spans = [];
    for (let start = 0; start + pattern.length <= text.length; start += 1) {
      if (text.slice(start, start + pattern.length).join("") === needle) {
        spans.push({ start, end: start + pattern.length });
      }
    }
    return spans;
  }
  const { candidates, pattern, text } = fuzzyCandidateStarts(needle, haystack, maximumEdits);
  const spans = new Map();
  const minimumLength = Math.max(0, pattern.length - maximumEdits);
  const maximumLength = pattern.length + maximumEdits;
  for (const candidate of candidates) {
    const firstStart = Math.max(0, candidate - maximumEdits - 1);
    const lastStart = Math.min(text.length, candidate + maximumEdits + 1);
    for (let start = firstStart; start <= lastStart; start += 1) {
      for (let length = minimumLength; length <= maximumLength && start + length <= text.length; length += 1) {
        const end = start + length;
        if (editDistanceWithin(pattern, text.slice(start, end), maximumEdits)) {
          spans.set(`${start}:${end}`, { start, end });
        }
      }
    }
  }
  return [...spans.values()].sort((left, right) => left.start - right.start || left.end - right.end);
}

export function fuzzyIncludes(needle, haystack, maximumEdits = 0) {
  return fuzzyMatchSpans(needle, haystack, maximumEdits).length > 0;
}

function historicalSellersWithin(pattern, text, maximumEdits) {
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

function historicalFuzzyIncludes(needle, haystack, maximumEdits = 0) {
  if (!needle) return true;
  if (maximumEdits <= 0 || haystack.includes(needle)) return haystack.includes(needle);
  const chunks = maximumEdits + 1;
  const chunkLength = Math.max(1, Math.floor(needle.length / chunks));
  const candidates = new Set();
  for (let index = 0; index < chunks; index += 1) {
    const offset = index * chunkLength;
    const piece = index < chunks - 1 ? needle.slice(offset, offset + chunkLength) : needle.slice(offset);
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
  const span = needle.length + maximumEdits + 2;
  return [...candidates].sort((left, right) => left - right).some(candidate => {
    const start = Math.max(0, candidate - maximumEdits - 1);
    const end = Math.min(haystack.length, candidate + span);
    return historicalSellersWithin(needle, haystack.slice(start, end), maximumEdits);
  });
}

function historicalFuzzyPosition(needle, haystack, maximumEdits = 0) {
  if (!needle) return 0;
  const exact = haystack.indexOf(needle);
  if (exact >= 0 || maximumEdits <= 0) return exact;
  const chunks = maximumEdits + 1;
  const chunkLength = Math.max(1, Math.floor(needle.length / chunks));
  const candidates = new Set();
  for (let index = 0; index < chunks; index += 1) {
    const offset = index * chunkLength;
    const piece = index < chunks - 1 ? needle.slice(offset, offset + chunkLength) : needle.slice(offset);
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
    if (historicalSellersWithin(needle, haystack.slice(start, end), maximumEdits)) return candidate;
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

function scoreTable(test, tables, normalize = normalizeBenchmarkText, fuzzyMatch = fuzzyIncludes) {
  const cell = normalize(test.cell);
  const maximumEdits = test.max_diffs ?? 0;
  for (const table of tables) {
    for (let rowIndex = 0; rowIndex < table.length; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < table[rowIndex].length; columnIndex += 1) {
        if (!fuzzyMatch(cell, normalize(table[rowIndex][columnIndex]), maximumEdits)) continue;
        const neighbor = (row, column) => (
          row >= 0 && row < table.length && column >= 0 && column < table[row].length
            ? normalize(table[row][column])
            : null
        );
        let passed = true;
        for (const [key, rowOffset, columnOffset] of [
          ["up", -1, 0], ["down", 1, 0], ["left", 0, -1], ["right", 0, 1],
        ]) {
          if (test[key] === null || test[key] === undefined) continue;
          const observed = neighbor(rowIndex + rowOffset, columnIndex + columnOffset);
          if (observed === null || !fuzzyMatch(normalize(test[key]), observed, maximumEdits)) {
            passed = false;
            break;
          }
        }
        if (passed && test.top_heading !== null && test.top_heading !== undefined) {
          const observed = neighbor(0, columnIndex);
          passed = observed !== null
            && fuzzyMatch(normalize(test.top_heading), observed, maximumEdits);
        }
        if (passed && test.left_heading !== null && test.left_heading !== undefined) {
          const observed = neighbor(rowIndex, 0);
          passed = observed !== null
            && fuzzyMatch(normalize(test.left_heading), observed, maximumEdits);
        }
        if (passed) return true;
      }
    }
  }
  return false;
}

export function typedGapCoversFailure(testType, codes) {
  if (testType === "absent") return false;
  if ([...codes].some(code => WHOLE_TEXT_FAILURE_GAPS.has(code))) return true;
  if (testType === "table" && [...codes].some(code => TABLE_GAPS.has(code))) return true;
  if (testType === "math" && codes.has("MATH_NOT_RECONSTRUCTED")) return true;
  return false;
}

function historicalGapCoversFailure(testType, codes) {
  if ([...codes].some(code => (
    HISTORICAL_UNREADABLE_GAPS.has(code) || HISTORICAL_TRUNCATION_GAPS.has(code)
  ))) return true;
  if (testType === "table" && [...codes].some(code => TABLE_GAPS.has(code))) return true;
  return false;
}

function windowedText(value, first, last, concatenate) {
  if (first && last) return concatenate
    ? value.slice(0, first) + value.slice(-last)
    : value.slice(0, first).slice(-last);
  if (first) return value.slice(0, first);
  if (last) return value.slice(-last);
  return value;
}

function gapCodes(record) {
  return new Set((record?.gaps ?? [])
    .map(gap => typeof gap === "string" ? gap : gap?.code)
    .filter(Boolean));
}

export function scoreOlmocrTest(test, record) {
  const markdown = benchmarkMarkdownBody(record?.markdown);
  const normalized = normalizeBenchmarkText(markdown);
  const maximumEdits = test.max_diffs ?? 0;
  let passed = false;
  if (test.type === "present" || test.type === "absent") {
    let needle = normalizeBenchmarkText(test.text);
    let haystack = normalized;
    if (test.case_sensitive === false) {
      needle = needle.toLocaleLowerCase("en-US");
      haystack = haystack.toLocaleLowerCase("en-US");
    }
    haystack = windowedText(haystack, test.first_n, test.last_n, true);
    const found = fuzzyIncludes(needle, haystack, maximumEdits);
    passed = test.type === "present" ? found : !found;
  } else if (test.type === "order") {
    const before = fuzzyMatchSpans(normalizeBenchmarkText(test.before), normalized, maximumEdits);
    const after = fuzzyMatchSpans(normalizeBenchmarkText(test.after), normalized, maximumEdits);
    passed = before.some(beforeMatch => after.some(afterMatch => beforeMatch.end <= afterMatch.start));
  } else if (test.type === "table") {
    passed = scoreTable(test, parseMarkdownTables(markdown));
  } else if (test.type === "math") {
    const expected = normalizeBenchmarkText(test.math).replaceAll(" ", "");
    passed = expected.length > 0 && normalized.replaceAll(" ", "").includes(expected);
  } else if (test.type === "baseline") {
    passed = [...normalized].some(character => /[\p{L}\p{N}]/u.test(character));
  } else {
    throw new Error(`Unsupported olmOCR-bench test type: ${test.type}`);
  }
  if (passed) return "pass";
  const codes = gapCodes(record);
  const imageOnlyFailure = normalized.length === 0
    && codes.has("OCR_NOT_PERFORMED")
    && codes.has("IMAGE_CONTENT_NOT_RENDERED")
    && test.type !== "absent";
  return imageOnlyFailure || typedGapCoversFailure(test.type, codes)
    ? "failed_flagged"
    : "failed_silent";
}

export function scoreOlmocrTestHistorical(test, record) {
  const markdown = String(record?.markdown ?? "");
  const caseSensitive = normalizeWhitespace(markdown);
  const caseInsensitive = caseSensitive.toLocaleLowerCase("en-US");
  const maximumEdits = test.max_diffs ?? 0;
  let passed = false;
  if (test.type === "present") {
    let haystack = test.case_sensitive === false ? caseInsensitive : caseSensitive;
    let needle = normalizeWhitespace(test.text);
    if (test.case_sensitive === false) needle = needle.toLocaleLowerCase("en-US");
    haystack = windowedText(haystack, test.first_n, test.last_n, false);
    passed = historicalFuzzyIncludes(needle, haystack, maximumEdits);
  } else if (test.type === "absent") {
    passed = !historicalFuzzyIncludes(
      normalizeWhitespace(test.text).toLocaleLowerCase("en-US"),
      caseInsensitive,
      maximumEdits,
    );
  } else if (test.type === "order") {
    const before = historicalFuzzyPosition(normalizeWhitespace(test.before), caseSensitive, maximumEdits);
    const after = historicalFuzzyPosition(normalizeWhitespace(test.after), caseSensitive, maximumEdits);
    passed = before >= 0 && after >= 0 && before < after;
  } else if (test.type === "table") {
    passed = scoreTable(test, parseMarkdownTables(markdown), normalizeWhitespace, historicalFuzzyIncludes);
  } else if (test.type === "math") {
    const expected = normalizeWhitespace(test.math).replaceAll(" ", "");
    passed = expected.length > 0 && caseSensitive.replaceAll(" ", "").includes(expected);
  } else if (test.type === "baseline") {
    passed = caseSensitive.length > 0;
  } else {
    throw new Error(`Unsupported olmOCR-bench test type: ${test.type}`);
  }
  if (passed) return "pass";
  return historicalGapCoversFailure(test.type, gapCodes(record)) ? "failed_flagged" : "failed_silent";
}

function emptyBucket() {
  return { n: 0, pass: 0, failed_flagged: 0, failed_silent: 0, not_run: 0 };
}

function percentage(numerator, denominator) {
  return denominator ? Number((100 * numerator / denominator).toFixed(1)) : null;
}

function finishBucket(bucket, attemptedDenominator = true) {
  const attempted = bucket.n - bucket.not_run;
  const denominator = attemptedDenominator ? attempted : bucket.n;
  return {
    ...bucket,
    attempted,
    pass_pct: percentage(bucket.pass, denominator),
    failed_flagged_pct: percentage(bucket.failed_flagged, denominator),
    failed_silent_pct: percentage(bucket.failed_silent, denominator),
  };
}

function combineBuckets(buckets, attemptedDenominator) {
  const combined = emptyBucket();
  for (const bucket of buckets) {
    for (const key of Object.keys(combined)) combined[key] += bucket[key] ?? 0;
  }
  return finishBucket(combined, attemptedDenominator);
}

function aggregate({ tests, records, classifier, attemptedDenominator }) {
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
    if (!byCategory.has(test.category)) byCategory.set(test.category, emptyBucket());
    if (!byType.has(test.type)) byType.set(test.type, emptyBucket());
    const buckets = [byCategory.get(test.category), byType.get(test.type)];
    for (const bucket of buckets) bucket.n += 1;
    const record = recordsByPdf.get(test.pdf);
    if (!record || record.ok !== true) {
      for (const bucket of buckets) bucket.not_run += 1;
      continue;
    }
    const classification = classifier(test, record);
    for (const bucket of buckets) bucket[classification] += 1;
  }
  const finish = value => finishBucket(value, attemptedDenominator);
  const categories = Object.fromEntries([...byCategory].sort().map(([key, value]) => [key, finish(value)]));
  const types = Object.fromEntries([...byType].sort().map(([key, value]) => [key, finish(value)]));
  const nonMath = Object.entries(types).filter(([type]) => type !== "math").map(([, bucket]) => bucket);
  return {
    recordsByPdf,
    categories,
    types,
    overall: combineBuckets(Object.values(categories), attemptedDenominator),
    excludingMath: combineBuckets(nonMath, attemptedDenominator),
    math: finish(types.math ?? emptyBucket()),
  };
}

export function scoreOlmocrBenchHistorical({ tests, records }) {
  const result = aggregate({
    tests,
    records,
    classifier: scoreOlmocrTestHistorical,
    attemptedDenominator: false,
  });
  return {
    profile: "retained-first-run-js-v1-deprecated",
    gating: false,
    tests_total: tests.length,
    pdfs_observed: result.recordsByPdf.size,
    headline_excluding_math_proxy: result.excludingMath,
    math_proxy: result.math,
    overall_including_math_proxy: result.overall,
    by_category: result.categories,
    by_type: result.types,
  };
}

export function evaluateOlmocrRegressionGate(report, policy) {
  const checks = [];
  const addMaximum = (id, observed, maximum) => checks.push({ id, observed, maximum, pass: observed <= maximum });
  const addMinimum = (id, observed, minimum) => checks.push({ id, observed, minimum, pass: observed >= minimum });
  if (!report.qualifying) checks.push({ id: "qualifying_run", observed: false, expected: true, pass: false });
  else checks.push({ id: "qualifying_run", observed: true, expected: true, pass: true });
  addMinimum("headline_pass", report.headline_excluding_math_proxy.pass, policy.reference.headline_excluding_math_proxy.pass);
  addMaximum("headline_failed_silent", report.headline_excluding_math_proxy.failed_silent, policy.reference.headline_excluding_math_proxy.failed_silent);
  addMaximum("math_failed_silent", report.math_proxy.failed_silent, policy.reference.math_proxy.failed_silent);
  for (const [category, expected] of Object.entries(policy.reference.by_category)) {
    const observed = report.by_category[category];
    if (!observed) {
      checks.push({ id: `category_${category}_present`, observed: false, expected: true, pass: false });
      continue;
    }
    addMinimum(`category_${category}_pass`, observed.pass, expected.pass);
    addMaximum(`category_${category}_failed_silent`, observed.failed_silent, expected.failed_silent);
  }
  return {
    policy: policy.id,
    passed: checks.every(check => check.pass),
    checks,
  };
}

export function scoreOlmocrBench({
  tests,
  records,
  bindings = {},
  runQualifying = false,
  claimBoundary = null,
  gatePolicy = null,
}) {
  const result = aggregate({
    tests,
    records,
    classifier: scoreOlmocrTest,
    attemptedDenominator: true,
  });
  const expectedPdfs = new Set(tests.map(test => test.pdf));
  const complete = result.recordsByPdf.size === expectedPdfs.size
    && [...expectedPdfs].every(pdf => result.recordsByPdf.get(pdf)?.ok === true)
    && result.overall.not_run === 0;
  const boundary = claimBoundary ?? {
    comparability: "directional_only",
    release_gate_role: "internal_regression_tracking",
    public_benchmark_claim: "prohibited",
    required_caveats: [],
  };
  if (boundary.comparability !== "directional_only"
    || boundary.release_gate_role !== "internal_regression_tracking"
    || boundary.public_benchmark_claim !== "prohibited") {
    throw new Error("olmOCR-bench claim boundary is invalid");
  }
  const report = {
    schema: "pdf-tools.olmocr-bench-score.v2",
    benchmark_claim_ready: false,
    claim_boundary: boundary,
    bindings,
    qualifying: Boolean(runQualifying && complete),
    pdfs_expected: expectedPdfs.size,
    pdfs_observed: result.recordsByPdf.size,
    tests_total: tests.length,
    headline_excluding_math_proxy: result.excludingMath,
    math_proxy: result.math,
    overall_including_math_proxy: result.overall,
    by_category: result.categories,
    by_type: result.types,
    deprecated_candidate_profile: scoreOlmocrBenchHistorical({ tests, records }),
  };
  report.release_regression_gate = gatePolicy
    ? evaluateOlmocrRegressionGate(report, gatePolicy)
    : { policy: null, passed: false, checks: [{ id: "gate_policy_present", pass: false }] };
  return report;
}
