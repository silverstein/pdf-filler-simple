import { createHash } from "node:crypto";
import vm from "node:vm";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isIdentifierCharacter(character) {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function skipLineComment(source, start) {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source, start, filename) {
  const end = source.indexOf("*/", start + 2);
  if (end === -1) {
    throw new Error(`${filename}: unterminated block comment at offset ${start}`);
  }
  return end + 2;
}

function regexCanStart(source, start) {
  let index = start - 1;
  while (index >= 0 && /\s/.test(source[index])) index -= 1;
  if (index < 0) return true;
  if (
    (source[index] === "+" || source[index] === "-")
    && source[index - 1] === source[index]
  ) {
    return false;
  }
  if ("([{:;,=!?&|+-*%^~<>".includes(source[index])) return true;
  if (!isIdentifierCharacter(source[index])) return false;
  const end = index + 1;
  while (index >= 0 && isIdentifierCharacter(source[index])) index -= 1;
  return new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]).has(source.slice(index + 1, end));
}

function skipRegexLiteral(source, start, filename) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "[") inCharacterClass = true;
    if (source[index] === "]") inCharacterClass = false;
    if (source[index] === "/" && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/.test(source[index])) index += 1;
      return index;
    }
    if (/[\r\n]/.test(source[index])) {
      throw new Error(`${filename}: unterminated regular expression at offset ${start}`);
    }
    index += 1;
  }
  throw new Error(`${filename}: unterminated regular expression at offset ${start}`);
}

function skipTrivia(source, start, filename) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index, filename);
      continue;
    }
    if (source[index] === "/" && regexCanStart(source, index)) {
      index = skipRegexLiteral(source, index, filename);
      continue;
    }
    break;
  }
  return index;
}

function readQuotedLiteral(source, start, filename) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) {
      const end = index + 1;
      const raw = source.slice(start, end);
      let value;
      const rawValue = source.slice(start + 1, index);
      if (!rawValue.includes("\\")) {
        value = rawValue;
      } else {
        try {
          value = vm.runInNewContext(raw, Object.create(null), { timeout: 10 });
        } catch (error) {
          throw new Error(
            `${filename}: invalid string literal at offset ${start}: ${error.message}`,
            { cause: error },
          );
        }
      }
      if (typeof value !== "string") {
        throw new Error(`${filename}: non-string literal at offset ${start}`);
      }
      return { end, raw, value };
    }
    if ((quote === "'" || quote === '"') && /[\r\n]/.test(character)) {
      throw new Error(`${filename}: unterminated string literal at offset ${start}`);
    }
    index += 1;
  }
  throw new Error(`${filename}: unterminated string literal at offset ${start}`);
}

function skipBracedTemplateExpression(source, start, filename) {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index, filename);
      continue;
    }
    if (source[index] === "/" && regexCanStart(source, index)) {
      index = skipRegexLiteral(source, index, filename);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      index = readQuotedLiteral(source, index, filename).end;
      continue;
    }
    if (source[index] === "`") {
      index = readTemplateLiteral(source, index, filename).end;
      continue;
    }
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  throw new Error(`${filename}: unterminated template expression at offset ${start}`);
}

function readTemplateLiteral(source, start, filename) {
  let index = start + 1;
  let interpolated = false;
  const interpolations = [];
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") {
      const end = index + 1;
      const raw = source.slice(start, end);
      if (interpolated) {
        return { end, interpolations, raw, value: null };
      }
      let value;
      const rawValue = source.slice(start + 1, index);
      if (!rawValue.includes("\\")) {
        value = rawValue;
      } else {
        try {
          value = vm.runInNewContext(raw, Object.create(null), { timeout: 10 });
        } catch (error) {
          throw new Error(
            `${filename}: invalid template literal at offset ${start}: ${error.message}`,
            { cause: error },
          );
        }
      }
      return { end, interpolations, raw, value };
    }
    if (source.startsWith("${", index)) {
      interpolated = true;
      const expressionStart = index + 2;
      index = skipBracedTemplateExpression(source, expressionStart, filename);
      interpolations.push(Object.freeze({
        source: source.slice(expressionStart, index - 1),
        start: expressionStart,
      }));
      continue;
    }
    index += 1;
  }
  throw new Error(`${filename}: unterminated template literal at offset ${start}`);
}

function readParenthesizedExpression(source, start, filename) {
  let depth = 1;
  let index = start + 1;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index, filename);
      continue;
    }
    if (source[index] === "/" && regexCanStart(source, index)) {
      index = skipRegexLiteral(source, index, filename);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      index = readQuotedLiteral(source, index, filename).end;
      continue;
    }
    if (source[index] === "`") {
      index = readTemplateLiteral(source, index, filename).end;
      continue;
    }
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        const rawExpression = source.slice(start + 1, index);
        return {
          end: index + 1,
          expression: rawExpression.trim(),
          expressionStart: start + 1,
          rawExpression,
        };
      }
    }
    index += 1;
  }
  throw new Error(`${filename}: unterminated import expression at offset ${start}`);
}

function completeLiteralValue(expression, filename) {
  const start = skipTrivia(expression, 0, filename);
  if (!["'", '"', "`"].includes(expression[start])) return null;
  const literal = expression[start] === "`"
    ? readTemplateLiteral(expression, start, filename)
    : readQuotedLiteral(expression, start, filename);
  if (literal.value === null) return null;
  const end = skipTrivia(expression, literal.end, filename);
  return end === expression.length ? literal.value : null;
}

