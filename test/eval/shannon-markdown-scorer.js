function stripMarkdown(value) {
  return value
    .replace(/<!--[^]*?-->/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "");
}

export function normalizeShannonText(value) {
  return stripMarkdown(String(value ?? ""))
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedCount(haystack, needle) {
  const target = normalizeShannonText(needle);
  if (!target) return 0;
  const isWordCharacter = value => typeof value === "string" && /[\p{L}\p{N}]/u.test(value);
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - target.length) {
    const found = haystack.indexOf(target, offset);
    if (found < 0) break;
    const leftBoundary = !isWordCharacter(target[0]) || !isWordCharacter(haystack[found - 1]);
    const rightBoundary = !isWordCharacter(target.at(-1)) || !isWordCharacter(haystack[found + target.length]);
    if (leftBoundary && rightBoundary) count += 1;
    offset = found + target.length;
  }
  return count;
}

function headingRecords(markdown) {
  return String(markdown ?? "")
    .split(/\r?\n/u)
    .map(line => /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line))
    .filter(Boolean)
    .map(match => ({ level: match[1].length, text: stripMarkdown(match[2]).trim() }));
}

function looksLikeEquationHeading(heading, expected) {
  const normalized = normalizeShannonText(heading.text);
  if (expected.has(normalized)) return false;
  return /[=∑∞≤≥]|\b(?:lim|log|exp|sin|cos|max|min)\b|\b[hpcrn]\s*\([^)]*\)/iu.test(heading.text)
    || (/\d/u.test(heading.text) && /[+*/^]/u.test(heading.text));
}

function looksMalformedOrFragmentary(heading, expected) {
  const normalized = normalizeShannonText(heading.text);
  if (expected.has(normalized)) return false;
  return heading.text.includes("\uFFFD") || normalized.length <= 2;
}

function scoreHeadings(markdown, oracle) {
  const headings = headingRecords(markdown);
  const expected = new Map(oracle.expected_headings.map(item => [normalizeShannonText(item.text), item]));
  const found = [];
  const wrongLevel = [];
  for (const [normalized, item] of expected) {
    const matches = headings.filter(heading => normalizeShannonText(heading.text) === normalized);
    if (matches.length > 0) found.push(item.text);
    if (matches.length > 0 && matches.every(heading => heading.level !== item.level)) {
      wrongLevel.push({ text: item.text, expected_level: item.level, observed_levels: [...new Set(matches.map(match => match.level))] });
    }
  }
  const equationLikeFalsePositives = headings
    .filter(heading => looksLikeEquationHeading(heading, expected))
    .slice(0, 100);
  const malformedOrFragmentaryFalsePositives = headings
    .filter(heading => looksMalformedOrFragmentary(heading, expected))
    .slice(0, 100);
  return {
    expected: expected.size,
    found: found.length,
    missing: [...expected.values()].map(item => item.text).filter(text => !found.includes(text)),
    wrong_level: wrongLevel,
    equation_like_false_positive_count: headings.filter(heading => looksLikeEquationHeading(heading, expected)).length,
    equation_like_false_positives: equationLikeFalsePositives,
    malformed_or_fragmentary_false_positive_count: headings
      .filter(heading => looksMalformedOrFragmentary(heading, expected)).length,
    malformed_or_fragmentary_false_positives: malformedOrFragmentaryFalsePositives,
  };
}

function scoreOrderedAnchors(normalized, oracle) {
  const groups = oracle.ordered_anchor_groups.map(group => {
    let cursor = 0;
    const missing = [];
    for (const anchor of group) {
      const target = normalizeShannonText(anchor);
      const found = normalized.indexOf(target, cursor);
      if (found < 0) missing.push(anchor);
      else cursor = found + target.length;
    }
    return { anchors: group.length, in_order: group.length - missing.length, missing_or_reordered: missing };
  });
  return {
    groups: groups.length,
    complete_groups: groups.filter(group => group.in_order === group.anchors).length,
    anchors: groups.reduce((total, group) => total + group.anchors, 0),
    in_order: groups.reduce((total, group) => total + group.in_order, 0),
    details: groups,
  };
}

function scorePresence(normalized, values, key) {
  const details = values.map(value => ({ [key]: value, present: normalized.includes(normalizeShannonText(value)) }));
  return { expected: details.length, found: details.filter(item => item.present).length, details };
}

function markdownPages(markdown) {
  const source = String(markdown ?? "");
  const markers = [...source.matchAll(/<!--\s*(?:PDF\s+)?page\s+(\d+)\s*-->/giu)];
  return new Map(markers.map((marker, index) => [
    Number(marker[1]),
    normalizeShannonText(source.slice(marker.index, markers[index + 1]?.index ?? source.length)),
  ]));
}

