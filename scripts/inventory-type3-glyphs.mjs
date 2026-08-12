#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";
import {
  inspectType3GlyphEvidenceForPage,
  pdfjsFactoryDirectory,
} from "../server/layout-extraction.js";
import { loadPdfjsForMaintenance } from "../server/pdfjs-worker.js";

const require = createRequire(import.meta.url);

function exactSourceArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--source" || !path.isAbsolute(argv[1])) {
    throw new Error("Usage: node scripts/inventory-type3-glyphs.mjs --source /absolute/path/to/source.pdf");
  }
  return path.normalize(argv[1]);
}

function scalarLabel(value) {
  if (value === null) return null;
  return [...value].map(character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function loadPdfjs() {
  const pdfjs = await loadPdfjsForMaintenance();
  const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return { pdfjs, packageDirectory };
}

async function main() {
  const sourcePath = exactSourceArgument(process.argv.slice(2));
  if (await fs.realpath(sourcePath) !== sourcePath) throw new Error("Source path must be canonical");
  const bytes = await fs.readFile(sourcePath);
  const [{ pdfjs, packageDirectory }, pdfLibDocument] = await Promise.all([
    loadPdfjs(),
    PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }),
  ]);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    cMapUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "cmaps")),
    cMapPacked: true,
    standardFontDataUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "standard_fonts")),
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (document.numPages !== pdfLibDocument.getPageCount()) throw new Error("Parser page counts disagree");
    const occurrences = [];
    const abstentions = [];
    const strictRecoveries = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const [textContent, operators] = await Promise.all([
          page.getTextContent({ includeMarkedContent: false, disableNormalization: false }),
          page.getOperatorList(),
        ]);
        const pageInventory = inspectType3GlyphEvidenceForPage({
          textContent,
          operators,
          pdfjsPage: page,
          pdfLibPage: pdfLibDocument.getPage(pageNumber - 1),
          pdfjsLib: pdfjs,
        });
        for (const occurrence of pageInventory.occurrences) occurrences.push({ page: pageNumber, ...occurrence });
        for (const omission of pageInventory.omissions) abstentions.push({ page: pageNumber, ...omission });
        for (const recovery of pageInventory.strict_recoveries) strictRecoveries.push({ page: pageNumber, ...recovery });
      } finally {
        page.cleanup();
      }
    }

    const groups = new Map();
    for (const occurrence of occurrences) {
      const key = canonicalJson([
        occurrence.family,
        occurrence.original_char_code,
        occurrence.source_unicode,
        occurrence.intended_unicode,
        occurrence.glyph_sha256,
        occurrence.mapped_code_glyph_sha256,
        occurrence.registry_evidence_match_ids,
      ]);
      if (!groups.has(key)) groups.set(key, { ...occurrence, count: 0, pages: new Set(), locations_by_page: {} });
      const group = groups.get(key);
      group.count += 1;
      group.pages.add(occurrence.page);
      group.locations_by_page[occurrence.page] ??= [];
      group.locations_by_page[occurrence.page].push([occurrence.operator_index, occurrence.glyph_index]);
    }
    const inventory = [...groups.values()].map(group => ({
      family: group.family,
      family_status: group.family_status,
      original_char_code: group.original_char_code,
      source_unicode: group.source_unicode,
      source_unicode_codepoints: scalarLabel(group.source_unicode),
      intended_unicode: group.intended_unicode,
      intended_unicode_codepoints: scalarLabel(group.intended_unicode),
      glyph_sha256: group.glyph_sha256,
      mapped_code_glyph_sha256: group.mapped_code_glyph_sha256,
      registry_evidence_match_ids: group.registry_evidence_match_ids,
      count: group.count,
      pages: [...group.pages].sort((left, right) => left - right),
      locations_by_page: group.locations_by_page,
      tfm_reference_version: group.tfm_reference_version,
      glyph_evidence_version: group.glyph_evidence_version,
    })).sort((left, right) => right.count - left.count
      || String(left.family).localeCompare(String(right.family))
      || left.original_char_code - right.original_char_code
      || String(left.glyph_sha256).localeCompare(String(right.glyph_sha256)));
    const abstentionGroups = new Map();
    for (const abstention of abstentions) {
      const key = canonicalJson([abstention.reason, abstention.family ?? null]);
      if (!abstentionGroups.has(key)) abstentionGroups.set(key, {
        reason: abstention.reason,
        scope: abstention.scope ?? "operator_evidence",
        ...(abstention.family ? { family: abstention.family } : {}),
        count: 0,
        pages: new Set(),
      });
      const group = abstentionGroups.get(key);
      group.count += abstention.count ?? 1;
      group.pages.add(abstention.page);
    }
    const strictRecoveryCountsByRegistry = Object.fromEntries([...strictRecoveries.reduce((counts, recovery) => {
      counts.set(recovery.registry_id, (counts.get(recovery.registry_id) ?? 0) + 1);
      return counts;
    }, new Map())].sort());
    const type3OmittedOccurrenceCount = abstentions
      .filter(item => item.scope === "type3_glyph")
      .reduce((sum, item) => sum + (item.count ?? 1), 0);
    const classifiedOccurrenceCount = occurrences.filter(item => item.family !== null).length;
    const officiallyNamedOccurrenceCount = occurrences.filter(item => item.intended_unicode !== null).length;
    const registryEvidenceOccurrenceCount = occurrences.filter(item => item.registry_evidence_match_ids.length > 0).length;
    process.stdout.write(`${canonicalJson({
      schema: "pdf-tools.type3-glyph-inventory.v1",
      source: {
        filename: path.basename(sourcePath),
        page_count: document.numPages,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size_bytes: bytes.length,
      },
      occurrence_count: occurrences.length,
      coverage: {
        observed_type3_occurrence_count: occurrences.length + type3OmittedOccurrenceCount,
        linked_type3_occurrence_count: occurrences.length,
        omitted_type3_occurrence_count: type3OmittedOccurrenceCount,
        classified_occurrence_count: classifiedOccurrenceCount,
        unclassified_occurrence_count: occurrences.length - classifiedOccurrenceCount,
        officially_named_occurrence_count: officiallyNamedOccurrenceCount,
        officially_unnamed_occurrence_count: occurrences.length - officiallyNamedOccurrenceCount,
        registry_evidence_occurrence_count: registryEvidenceOccurrenceCount,
        strict_recovery_count: strictRecoveries.length,
        officially_named_not_strictly_recovered_count: officiallyNamedOccurrenceCount - strictRecoveries.length,
      },
      strict_recovery_counts_by_registry: strictRecoveryCountsByRegistry,
      abstentions: [...abstentionGroups.values()].map(group => ({
        ...group,
        pages: [...group.pages].sort((left, right) => left - right),
      })).sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
      groups: inventory,
    })}\n`);
  } finally {
    await document?.destroy();
    await loadingTask.destroy();
  }
}

await main();
