import Ajv2020 from "ajv/dist/2020.js";

export function createComparisonAjv(options = {}) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, ...options });
  ajv.addKeyword({
    keyword: "pdfToolsWithinPageBox",
    schemaType: "array",
    type: "array",
    metaSchema: {
      type: "array",
      prefixItems: [
        { type: "number", exclusiveMinimum: 0 },
        { type: "number", exclusiveMinimum: 0 },
      ],
      minItems: 2,
      maxItems: 2,
    },
    validate([pageWidth, pageHeight], value) {
      return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
        && value[0] >= 0 && value[1] >= 0 && value[2] > 0 && value[3] > 0
        && value[0] + value[2] <= pageWidth && value[1] + value[3] <= pageHeight;
    },
  });
  return ajv;
}
