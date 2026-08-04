import { createHash } from "node:crypto";
import { PDFName, PDFNumber } from "pdf-lib";

export const PDF_OBSERVATION_SCHEMA_VERSION = "1.0";
export const PDF_OBSERVATION_PARSER = Object.freeze({
  name: "pdfjs-dist",
  version: "5.4.624",
});
export const PDF_OBSERVATION_LIMITS = Object.freeze({
  max_annotations: 500,
  max_fields: 500,
  max_metadata_characters: 32_768,
});

const OBSERVATION_COORDINATE_SPACES = Object.freeze({
  display: "pdfjs_viewport_top_left_points",
  native: "pdf_user_space_bottom_left_points",
  requested: "pdf_tools_top_left_media_box_points",
  raster: "raster_top_left_pixels",
});

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(6))
    : null;
}

export function canonicalizeObservationValue(value, depth = 0) {
  if (depth > 8) return "[depth-limited]";
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return finiteNumber(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) {
    return Array.from(value, item => canonicalizeObservationValue(item, depth + 1));
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeObservationValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value ?? "");
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodePoints)
      .filter(key => value[key] !== undefined && typeof value[key] !== "function")
      .map(key => [key, canonicalizeObservationValue(value[key], depth + 1)]),
  );
}

export function canonicalObservationJson(value) {
  return JSON.stringify(canonicalizeObservationValue(value));
}

export function observationSha256(value) {
  return createHash("sha256").update(canonicalObservationJson(value), "utf8").digest("hex");
}

function stableObservationId(sourceSha256, channel, identity, observedValues) {
  return `${channel}-${observationSha256({
    channel,
    identity,
    observed_values: observedValues,
    source_sha256: sourceSha256,
  })}`;
}

function pdfBox(box, fallback) {
  const source = box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    ? box
    : fallback;
  const x = finiteNumber(source?.x) ?? 0;
  const y = finiteNumber(source?.y) ?? 0;
  const width = finiteNumber(source?.width) ?? 0;
  const height = finiteNumber(source?.height) ?? 0;
  return [x, y, finiteNumber(x + width), finiteNumber(y + height)];
}

function pdfUserUnit(pdfPage) {
  try {
    const value = pdfPage.doc.context.lookupMaybe(
      pdfPage.node.get(PDFName.of("UserUnit")),
      PDFNumber,
    );
    const userUnit = value?.asNumber?.();
    return Number.isFinite(userUnit) && userUnit > 0 ? finiteNumber(userUnit) : 1;
  } catch {
    return 1;
  }
}

export function pageGeometryFromPdfLib(pdfPage) {
  const size = pdfPage.getSize();
  let media = null;
  let crop = null;
  try { media = pdfPage.getMediaBox(); } catch {}
  try { crop = pdfPage.getCropBox(); } catch {}
  const fallback = { x: 0, y: 0, width: size.width, height: size.height };
  const mediaBox = pdfBox(media, fallback);
  const cropBox = pdfBox(crop, media ?? fallback);
  const rotation = finiteNumber(pdfPage.getRotation()?.angle) ?? 0;
  return {
    media_box: mediaBox,
    crop_box: cropBox,
    width_points: finiteNumber(mediaBox[2] - mediaBox[0]),
    height_points: finiteNumber(mediaBox[3] - mediaBox[1]),
    rotation,
    user_unit: pdfUserUnit(pdfPage),
    coordinate_space: OBSERVATION_COORDINATE_SPACES.requested,
  };
}

export function displayRegionFromPdfjsRect(rect, viewport) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  let converted;
  try {
    converted = viewport.convertToViewportRectangle(rect);
  } catch {
    return null;
  }
  if (!Array.isArray(converted) || converted.length !== 4 || !converted.every(Number.isFinite)) {
    return null;
  }
  const left = Math.min(converted[0], converted[2]);
  const top = Math.min(converted[1], converted[3]);
  const right = Math.max(converted[0], converted[2]);
  const bottom = Math.max(converted[1], converted[3]);
  return {
    x: finiteNumber(left),
    y: finiteNumber(top),
    width: finiteNumber(right - left),
    height: finiteNumber(bottom - top),
  };
}

function nativeRegion(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  return {
    x1: finiteNumber(Math.min(rect[0], rect[2])),
    y1: finiteNumber(Math.min(rect[1], rect[3])),
    x2: finiteNumber(Math.max(rect[0], rect[2])),
    y2: finiteNumber(Math.max(rect[1], rect[3])),
  };
}