function normalizedTokenIndex(haystack, needle, offset) {
  const isWordCharacter = value => typeof value === "string" && /[\p{L}\p{N}]/u.test(value);
  let cursor = offset;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) return -1;
    const leftBoundary = !isWordCharacter(needle[0]) || !isWordCharacter(haystack[found - 1]);
    const rightBoundary = !isWordCharacter(needle.at(-1)) || !isWordCharacter(haystack[found + needle.length]);
    if (leftBoundary && rightBoundary) return found;
    cursor = found + 1;
  }
  return -1;
}

function scoreEquations(markdown, oracle) {
  const pages = markdownPages(markdown);
  const maximumSpan = oracle.equation_max_span_characters;
  const details = oracle.equation_anchors.map(anchor => {
    const normalized = pages.get(anchor.page) ?? "";
    const targets = anchor.tokens.map(normalizeShannonText);
    let cursor = 0;
    let firstOffset = null;
    const missing = [];
    for (const [index, target] of targets.entries()) {
      const found = normalizedTokenIndex(normalized, target, cursor);
      if (found < 0 || (firstOffset !== null && found + target.length - firstOffset > maximumSpan)) {
        missing.push(anchor.tokens[index]);
      } else {
        if (firstOffset === null) firstOffset = found;
        cursor = found + target.length;
      }
    }
    return {
      page: anchor.page,
      tokens: anchor.tokens,
      maximum_span_characters: maximumSpan,
      observed_span_characters: missing.length === 0 && firstOffset !== null ? cursor - firstOffset : null,
      present_in_order: missing.length === 0,
      missing_or_reordered: missing,
    };
  });
  return { expected: details.length, found: details.filter(item => item.present_in_order).length, details };
}

function parseMarkdownTables(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/u);
  const tables = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!/^\s*\|.*\|\s*$/u.test(lines[index]) || !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(lines[index + 1])) continue;
    const rows = [lines[index]];
    let next = index + 2;
    while (next < lines.length && /^\s*\|.*\|\s*$/u.test(lines[next])) {
      rows.push(lines[next]);
      next += 1;
    }
    tables.push({ start_line: index + 1, rows, normalized: normalizeShannonText(rows.join(" ")) });
    index = next - 1;
  }
  return tables;
}

function scoreTable(markdown, normalized, oracle) {
  const tables = parseMarkdownTables(markdown);
  const label = normalizeShannonText(oracle.table.label);
  const labelOffset = normalized.indexOf(label);
  const headerTerms = oracle.table.required_header_terms.map(term => ({
    term,
    present: normalized.includes(normalizeShannonText(term)),
  }));
  const qualifying = tables.filter(table => {
    const normalizedHeader = normalizeShannonText(table.rows[0]);
    return oracle.table.required_header_terms.every(term => normalizedHeader.includes(normalizeShannonText(term)));
  });
  return {
    label_present: labelOffset >= 0,
    markdown_table_count: tables.length,
    required_header_terms: headerTerms,
    qualifying_table_count: qualifying.length,
    minimum_data_rows: oracle.table.minimum_data_rows,
    topology_present: qualifying.some(table => table.rows.length - 1 >= oracle.table.minimum_data_rows),
  };
}

function scoreDuplication(normalized, oracle) {
  const details = oracle.exactly_once_anchors.map(anchor => ({
    anchor,
    count: normalizedCount(normalized, anchor),
  }));
  return {
    expected: details.length,
    exactly_once: details.filter(item => item.count === 1).length,
    omitted: details.filter(item => item.count === 0).map(item => item.anchor),
    duplicated: details.filter(item => item.count > 1),
    details,
  };
}

export function scoreShannonMarkdown({ markdown, oracle, evidence }) {
  if (typeof markdown !== "string" || markdown.length < 1 || !oracle || typeof oracle !== "object") {
    throw new Error("Shannon scorer requires non-empty Markdown and a declared oracle");
  }
  const normalized = normalizeShannonText(markdown);
  return {
    scorer: { name: "pdf-tools.shannon-markdown-scorer", version: 1 },
    scope: oracle.scope,
    heading_hierarchy: scoreHeadings(markdown, oracle),
    reading_order: scoreOrderedAnchors(normalized, oracle),
    paragraph_continuity: scorePresence(normalized, oracle.paragraph_continuity, "phrase"),
    equations: scoreEquations(markdown, oracle),
    footnotes: scorePresence(normalized, oracle.footnote_anchors, "anchor"),
    table_topology: scoreTable(markdown, normalized, oracle),
    omissions_and_duplication: scoreDuplication(normalized, oracle),
    evidence: {
      page_identity: evidence?.page_identity === true,
      typed_coverage_gaps: evidence?.typed_coverage_gaps === true,
      canonical_coordinates: evidence?.canonical_coordinates === true,
      engine_native_coordinates: evidence?.engine_native_coordinates === true,
    },
  };
}
