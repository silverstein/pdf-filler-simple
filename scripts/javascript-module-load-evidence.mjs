import { createHash } from "node:crypto";
import path from "node:path";
import { parseAst } from "rolldown/parseAst";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parserLanguage(filename) {
  const basename = path.basename(filename).toLowerCase();
  if (basename.endsWith(".d.ts")) return "dts";
  const extension = path.extname(basename);
  if (extension === ".jsx") return "jsx";
  if (extension === ".tsx") return "tsx";
  if (new Set([".cts", ".mts", ".ts"]).has(extension)) return "ts";
  return "js";
}

function staticStringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral"
    && node.expressions?.length === 0
    && node.quasis?.length === 1
  ) {
    const value = node.quasis[0]?.value?.cooked;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function isImportMetaUrl(node) {
  return (
    node?.type === "MemberExpression"
    && node.computed === false
    && node.property?.type === "Identifier"
    && node.property.name === "url"
    && node.object?.type === "MetaProperty"
    && node.object.meta?.type === "Identifier"
    && node.object.meta.name === "import"
    && node.object.property?.type === "Identifier"
    && node.object.property.name === "meta"
  );
}

function boundedNodeSpan(node, source, filename) {
  if (
    !Number.isSafeInteger(node?.start)
    || !Number.isSafeInteger(node?.end)
    || node.start < 0
    || node.end < node.start
    || node.end > source.length
  ) {
    throw new Error(`${filename}: parser returned an invalid source span`);
  }
  return { end: node.end, start: node.start };
}

function importExpression(node, source, filename) {
  const nodeSpan = boundedNodeSpan(node, source, filename);
  const sourceSpan = boundedNodeSpan(node.source, source, filename);
  if (source[nodeSpan.end - 1] !== ")" || sourceSpan.start >= nodeSpan.end - 1) {
    throw new Error(`${filename}: parser returned an invalid import expression`);
  }
  return source.slice(sourceSpan.start, nodeSpan.end - 1).trim();
}

function argumentExpression(node, source, filename) {
  const [firstArgument, secondArgument] = node.arguments;
  const firstSpan = boundedNodeSpan(firstArgument, source, filename);
  const secondSpan = boundedNodeSpan(secondArgument, source, filename);
  if (firstSpan.start >= secondSpan.end) {
    throw new Error(`${filename}: parser returned invalid argument spans`);
  }
  return source.slice(firstSpan.start, secondSpan.end).trim();
}

function walkAst(value, visit) {
  if (!value || typeof value !== "object") return;
  if (typeof value.type === "string") visit(value);
  if (Array.isArray(value)) {
    for (const child of value) walkAst(child, visit);
    return;
  }
  for (const child of Object.values(value)) {
    walkAst(child, visit);
  }
}

export function extractModuleLoadEvidence(
  source,
  {
    filename = "source.mjs",
    sourceOffset = 0,
  } = {},
) {
  if (typeof source !== "string") {
    throw new TypeError("module-load evidence source must be a string");
  }
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
    throw new TypeError("module-load evidence sourceOffset must be a nonnegative integer");
  }

  const program = parseAst(source, {
    lang: parserLanguage(filename),
    preserveParens: true,
    sourceType: "unambiguous",
  }, filename);
  const dynamicImports = [];
  const newUrlReferences = [];
  const stringLiterals = [];

  walkAst(program, node => {
    const literal = staticStringValue(node);
    if (literal !== null) {
      const { end, start } = boundedNodeSpan(node, source, filename);
      stringLiterals.push(Object.freeze({
        end: sourceOffset + end,
        start: sourceOffset + start,
        value: literal,
      }));
    }

    if (node.type === "ImportExpression") {
      const { end, start } = boundedNodeSpan(node, source, filename);
      const expression = importExpression(node, source, filename);
      dynamicImports.push(Object.freeze({
        end: sourceOffset + end,
        expression,
        fingerprint: sha256(expression),
        kind: "dynamic-import",
        literal: staticStringValue(node.source),
        start: sourceOffset + start,
      }));
    }

    if (
      node.type === "NewExpression"
      && node.callee?.type === "Identifier"
      && node.callee.name === "URL"
      && node.arguments?.length === 2
      && isImportMetaUrl(node.arguments[1])
    ) {
      const reference = node.arguments[0];
      const referenceLiteral = staticStringValue(reference);
      if (referenceLiteral !== null) {
        const { end, start } = boundedNodeSpan(node, source, filename);
        const referenceSpan = boundedNodeSpan(reference, source, filename);
        newUrlReferences.push(Object.freeze({
          end: sourceOffset + end,
          expression: argumentExpression(node, source, filename),
          kind: "new-url-import-meta",
          literal: referenceLiteral,
          referenceEnd: sourceOffset + referenceSpan.end,
          referenceStart: sourceOffset + referenceSpan.start,
          start: sourceOffset + start,
        }));
      }
    }
  });

  stringLiterals.sort((left, right) => left.start - right.start);
  dynamicImports.sort((left, right) => left.start - right.start);
  newUrlReferences.sort((left, right) => left.start - right.start);
  return Object.freeze({
    dynamicImports: Object.freeze(dynamicImports),
    newUrlReferences: Object.freeze(newUrlReferences),
    stringLiterals: Object.freeze(stringLiterals),
    stringValues: Object.freeze(stringLiterals.map(entry => entry.value)),
  });
}
