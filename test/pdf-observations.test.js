import { PDFDocument, PDFName, PDFNumber, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  buildAnnotationObservation,
  buildDocumentObservation,
  buildFormFieldObservation,
  buildMetadataObservation,
  buildPageObservation,
  pageGeometryFromPdfLib,
  publicPdfObservationError,
  validatePdfObservationSemantics,
} from "../server/pdf-observations.js";

const SOURCE_SHA256 = "a".repeat(64);
const SOURCE = {
  canonical_path: "/allowed/synthetic.pdf",
  file_name: "synthetic.pdf",
  size_bytes: 123,
  sha256: SOURCE_SHA256,
};

function emptyMetadata() {
  return buildMetadataObservation(SOURCE_SHA256, {}, {}, 32_768);
}

describe("source-bound PDF observation primitives", () => {
  it("preserves MediaBox, CropBox, rotation, and UserUnit geometry", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([400, 600]);
    page.setMediaBox(10, 20, 400, 600);
    page.setCropBox(30, 40, 300, 500);
    page.setRotation(degrees(90));
    page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));

    expect(pageGeometryFromPdfLib(page)).toEqual({
      geometry_source: "pdf-lib",
      media_box: [10, 20, 410, 620],
      crop_box: [30, 40, 330, 540],
      width_points: 400,
      height_points: 600,
      rotation: 90,
      user_unit: 2,
      coordinate_space: "pdf_user_space_bottom_left_points",
    });
  });

  it("reports fully unavailable channels without upgrading them to partial", () => {
    const result = buildDocumentObservation({
      source: SOURCE,
      totalPages: 1,
      pageItems: [],
      pageTruncated: false,
      metadata: emptyMetadata(),
      formFields: [],
      fieldsTruncated: false,
      annotations: [],
      annotationsTruncated: false,
      coverageReasons: {
        pages: ["PAGE_PARSE_UNAVAILABLE"],
        metadata: ["METADATA_PARSE_UNAVAILABLE"],
        form_fields: ["FORM_FIELD_PARSE_UNAVAILABLE"],
        annotations: ["ANNOTATION_PARSE_UNAVAILABLE"],
      },
      maxPages: 1,
      maxOutputCharacters: 20_000,
    });

    expect(Object.values(result.coverage).map(channel => channel.status))
      .toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
    expect(result.status).toBe("partial");
    expect(validatePdfObservationSemantics(result)).toBe(result);
  });

  it("drops complete observation records to honor the serialized output cap", () => {
    const geometry = {
      geometry_source: "pdf-lib",
      media_box: [0, 0, 612, 792],
      crop_box: [0, 0, 612, 792],
      width_points: 612,
      height_points: 792,
      rotation: 0,
      user_unit: 1,
      coordinate_space: "pdf_user_space_bottom_left_points",
    };
    const viewport = { convertToViewportRectangle: rect => rect };
    const annotations = Array.from({ length: 80 }, (_, index) => buildAnnotationObservation({
      sourceSha256: SOURCE_SHA256,
      annotation: {
        subtype: "Text",
        contents: `annotation-${index}-${"x".repeat(800)}`,
        rect: [10, 10, 20, 20],
        url: `https://invalid.example/${index}`,
      },
      page: 1,
      viewport,
      ordinal: index + 1,
    }));
    const result = buildDocumentObservation({
      source: SOURCE,
      totalPages: 1,
      pageItems: [buildPageObservation(SOURCE_SHA256, 1, geometry)],
      pageTruncated: false,
      metadata: emptyMetadata(),
      formFields: [],
      fieldsTruncated: false,
      annotations,
      annotationsTruncated: false,
      coverageReasons: {},
      maxPages: 1,
      maxOutputCharacters: 20_000,
    });

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
    expect(result.annotations.observed_count).toBeLessThan(annotations.length);
    expect(result.annotations.items).toHaveLength(result.annotations.observed_count);
    expect(result.annotations.truncated).toBe(true);
    expect(result.coverage.annotations.reason_codes)
      .toContain("OUTPUT_LIMIT_ANNOTATIONS_OMITTED");
    expect(validatePdfObservationSemantics(result)).toBe(result);
  });

  it("records metadata disagreement by digest without choosing a winner", () => {
    const metadata = buildMetadataObservation(
      SOURCE_SHA256,
      { Title: "Info title" },
      { "dc:title": "XMP title" },
      32_768,
    );
    expect(metadata.disagreements).toEqual([
      expect.objectContaining({ property: "title" }),
    ]);
    expect(metadata.info.values.Title).toBe("Info title");
    expect(metadata.xmp.values["dc:title"]).toBe("XMP title");
  });

  it("charges long, numerous, escaped, control, and nested metadata against the full cap", () => {
    const longKeySentinel = `INTERNAL-METADATA-KEY-${"k".repeat(40_000)}`;
    const manyInfoEntries = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
      `key-${index}-\\\"\n\u0000`,
      { nested: { index, text: `${"v".repeat(200)}\n\t\\\"` } },
    ]));
    manyInfoEntries[longKeySentinel] = "must not escape through omitted-key reporting";
    const metadata = buildMetadataObservation(
      SOURCE_SHA256,
      manyInfoEntries,
      { "dc:title": { deeply: { nested: Array.from({ length: 200 }, () => "value") } } },
      32_768,
    );

    expect(JSON.stringify(metadata).length).toBeLessThanOrEqual(32_768);
    expect(JSON.stringify(metadata)).not.toContain(longKeySentinel);
    expect(metadata.info.omitted_key_count).toBeGreaterThan(0);
    expect(metadata.info.omitted_keys.every(key => /^sha256:[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(metadata.info.truncated).toBe(true);

    const boundedDocument = buildDocumentObservation({
      source: SOURCE,
      totalPages: 1,
      pageItems: [],
      pageTruncated: true,
      pageLimitReached: false,
      metadata,
      formFields: [],
      fieldsTruncated: false,
      annotations: [],
      annotationsTruncated: false,
      coverageReasons: { pages: ["PAGE_PARSE_UNAVAILABLE"] },
      maxPages: 1,
      maxOutputCharacters: 20_000,
    });
    expect(JSON.stringify(boundedDocument).length).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(boundedDocument.metadata).length).toBeLessThanOrEqual(32_768);
    expect(validatePdfObservationSemantics(boundedDocument)).toBe(boundedDocument);
  });

  it("keeps element IDs stable when bounded scopes change surrounding ordinals", () => {
    const viewport = { convertToViewportRectangle: rect => rect };
    const annotation = { id: "19R", subtype: "Text", rect: [1, 2, 3, 4] };
    const firstAnnotation = buildAnnotationObservation({
      sourceSha256: SOURCE_SHA256,
      annotation,
      page: 1,
      viewport,
      ordinal: 1,
    });
    const laterAnnotation = buildAnnotationObservation({
      sourceSha256: SOURCE_SHA256,
      annotation,
      page: 1,
      viewport,
      ordinal: 12,
    });
    expect(firstAnnotation.id).toBe(laterAnnotation.id);

    const field = { id: "20R", name: "Approval", type: "text", page: 0 };
    const firstField = buildFormFieldObservation({
      sourceSha256: SOURCE_SHA256,
      field,
      widget: field,
      viewport,
      ordinal: 1,
    });
    const laterField = buildFormFieldObservation({
      sourceSha256: SOURCE_SHA256,
      field,
      widget: field,
      viewport,
      ordinal: 9,
    });
    expect(firstField.id).toBe(laterField.id);
  });

  it("maps lower-level failures to stable public messages without carrying sentinels", () => {
    const sentinel = "INTERNAL-PATH-AND-PASSWORD-SENTINEL";
    const cases = [
      [{ code: "PASSWORD_REQUIRED", message: sentinel }, "PASSWORD_REQUIRED"],
      [{ code: "PASSWORD_INCORRECT", message: sentinel }, "PASSWORD_INCORRECT"],
      [{ code: "PDF_CHANGED_DURING_READ", message: sentinel }, "PDF_CHANGED_DURING_READ"],
      [{ code: "ENOENT", message: sentinel }, "PDF_UNAVAILABLE"],
      [{ code: "path_policy_denied", message: sentinel }, "path_policy_denied"],
      [{ code: "unknown", message: sentinel }, "tool_execution_failed"],
    ];
    for (const [error, expectedCode] of cases) {
      const mapped = publicPdfObservationError(error);
      expect(mapped.code).toBe(expectedCode);
      expect(JSON.stringify(mapped)).not.toContain(sentinel);
    }
  });
});