function boundedValue(value, maximumCharacters = 16_384) {
  const normalized = canonicalizeObservationValue(value);
  const encoded = canonicalObservationJson(normalized);
  if (encoded.length <= maximumCharacters) return { value: normalized, truncated: false };
  if (typeof normalized === "string") {
    return { value: normalized.slice(0, Math.max(0, maximumCharacters - 2)), truncated: true };
  }
  return { value: null, truncated: true };
}

function metadataAlias(key) {
  const aliases = {
    Author: "author",
    CreationDate: "creation_date",
    Creator: "creator",
    Keywords: "keywords",
    ModDate: "modification_date",
    Producer: "producer",
    Subject: "subject",
    Title: "title",
    "dc:creator": "author",
    "dc:description": "subject",
    "dc:subject": "keywords",
    "dc:title": "title",
    "pdf:Producer": "producer",
    "xmp:CreateDate": "creation_date",
    "xmp:CreatorTool": "creator",
    "xmp:ModifyDate": "modification_date",
  };
  return aliases[key] ?? null;
}

function boundedMetadataRecord(record, maximumCharacters) {
  const output = {};
  const omittedKeys = [];
  let used = 2;
  for (const key of Object.keys(record ?? {}).sort(compareCodePoints)) {
    const normalized = boundedValue(record[key], Math.min(maximumCharacters, 16_384));
    const entryCharacters = canonicalObservationJson({ [key]: normalized.value }).length;
    if (used + entryCharacters > maximumCharacters) {
      omittedKeys.push(key);
      continue;
    }
    output[key] = normalized.value;
    used += entryCharacters;
    if (normalized.truncated) omittedKeys.push(key);
  }
  return { values: output, omitted_keys: omittedKeys, truncated: omittedKeys.length > 0 };
}

export function buildMetadataObservation(sourceSha256, info, xmp, maximumCharacters) {
  const half = Math.floor(maximumCharacters / 2);
  const boundedInfo = boundedMetadataRecord(info, half);
  const boundedXmp = boundedMetadataRecord(xmp, maximumCharacters - half);
  const infoAliases = new Map();
  const xmpAliases = new Map();
  for (const [key, value] of Object.entries(boundedInfo.values)) {
    const alias = metadataAlias(key);
    if (alias) infoAliases.set(alias, value);
  }
  for (const [key, value] of Object.entries(boundedXmp.values)) {
    const alias = metadataAlias(key);
    if (alias) xmpAliases.set(alias, value);
  }
  const disagreements = [...infoAliases.keys()]
    .filter(key => xmpAliases.has(key)
      && canonicalObservationJson(infoAliases.get(key)) !== canonicalObservationJson(xmpAliases.get(key)))
    .sort(compareCodePoints)
    .map(property => ({
      property,
      info_value_sha256: observationSha256(infoAliases.get(property)),
      xmp_value_sha256: observationSha256(xmpAliases.get(property)),
    }));
  const observed = {
    info: boundedInfo,
    xmp: boundedXmp,
    disagreements,
  };
  return {
    ...observed,
    observation_sha256: stableObservationId(sourceSha256, "metadata", "document", observed)
      .slice("metadata-".length),
  };
}

function normalizedFieldType(field) {
  if (typeof field?.type === "string" && field.type.length > 0) return field.type;
  if (field?.fieldType === "Tx") return "text";
  if (field?.fieldType === "Sig") return "signature";
  if (field?.fieldType === "Ch") return field.combo ? "combobox" : "listbox";
  if (field?.fieldType === "Btn") {
    if (field.radioButton) return "radio";
    if (field.checkBox) return "checkbox";
    return "button";
  }
  return "unknown";
}

function fieldOptions(field) {
  const raw = field?.items ?? field?.exportValues ?? field?.exportValue ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(value => canonicalizeObservationValue(value));
}

