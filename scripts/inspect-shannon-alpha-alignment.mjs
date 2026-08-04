#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { loadPdfjsForMaintenance } from "../server/pdfjs-worker.js";
import { pdfjsFactoryDirectory } from "../server/layout-extraction.js";

const require = createRequire(import.meta.url);
const sourcePath = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) {
  throw new Error("Usage: inspect-shannon-alpha-alignment.mjs /absolute/source.pdf");
}

function scalars(value) {
  return [...String(value ?? "")];
}

function label(value) {
  return scalars(value).map(character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
}

const pdfjs = await loadPdfjsForMaintenance();
const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
const bytes = await fs.readFile(sourcePath);
const loadingTask = pdfjs.getDocument({
  data: new Uint8Array(bytes),
  useWorkerFetch: false,
  isEvalSupported: false,
  cMapUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "cmaps")),
  cMapPacked: true,
  standardFontDataUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "standard_fonts")),
});

const document = await loadingTask.promise;
const regions = [];
const operationNames = new Map(Object.entries(pdfjs.OPS).map(([name, value]) => [value, name]));

function summarizedArgs(operation, args) {
  if (operation !== pdfjs.OPS.showText) return args;
  return (args?.[0] ?? []).map(value => typeof value === "number" ? value : {
    unicode: value?.unicode,
    codepoint: label(value?.unicode),
    original_char_code: value?.originalCharCode,
    width: value?.width,
  });
}
try {
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    try {
      const [textContent, operators] = await Promise.all([
        page.getTextContent({ includeMarkedContent: false, disableNormalization: false }),
        page.getOperatorList(),
      ]);
      let currentFont = null;
      const fontStack = [];
      const operatorTokens = [];
      for (let operatorIndex = 0; operatorIndex < operators.fnArray.length; operatorIndex += 1) {
        const operation = operators.fnArray[operatorIndex];
        const args = operators.argsArray[operatorIndex];
        if (operation === pdfjs.OPS.save) fontStack.push(currentFont);
        else if (operation === pdfjs.OPS.restore) currentFont = fontStack.pop() ?? null;
        else if (operation === pdfjs.OPS.setFont) currentFont = typeof args?.[0] === "string" ? args[0] : null;
        else if (operation === pdfjs.OPS.showText && Array.isArray(args?.[0])) {
          for (let glyphIndex = 0; glyphIndex < args[0].length; glyphIndex += 1) {
            const glyph = args[0][glyphIndex];
            if (!glyph || typeof glyph !== "object") continue;
            for (const originalUnicode of scalars(glyph.unicode)) {
              for (const unicode of scalars(originalUnicode.normalize("NFKC"))) {
                operatorTokens.push({
                  unicode,
                  font_id: currentFont,
                  operator_index: operatorIndex,
                  glyph_index: glyphIndex,
                  original_char_code: glyph.originalCharCode,
                });
              }
            }
          }
        }
      }
      const textTokens = [];
      for (let sourceIndex = 0; sourceIndex < textContent.items.length; sourceIndex += 1) {
        const item = textContent.items[sourceIndex];
        if (typeof item?.str !== "string") continue;
        let utf16Offset = 0;
        for (const originalUnicode of scalars(item.str)) {
          for (const unicode of scalars(originalUnicode.normalize("NFKC"))) {
            textTokens.push({
              unicode,
              font_id: item.fontName,
              source_index: sourceIndex,
              source_utf16_start: utf16Offset,
              source_utf16_end: utf16Offset + originalUnicode.length,
            });
          }
          utf16Offset += originalUnicode.length;
        }
      }
      const operatorVisible = operatorTokens.filter(token => !/^\s$/u.test(token.unicode));
      const textVisible = textTokens.filter(token => !/^\s$/u.test(token.unicode));
      if (operatorVisible.length !== textVisible.length) throw new Error(`Page ${pageNumber} visible token counts differ`);
      for (let index = 0; index < operatorVisible.length; index += 1) {
        if (operatorVisible[index].unicode !== textVisible[index].unicode
          || operatorVisible[index].font_id !== textVisible[index].font_id) {
          throw new Error(`Page ${pageNumber} visible token ${index} differs`);
        }
        operatorVisible[index].text_binding = textVisible[index];
      }
      const alphaIndexes = operatorTokens
        .map((token, index) => [token, index])
        .filter(([token]) => token.original_char_code === 11 && token.unicode === "\u000b")
        .map(([, index]) => index);
      const seen = new Set();
      for (const alphaIndex of alphaIndexes) {
        let start = alphaIndex;
        let end = alphaIndex + 1;
        while (start > 0 && /^\s$/u.test(operatorTokens[start - 1].unicode)) start -= 1;
        while (end < operatorTokens.length && /^\s$/u.test(operatorTokens[end].unicode)) end += 1;
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const previous = operatorTokens.slice(0, start).reverse().find(token => !/^\s$/u.test(token.unicode)) ?? null;
        const next = operatorTokens.slice(end).find(token => !/^\s$/u.test(token.unicode)) ?? null;
        const textStart = previous?.text_binding
          ? textTokens.findIndex(token => token === previous.text_binding) + 1
          : 0;
        const nextTextIndex = next?.text_binding ? textTokens.findIndex(token => token === next.text_binding) : textTokens.length;
        const textRun = textTokens.slice(textStart, nextTextIndex);
        const operatorRun = operatorTokens.slice(start, end);
        const targetOperatorIndex = operatorRun[0].operator_index;
        const previousSourceIndex = previous?.text_binding?.source_index ?? -1;
        const nextSourceIndex = next?.text_binding?.source_index ?? textContent.items.length;
        const summarizedItem = sourceIndex => {
          const item = textContent.items[sourceIndex];
          return item ? { source_index: sourceIndex, str: item.str, font_id: item.fontName, transform: item.transform, width: item.width, height: item.height, has_eol: item.hasEOL } : null;
        };
        regions.push({
          page: pageNumber,
          previous: previous ? { unicode: previous.unicode, font_id: previous.font_id, binding: previous.text_binding } : null,
          next: next ? { unicode: next.unicode, font_id: next.font_id, binding: next.text_binding } : null,
          previous_item: summarizedItem(previousSourceIndex),
          next_item: summarizedItem(nextSourceIndex),
          operator_run: operatorRun.map(token => ({ ...token, codepoint: label(token.unicode) })),
          text_run: textRun.map(token => ({ ...token, codepoint: label(token.unicode) })),
          text_items_between: textContent.items.slice(previousSourceIndex + 1, nextSourceIndex).map((item, offset) => ({
            source_index: previousSourceIndex + 1 + offset,
            str: item.str,
            str_codepoints: label(item.str),
            font_id: item.fontName,
            direction: item.dir,
            transform: item.transform,
            width: item.width,
            height: item.height,
            has_eol: item.hasEOL,
          })),
          operator_context: operators.fnArray.slice(Math.max(0, targetOperatorIndex - 12), targetOperatorIndex + 4)
            .map((operation, offset) => {
              const operatorIndex = Math.max(0, targetOperatorIndex - 12) + offset;
              return {
                operator_index: operatorIndex,
                operation: operationNames.get(operation) ?? operation,
                args: summarizedArgs(operation, operators.argsArray[operatorIndex]),
              };
            }),
        });
      }
    } finally {
      page.cleanup();
    }
  }
} finally {
  await document.destroy();
}

process.stdout.write(`${JSON.stringify({ region_count: regions.length, regions }, null, 2)}\n`);