function completeImportMetaUrlReference(expression, filename) {
  let index = skipTrivia(expression, 0, filename);
  if (!["'", '"', "`"].includes(expression[index])) return null;
  const literalStart = index;
  const literal = expression[index] === "`"
    ? readTemplateLiteral(expression, index, filename)
    : readQuotedLiteral(expression, index, filename);
  if (literal.value === null) return null;
  index = skipTrivia(expression, literal.end, filename);
  if (expression[index] !== ",") return null;
  index = skipTrivia(expression, index + 1, filename);
  const authority = "import.meta.url";
  if (!expression.startsWith(authority, index)) return null;
  index = skipTrivia(expression, index + authority.length, filename);
  return index === expression.length
    ? Object.freeze({
        end: literal.end,
        literal: literal.value,
        start: literalStart,
      })
    : null;
}

export function extractModuleLoadEvidence(
  source,
  {
    filename = "JavaScript source",
    sourceOffset = 0,
  } = {},
) {
  if (typeof source !== "string") {
    throw new TypeError("module-load evidence source must be a string");
  }
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
    throw new TypeError("module-load evidence sourceOffset must be a nonnegative integer");
  }
  const stringValues = [];
  const stringLiterals = [];
  const dynamicImports = [];
  const newUrlReferences = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index, filename);
      continue;
    }
    if (source[index] === "/" && regexCanStart(source, index)) {
      index = skipRegexLiteral(source, index, filename);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      const literal = readQuotedLiteral(source, index, filename);
      stringValues.push(literal.value);
      stringLiterals.push(Object.freeze({
        end: sourceOffset + literal.end,
        start: sourceOffset + index,
        value: literal.value,
      }));
      index = literal.end;
      continue;
    }
    if (source[index] === "`") {
      const literal = readTemplateLiteral(source, index, filename);
      if (literal.value !== null) {
        stringValues.push(literal.value);
        stringLiterals.push(Object.freeze({
          end: sourceOffset + literal.end,
          start: sourceOffset + index,
          value: literal.value,
        }));
      }
      for (const interpolation of literal.interpolations) {
        const nested = extractModuleLoadEvidence(interpolation.source, {
          filename,
          sourceOffset: sourceOffset + interpolation.start,
        });
        stringValues.push(...nested.stringValues);
        stringLiterals.push(...nested.stringLiterals);
        dynamicImports.push(...nested.dynamicImports);
        newUrlReferences.push(...nested.newUrlReferences);
      }
      index = literal.end;
      continue;
    }
    if (
      source.startsWith("new", index)
      && !isIdentifierCharacter(source[index - 1])
      && source[index - 1] !== "."
      && !isIdentifierCharacter(source[index + 3])
    ) {
      const urlStart = skipTrivia(source, index + 3, filename);
      if (
        source.startsWith("URL", urlStart)
        && !isIdentifierCharacter(source[urlStart - 1])
        && !isIdentifierCharacter(source[urlStart + 3])
      ) {
        const parenthesis = skipTrivia(source, urlStart + 3, filename);
        if (source[parenthesis] === "(") {
          const loaded = readParenthesizedExpression(
            source,
            parenthesis,
            filename,
          );
          const nested = extractModuleLoadEvidence(loaded.rawExpression, {
            filename,
            sourceOffset: sourceOffset + loaded.expressionStart,
          });
          stringValues.push(...nested.stringValues);
          stringLiterals.push(...nested.stringLiterals);
          dynamicImports.push(...nested.dynamicImports);
          newUrlReferences.push(...nested.newUrlReferences);
          const reference = completeImportMetaUrlReference(
            loaded.rawExpression,
            filename,
          );
          if (reference !== null) {
            newUrlReferences.push(Object.freeze({
              expression: loaded.expression,
              end: sourceOffset + loaded.end,
              kind: "new-url-import-meta",
              literal: reference.literal,
              referenceEnd:
                sourceOffset + loaded.expressionStart + reference.end,
              referenceStart:
                sourceOffset + loaded.expressionStart + reference.start,
              start: sourceOffset + index,
            }));
          }
          index = loaded.end;
          continue;
        }
      }
    }
    if (
      source.startsWith("import", index)
      && !isIdentifierCharacter(source[index - 1])
      && source[index - 1] !== "."
      && !isIdentifierCharacter(source[index + 6])
    ) {
      const parenthesis = skipTrivia(source, index + 6, filename);
      if (source[parenthesis] === "(") {
        const loaded = readParenthesizedExpression(
          source,
          parenthesis,
          filename,
        );
        const literal = completeLiteralValue(loaded.expression, filename);
        const nested = extractModuleLoadEvidence(loaded.rawExpression, {
          filename,
          sourceOffset: sourceOffset + loaded.expressionStart,
        });
        stringValues.push(...nested.stringValues);
        stringLiterals.push(...nested.stringLiterals);
        dynamicImports.push(Object.freeze({
          end: sourceOffset + loaded.end,
          expression: loaded.expression,
          fingerprint: sha256(loaded.expression),
          kind: "dynamic-import",
          literal,
          start: sourceOffset + index,
        }));
        dynamicImports.push(...nested.dynamicImports);
        newUrlReferences.push(...nested.newUrlReferences);
        index = loaded.end;
        continue;
      }
    }
    index += 1;
  }
  return Object.freeze({
    dynamicImports: Object.freeze(dynamicImports),
    newUrlReferences: Object.freeze(newUrlReferences),
    stringLiterals: Object.freeze(stringLiterals),
    stringValues: Object.freeze(stringValues),
  });
}