export function buildFormFieldObservation({ sourceSha256, field, widget, viewport, ordinal }) {
  const page = Number.isInteger(widget?.page) && widget.page >= 0
    ? widget.page + 1
    : Number.isInteger(field?.page) && field.page >= 0
      ? field.page + 1
      : null;
  const rect = widget?.rect ?? field?.rect ?? null;
  const observed = {
    source_object_id: typeof (widget?.id ?? field?.id) === "string"
      ? String(widget?.id ?? field?.id).slice(0, 4096)
      : null,
    name: String(field?.name ?? widget?.fieldName ?? ""),
    type: normalizedFieldType({ ...field, ...widget }),
    value: canonicalizeObservationValue(widget?.fieldValue ?? field?.value ?? null),
    default_value: canonicalizeObservationValue(
      widget?.defaultFieldValue ?? field?.defaultValue ?? null,
    ),
    flags: Number.isSafeInteger(widget?.fieldFlags) ? widget.fieldFlags : 0,
    options: fieldOptions({ ...field, ...widget }),
    widget_page: page,
    widget_native_region: nativeRegion(rect),
    widget_display_region: displayRegionFromPdfjsRect(rect, viewport),
    appearance_state: canonicalizeObservationValue(
      widget?.appearanceState ?? widget?.fieldValue ?? null,
    ),
    rotation: finiteNumber(widget?.rotation ?? field?.rotation) ?? 0,
  };
  const identity = observed.source_object_id === null
    ? { fallback_ordinal: ordinal, name: observed.name, page }
    : { page, source_object_id: observed.source_object_id };
  const id = stableObservationId(sourceSha256, "field", identity, observed);
  return {
    id,
    ...observed,
    value_sha256: observationSha256(observed.value),
    observation_sha256: id.slice("field-".length),
  };
}

function annotationContents(annotation) {
  if (typeof annotation?.contentsObj?.str === "string") return annotation.contentsObj.str;
  return typeof annotation?.contents === "string" ? annotation.contents : "";
}

function inertAnnotationTarget(annotation) {
  if (typeof annotation?.url === "string") return { kind: "external_url", value: annotation.url };
  if (typeof annotation?.unsafeUrl === "string") {
    return { kind: "external_url", value: annotation.unsafeUrl };
  }
  if (annotation?.dest !== undefined && annotation.dest !== null) {
    return { kind: "internal_destination", value: canonicalizeObservationValue(annotation.dest) };
  }
  if (annotation?.action !== undefined && annotation.action !== null) {
    return { kind: "action", value: canonicalizeObservationValue(annotation.action) };
  }
  return { kind: "none", value: null };
}

export function buildAnnotationObservation({
  sourceSha256,
  annotation,
  page,
  viewport,
  ordinal,
}) {
  const target = inertAnnotationTarget(annotation);
  const observed = {
    source_object_id: typeof annotation?.id === "string"
      ? annotation.id.slice(0, 4096)
      : null,
    page,
    subtype: String(annotation?.subtype ?? "Unknown"),
    contents: annotationContents(annotation),
    flags: Number.isSafeInteger(annotation?.annotationFlags) ? annotation.annotationFlags : 0,
    native_region: nativeRegion(annotation?.rect),
    display_region: displayRegionFromPdfjsRect(annotation?.rect, viewport),
    quad_points: canonicalizeObservationValue(annotation?.quadPoints ?? []),
    target_kind: target.kind,
    target_value: target.value,
  };
  const id = stableObservationId(
    sourceSha256,
    "annotation",
    observed.source_object_id === null
      ? { fallback_ordinal: ordinal, page, subtype: observed.subtype }
      : { page, source_object_id: observed.source_object_id, subtype: observed.subtype },
    observed,
  );
  return { id, ...observed, observation_sha256: id.slice("annotation-".length) };
}

function coverageState(status = "supported", reasonCodes = []) {
  return { status, reason_codes: [...new Set(reasonCodes)].sort(compareCodePoints) };
}

function coverageStatus(channel, reasonCodes) {
  const unavailableReasons = new Set({
    annotations: ["ANNOTATION_PARSE_UNAVAILABLE"],
    form_fields: ["FORM_FIELD_PARSE_UNAVAILABLE"],
    metadata: ["METADATA_PARSE_UNAVAILABLE"],
    pages: ["PAGE_PARSE_UNAVAILABLE"],
  }[channel] ?? []);
  if (reasonCodes.some(reason => unavailableReasons.has(reason))) return "unavailable";
  return reasonCodes.length > 0 ? "partial" : "supported";
}

function markPartial(result, channel, reason) {
  result.coverage[channel] = coverageState(
    result.coverage[channel].status === "unavailable" ? "unavailable" : "partial",
    [
    ...result.coverage[channel].reason_codes,
    reason,
    ],
  );
  result.status = "partial";
  if (!result.limitations.includes(reason)) result.limitations.push(reason);
}

function serializedCharacters(value) {
  return JSON.stringify(value).length;
}

