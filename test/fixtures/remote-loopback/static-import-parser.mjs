import fs from "node:fs/promises";
import vm from "node:vm";

const filename = process.argv[2];
if (!filename) throw new Error("Expected a source filename");
const source = await fs.readFile(filename, "utf8");
const module = new vm.SourceTextModule(source, { identifier: filename });

function skipQuoted(index, quote) {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
    } else if (source[cursor] === quote) {
      return cursor + 1;
    }
  }
  return source.length;
}

function skipTrivia(index) {
  let cursor = index;
  for (;;) {
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
    } else if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
    } else {
      return cursor;
    }
  }
}

const computedLoads = [];
const FORBIDDEN_EXECUTION_TOKENS = new Set([
  "eval",
  "Function",
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
]);

function scanTemplate(index) {
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
    } else if (source[cursor] === "`") {
      return cursor + 1;
    } else if (source.startsWith("${", cursor)) {
      cursor = scanCode(cursor + 2, true);
    } else {
      cursor += 1;
    }
  }
  return source.length;
}

function scanCode(index, templateExpression = false) {
  let cursor = index;
  let braceDepth = templateExpression ? 1 : 0;
  while (cursor < source.length) {
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source[cursor] === "'" || source[cursor] === '"') {
      cursor = skipQuoted(cursor, source[cursor]);
      continue;
    }
    if (source[cursor] === "`") {
      cursor = scanTemplate(cursor);
      continue;
    }
    if (templateExpression && source[cursor] === "{") {
      braceDepth += 1;
      cursor += 1;
      continue;
    }
    if (templateExpression && source[cursor] === "}") {
      braceDepth -= 1;
      cursor += 1;
      if (braceDepth === 0) return cursor;
      continue;
    }
    if (/[A-Za-z_$]/u.test(source[cursor])) {
      const start = cursor;
      cursor += 1;
      while (
        cursor < source.length &&
        /[A-Za-z0-9_$]/u.test(source[cursor])
      ) {
        cursor += 1;
      }
      const token = source.slice(start, cursor);
      if (
        (token === "import" || token === "require") &&
        source[skipTrivia(cursor)] === "("
      ) {
        computedLoads.push({ kind: token, offset: start });
      } else if (FORBIDDEN_EXECUTION_TOKENS.has(token)) {
        computedLoads.push({ kind: token, offset: start });
      }
      continue;
    }
    cursor += 1;
  }
  return cursor;
}

scanCode(0);
process.stdout.write(`${JSON.stringify({
  dependency_specifiers: module.dependencySpecifiers,
  computed_loads: computedLoads,
})}\n`);
