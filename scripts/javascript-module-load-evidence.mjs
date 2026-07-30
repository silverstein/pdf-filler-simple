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
      interpolations.push(source.slice(expressionStart, index - 1));
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
        return {
          end: index + 1,
          expression: source.slice(start + 1, index).trim(),
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

export function extractModuleLoadEvidence(
  source,
  { filename = "JavaScript source" } = {},
) {
  if (typeof source !== "string") {
    throw new TypeError("module-load evidence source must be a string");
  }
  const stringValues = [];
  const dynamicImports = [];
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
      index = literal.end;
      continue;
    }
    if (source[index] === "`") {
      const literal = readTemplateLiteral(source, index, filename);
      if (literal.value !== null) stringValues.push(literal.value);
      for (const interpolation of literal.interpolations) {
        const nested = extractModuleLoadEvidence(interpolation, { filename });
        stringValues.push(...nested.stringValues);
        dynamicImports.push(...nested.dynamicImports);
      }
      index = literal.end;
      continue;
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
        const nested = extractModuleLoadEvidence(loaded.expression, {
          filename,
        });
        stringValues.push(...nested.stringValues);
        dynamicImports.push(Object.freeze({
          expression: loaded.expression,
          fingerprint: sha256(loaded.expression),
          literal,
        }));
        dynamicImports.push(...nested.dynamicImports);
        index = loaded.end;
        continue;
      }
    }
    index += 1;
  }
  return Object.freeze({
    dynamicImports: Object.freeze(dynamicImports),
    stringValues: Object.freeze(stringValues),
  });
}