export function applyObservationOutputLimit(result, maximumCharacters) {
  const bounded = structuredClone(result);
  const collections = [
    ["annotations", "annotations", "OUTPUT_LIMIT_ANNOTATIONS_OMITTED"],
    ["form_fields", "form_fields", "OUTPUT_LIMIT_FORM_FIELDS_OMITTED"],
    ["pages", "pages", "OUTPUT_LIMIT_PAGES_OMITTED"],
  ];
  for (const [property, channel, reason] of collections) {
    while (serializedCharacters(bounded) > maximumCharacters && bounded[property].items.length > 0) {
      bounded[property].items.pop();
      bounded[property].observed_count = bounded[property].items.length;
      bounded[property].truncated = true;
      markPartial(bounded, channel, reason);
    }
  }
  if (serializedCharacters(bounded) > maximumCharacters) {
    bounded.metadata.info = { values: {}, omitted_keys: ["*"], truncated: true };
    bounded.metadata.xmp = { values: {}, omitted_keys: ["*"], truncated: true };
    bounded.metadata.disagreements = [];
    const metadataWithoutDigest = {
      info: bounded.metadata.info,
      xmp: bounded.metadata.xmp,
      disagreements: bounded.metadata.disagreements,
    };
    bounded.metadata.observation_sha256 = stableObservationId(
      bounded.source.sha256,
      "metadata",
      "document",
      metadataWithoutDigest,
    ).slice("metadata-".length);
    markPartial(bounded, "metadata", "OUTPUT_LIMIT_METADATA_OMITTED");
  }
  bounded.limitations.sort(compareCodePoints);
  if (serializedCharacters(bounded) > maximumCharacters) {
    throw new Error("The bounded PDF observation envelope exceeds max_output_characters.");
  }
  return bounded;
}

export function buildDocumentObservation({
  source,
  totalPages,
  pageItems,
  pageTruncated,
  metadata,
  formFields,
  fieldsTruncated,
  fieldsLimitReached = fieldsTruncated,
  annotations,
  annotationsTruncated,
  annotationsLimitReached = annotationsTruncated,
  coverageReasons = {},
  maxPages,
  maxOutputCharacters,
}) {
  const pageReasons = [...(coverageReasons.pages ?? [])];
  const metadataReasons = [...(coverageReasons.metadata ?? [])];
  const fieldReasons = [...(coverageReasons.form_fields ?? [])];
  const annotationReasons = [...(coverageReasons.annotations ?? [])];
  if (pageTruncated) pageReasons.push("PAGE_LIMIT_REACHED");
  if (metadata.info.truncated || metadata.xmp.truncated) metadataReasons.push("METADATA_LIMIT_REACHED");
  if (fieldsLimitReached) fieldReasons.push("FIELD_LIMIT_REACHED");
  if (annotationsLimitReached) annotationReasons.push("ANNOTATION_LIMIT_REACHED");
  const coverage = {
    pages: coverageState(coverageStatus("pages", pageReasons), pageReasons),
    metadata: coverageState(coverageStatus("metadata", metadataReasons), metadataReasons),
    form_fields: coverageState(coverageStatus("form_fields", fieldReasons), fieldReasons),
    annotations: coverageState(coverageStatus("annotations", annotationReasons), annotationReasons),
  };
  const limitations = Object.values(coverage).flatMap(channel => channel.reason_codes);
  const result = {
    schema_version: PDF_OBSERVATION_SCHEMA_VERSION,
    status: limitations.length === 0 ? "complete" : "partial",
    source: {
      canonical_path: source.canonical_path,
      file_name: source.file_name,
      size_bytes: source.size_bytes,
      sha256: source.sha256,
      identity_method: "race_aware_descriptor_sha256",
    },
    parser: PDF_OBSERVATION_PARSER,
    coverage,
    limits: {
      max_pages: maxPages,
      max_fields: PDF_OBSERVATION_LIMITS.max_fields,
      max_annotations: PDF_OBSERVATION_LIMITS.max_annotations,
      max_metadata_characters: PDF_OBSERVATION_LIMITS.max_metadata_characters,
      max_output_characters: maxOutputCharacters,
    },
    pages: {
      total_count: totalPages,
      observed_count: pageItems.length,
      truncated: pageTruncated,
      items: pageItems,
    },
    metadata,
    form_fields: {
      observed_count: formFields.length,
      truncated: fieldsTruncated,
      items: formFields,
    },
    annotations: {
      observed_count: annotations.length,
      truncated: annotationsTruncated,
      items: annotations,
    },
    limitations: [...new Set(limitations)].sort(compareCodePoints),
  };
  return applyObservationOutputLimit(result, maxOutputCharacters);
}

export function buildPageObservation(sourceSha256, page, geometry) {
  const observed = { page, ...geometry };
  const id = stableObservationId(sourceSha256, "page", { page }, observed);
  return { ...observed, observation_sha256: id.slice("page-".length) };
}

export function buildRenderObservation({
  existing,
  source,
  geometry,
  page,
  requestedRegion,
  renderedRegion,
  rendererPolicy,
  pngSha256,
  rawPixelSha256,
  rawPixelStatus,
}) {
  const observed = {
    observation_schema_version: PDF_OBSERVATION_SCHEMA_VERSION,
    source: {
      canonical_path: source.canonical_path,
      file_name: source.file_name,
      size_bytes: source.size_bytes,
      sha256: source.sha256,
    },
    page_geometry: geometry,
    requested_coordinate_space: OBSERVATION_COORDINATE_SPACES.requested,
    rendered_coordinate_space: OBSERVATION_COORDINATE_SPACES.raster,
    requested_region: requestedRegion,
    rendered_region: renderedRegion,
    renderer_policy: rendererPolicy,
    png_sha256: pngSha256,
    raw_pixel_sha256: rawPixelSha256,
    raw_pixel_status: rawPixelStatus,
  };
  return {
    ...existing,
    ...observed,
    observation_sha256: observationSha256({
      source_sha256: source.sha256,
      channel: "render",
      page,
      observed,
    }),
  };
}

function semanticAssertion(condition, message) {
  if (!condition) throw new Error(`PDF observation semantic validation failed: ${message}.`);
}

function observedField(field) {
  return {
    source_object_id: field.source_object_id,
    name: field.name,
    type: field.type,
    value: field.value,
    default_value: field.default_value,
    flags: field.flags,
    options: field.options,
    widget_page: field.widget_page,
    widget_native_region: field.widget_native_region,
    widget_display_region: field.widget_display_region,
    appearance_state: field.appearance_state,
    rotation: field.rotation,
  };
}

function observedAnnotation(annotation) {
  return {
    source_object_id: annotation.source_object_id,
    page: annotation.page,
    subtype: annotation.subtype,
    contents: annotation.contents,
    flags: annotation.flags,
    native_region: annotation.native_region,
    display_region: annotation.display_region,
    quad_points: annotation.quad_points,
    target_kind: annotation.target_kind,
    target_value: annotation.target_value,
  };
}

export function validatePdfObservationSemantics(payload) {
  semanticAssertion(payload.pages.observed_count === payload.pages.items.length,
    "page observation count mismatch");
  semanticAssertion(payload.form_fields.observed_count === payload.form_fields.items.length,
    "form field observation count mismatch");
  semanticAssertion(payload.annotations.observed_count === payload.annotations.items.length,
    "annotation observation count mismatch");
  semanticAssertion(payload.pages.observed_count <= payload.limits.max_pages,
    "page observation limit exceeded");
  semanticAssertion(payload.form_fields.observed_count <= payload.limits.max_fields,
    "form field observation limit exceeded");
  semanticAssertion(payload.annotations.observed_count <= payload.limits.max_annotations,
    "annotation observation limit exceeded");
  semanticAssertion(serializedCharacters(payload) <= payload.limits.max_output_characters,
    "output character limit exceeded");
  const limitations = [...new Set(Object.values(payload.coverage)
    .flatMap(channel => channel.reason_codes))].sort(compareCodePoints);
  semanticAssertion(canonicalObservationJson(limitations)
    === canonicalObservationJson(payload.limitations), "limitation coverage mismatch");
  semanticAssertion(payload.status === (limitations.length === 0 ? "complete" : "partial"),
    "document status mismatch");

  const pageNumbers = new Set();
  for (const page of payload.pages.items) {
    semanticAssertion(!pageNumbers.has(page.page), `duplicate page ${page.page}`);
    pageNumbers.add(page.page);
    const observed = {
      page: page.page,
      media_box: page.media_box,
      crop_box: page.crop_box,
      width_points: page.width_points,
      height_points: page.height_points,
      rotation: page.rotation,
      user_unit: page.user_unit,
      coordinate_space: page.coordinate_space,
    };
    const expected = stableObservationId(
      payload.source.sha256,
      "page",
      { page: page.page },
      observed,
    ).slice("page-".length);
    semanticAssertion(page.observation_sha256 === expected,
      `page ${page.page} digest mismatch`);
  }

  const metadataWithoutDigest = {
    info: payload.metadata.info,
    xmp: payload.metadata.xmp,
    disagreements: payload.metadata.disagreements,
  };
  const metadataDigest = stableObservationId(
    payload.source.sha256,
    "metadata",
    "document",
    metadataWithoutDigest,
  ).slice("metadata-".length);
  semanticAssertion(payload.metadata.observation_sha256 === metadataDigest,
    "metadata digest mismatch");

  const fieldIds = new Set();
  for (let index = 0; index < payload.form_fields.items.length; index += 1) {
    const field = payload.form_fields.items[index];
    semanticAssertion(!fieldIds.has(field.id), `duplicate form field ID ${field.id}`);
    fieldIds.add(field.id);
    const observed = observedField(field);
    const expectedId = stableObservationId(
      payload.source.sha256,
      "field",
      field.source_object_id === null
        ? { fallback_ordinal: index + 1, name: field.name, page: field.widget_page }
        : { page: field.widget_page, source_object_id: field.source_object_id },
      observed,
    );
    semanticAssertion(field.id === expectedId, `form field ${field.id} ID mismatch`);
    semanticAssertion(field.observation_sha256 === expectedId.slice("field-".length),
      `form field ${field.id} digest mismatch`);
    semanticAssertion(field.value_sha256 === observationSha256(field.value),
      `form field ${field.id} value digest mismatch`);
  }

  const annotationIds = new Set();
  for (let index = 0; index < payload.annotations.items.length; index += 1) {
    const annotation = payload.annotations.items[index];
    semanticAssertion(annotation.subtype !== "Widget",
      `widget ${annotation.id} leaked into ordinary annotations`);
    semanticAssertion(!annotationIds.has(annotation.id),
      `duplicate annotation ID ${annotation.id}`);
    annotationIds.add(annotation.id);
    const observed = observedAnnotation(annotation);
    const expectedId = stableObservationId(
      payload.source.sha256,
      "annotation",
      annotation.source_object_id === null
        ? { fallback_ordinal: index + 1, page: annotation.page, subtype: annotation.subtype }
        : {
            page: annotation.page,
            source_object_id: annotation.source_object_id,
            subtype: annotation.subtype,
          },
      observed,
    );
    semanticAssertion(annotation.id === expectedId,
      `annotation ${annotation.id} ID mismatch`);
    semanticAssertion(annotation.observation_sha256 === expectedId.slice("annotation-".length),
      `annotation ${annotation.id} digest mismatch`);
  }
  return payload;
}

export function validateRenderObservationSemantics(payload) {
  semanticAssertion(payload.source.file_name === payload.file_name,
    "render source file name mismatch");
  semanticAssertion(payload.raw_pixel_status === "available"
    ? payload.raw_pixel_sha256 !== null
    : payload.raw_pixel_sha256 === null, "raw pixel status mismatch");
  semanticAssertion(payload.requested_region.x === payload.region_points?.x
    || payload.region_points === undefined, "requested region x mismatch");
  semanticAssertion(payload.requested_region.y === payload.region_points?.y
    || payload.region_points === undefined, "requested region y mismatch");
  semanticAssertion(payload.requested_region.width === payload.region_points?.width
    || payload.region_points === undefined, "requested region width mismatch");
  semanticAssertion(payload.requested_region.height === payload.region_points?.height
    || payload.region_points === undefined, "requested region height mismatch");
  semanticAssertion(payload.rendered_region.width === payload.rendered_width_px,
    "rendered region width mismatch");
  semanticAssertion(payload.rendered_region.height === payload.rendered_height_px,
    "rendered region height mismatch");
  const observed = {
    observation_schema_version: payload.observation_schema_version,
    source: payload.source,
    page_geometry: payload.page_geometry,
    requested_coordinate_space: payload.requested_coordinate_space,
    rendered_coordinate_space: payload.rendered_coordinate_space,
    requested_region: payload.requested_region,
    rendered_region: payload.rendered_region,
    renderer_policy: payload.renderer_policy,
    png_sha256: payload.png_sha256,
    raw_pixel_sha256: payload.raw_pixel_sha256,
    raw_pixel_status: payload.raw_pixel_status,
  };
  const expectedDigest = observationSha256({
    source_sha256: payload.source.sha256,
    channel: "render",
    page: payload.page,
    observed,
  });
  semanticAssertion(payload.observation_sha256 === expectedDigest,
    "render observation digest mismatch");
  return payload;
}

export { OBSERVATION_COORDINATE_SPACES };
