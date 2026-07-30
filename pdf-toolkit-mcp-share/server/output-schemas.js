import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { validatePdfLayoutSemantics } from "./layout-extraction.js";
import { validateMarkdownConversionSemantics } from "./markdown-conversion.js";

const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const stringArray = { type: "array", items: string };
const integerArray = { type: "array", items: integer };
const nullable = schema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties,
});
const arrayOf = items => ({ type: "array", items });
const enumString = values => ({ type: "string", enum: values });

const fieldValue = {
  anyOf: [string, boolean, stringArray],
};
const formField = object({
  name: string,
  type: enumString(["text", "checkbox", "radio", "dropdown", "unknown"]),
  options: stringArray,
  currentValue: fieldValue,
});
const activeDocumentProperties = {
  pdfPath: string,
  totalBytes: integer,
  initialPage: integer,
  fields: arrayOf(formField),
  fieldCount: integer,
  hasFormFields: boolean,
  active_path: string,
  backup_path: nullable(string),
  last_mutation_tool: nullable(string),
  last_mutation_at: nullable(string),
};
const activeDocument = (extra = {}) => object({
  ...activeDocumentProperties,
  ...extra,
});

const pageTextPreview = object({
  page: integer,
  char_count: integer,
  returned_chars: integer,
  truncated: boolean,
  text: string,
});
const regionPoints = object({
  x: number,
  y: number,
  width: number,
  height: number,
});
const placement = object({
  label: string,
  page: integer,
  x: number,
  y: number,
  width: number,
  height: number,
});
const fillError = object({ field: string, error: string });
const signatureZone = object({
  type: enumString(["signature", "initials", "name", "date"]),
  label: string,
  page: integer,
  x: number,
  y: number,
  width: number,
  height: number,
  confidence: number,
  source: enumString(["text-heuristic", "acroform-signature", "acroform-named-field"]),
});
const zoneDetectionWarning = object({
  code: enumString([
    "ACROFORM_WIDGET_PAGE_UNRESOLVED",
    "ENCRYPTED_ACROFORM_SCAN_UNAVAILABLE",
    "TEXT_EXTRACTION_UNAVAILABLE",
  ]),
  message: string,
  occurrences: { type: "integer", minimum: 1 },
});

const standardError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString([
      "internal_validation_error",
      "path_policy_denied",
      "tool_execution_failed",
    ]),
  }),
});
const layoutPasswordError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString(["PASSWORD_REQUIRED", "PASSWORD_INCORRECT"]),
  }),
});
const pdfResourceLimitError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: { const: "PDF_RESOURCE_LIMIT_EXCEEDED" },
  }),
});
const pdfIdentityError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString([
      "PDF_CHANGED_DURING_READ",
      "PDF_INPUT_TOO_LARGE",
      "PDF_INVALID_HEADER",
      "PDF_UNAVAILABLE",
    ]),
  }),
});

const validationField = object({
  name: string,
  type: string,
  kind: enumString(["text", "checkbox", "radio", "dropdown", "option_list", "signature", "button", "unknown"]),
  required: nullable(boolean),
  required_name_hint: boolean,
  value_status: enumString(["observed", "empty", "unchecked", "unknown", "read_error", "not_applicable"]),
  required_status: enumString(["not_required", "unknown", "satisfied", "missing"]),
  error_code: nullable(string),
});
const validationProperties = {
  schema_version: { const: "1.0" },
  pdf_path: nullable(string),
  file_name: nullable(string),
  validation_status: enumString(["complete", "partial", "incomplete", "indeterminate", "no_fields", "no_value_fields"]),
  required_field_validation_status: enumString(["complete", "incomplete", "indeterminate", "no_fields", "no_required_flags"]),
  validation_conclusive: boolean,
  has_form_fields: boolean,
  required_fields_complete: nullable(boolean),
  all_value_fields_filled: nullable(boolean),
  can_claim_required_fields_complete: boolean,
  can_claim_form_ready: { const: false },
  total_field_count: integer,
  value_field_count: integer,
  observed_count: integer,
  filled_count: integer,
  empty_count: integer,
  unchecked_count: integer,
  unknown_count: integer,
  read_error_count: integer,
  not_applicable_count: integer,
  required_field_count: integer,
  missing_required_count: integer,
  indeterminate_required_count: integer,
  requiredness_unknown_count: integer,
  fields: arrayOf(validationField),
  observed_fields: stringArray,
  empty_fields: stringArray,
  unchecked_fields: stringArray,
  unknown_fields: stringArray,
  read_error_fields: stringArray,
  missing_required_fields: stringArray,
  indeterminate_required_fields: stringArray,
  requiredness_unknown_fields: stringArray,
  heuristic_required_candidates: stringArray,
  error_codes: stringArray,
  warning_codes: stringArray,
  retry_guidance: nullable(string),
  limitations: stringArray,
};
const validationSuccess = object({
  ...validationProperties,
  pdf_path: string,
  file_name: string,
});
const validationFailure = object({
  ...validationProperties,
  validation_status: { const: "failed" },
  required_field_validation_status: { const: "failed" },
  has_form_fields: { type: "null" },
  total_field_count: { type: "null" },
  value_field_count: { type: "null" },
  observed_count: { type: "null" },
  filled_count: { type: "null" },
  empty_count: { type: "null" },
  unchecked_count: { type: "null" },
  unknown_count: { type: "null" },
  read_error_count: { type: "null" },
  not_applicable_count: { type: "null" },
  required_field_count: { type: "null" },
  missing_required_count: { type: "null" },
  indeterminate_required_count: { type: "null" },
  requiredness_unknown_count: { type: "null" },
});
const contentProperties = {
  pdf_path: string,
  file_name: string,
  total_pages: integer,
  pages_read: integer,
  text_length: integer,
  text_truncated: boolean,
  text_found: boolean,
  content_available: boolean,
  extraction_status: enumString(["complete", "partial"]),
  page_previews: arrayOf(pageTextPreview),
  preview_truncated: boolean,
  extraction_mode: enumString(["text", "image-fallback"]),
  error_codes: stringArray,
  retry_guidance: nullable(string),
};
const contentTextSuccess = object({
  ...contentProperties,
  text_found: { const: true },
  content_available: { const: true },
  extraction_mode: { const: "text" },
});
const contentImageSuccess = object({
  ...contentProperties,
  text_length: { const: 0 },
  text_truncated: { const: false },
  text_found: { const: false },
  content_available: { const: true },
  extraction_status: { const: "partial" },
  extraction_mode: { const: "image-fallback" },
  image_renderer: enumString(["native-canvas", "macos-sips"]),
});
const contentFailure = object({
  ...contentProperties,
  text_truncated: { const: false },
  text_found: { const: false },
  content_available: { const: false },
  extraction_status: { const: "failed" },
  extraction_mode: { const: "none" },
});
const pageAnalysis = object({
  page: integer,
  width: integer,
  height: integer,
  rotation: integer,
  display_width: integer,
  display_height: integer,
  orientation: enumString(["portrait", "landscape"]),
  text_length: nullable(integer),
  text_snippet: nullable(string),
  has_images: nullable(boolean),
  has_graphics: nullable(boolean),
  content_analysis_status: enumString(["complete", "degraded", "unavailable", "not_analyzed"]),
  text_extraction_status: enumString(["complete", "failed", "not_analyzed"]),
  image_detection_status: enumString(["complete", "failed", "not_analyzed"]),
  graphics_detection_status: enumString(["complete", "failed", "not_analyzed"]),
  blank_status: enumString(["likely_blank", "not_blank", "unknown"]),
  analysis_error_codes: stringArray,
  analysis_provenance: object({
    dimensions: { const: "pdf-lib" },
    text: nullable(enumString(["pdfjs"])),
    images: nullable(enumString(["pdfjs"])),
    graphics: nullable(enumString(["pdfjs"])),
  }),
});
const analysisError = object({
  scope: enumString(["document", "page"]),
  page: integer,
  code: string,
}, ["scope", "code"]);
const layoutBox = object({ x: number, y: number, width: number, height: number });
const layoutItemSpace = object({
  origin: { const: "top_left" },
  unit: { const: "points_1_72_in_after_user_unit" },
  reference_box: { const: "pdfjs_display_viewport" },
});
const layoutRawPageSpace = object({
  basis: { const: "pdf_default_user_space" },
  unit: { const: "pdf_user_unit" },
  stage: { const: "before_user_unit_and_page_rotation" },
});
const layoutGeometry = object({
  page: integer,
  media_box: nullable(layoutBox),
  crop_box: nullable(layoutBox),
  pdfjs_view: nullable({ type: "array", minItems: 4, maxItems: 4, items: number }),
  user_unit: nullable(number),
  raw_pdf_rotation: nullable({ type: "integer", enum: [0, 90, 180, 270] }),
  display_rotation: nullable({ type: "integer", enum: [0, 90, 180, 270] }),
  rotation_matches_raw: nullable(boolean),
  display_width: nullable(number),
  display_height: nullable(number),
  viewport_transform: nullable({ type: "array", minItems: 6, maxItems: 6, items: number }),
  raw_page_space: layoutRawPageSpace,
  item_space: layoutItemSpace,
});
const layoutPageTruncation = object({
  truncated: boolean,
  reasons: stringArray,
  omitted_items: integer,
  omitted_non_whitespace_items: integer,
  omitted_characters: integer,
  first_omitted_source_index: nullable(integer),
});
const layoutDocumentTruncation = object({
  truncated: boolean,
  reasons: stringArray,
  omitted_items: integer,
  omitted_characters: integer,
  first_omitted_page: nullable(integer),
  first_omitted_source_index: nullable(integer),
});
const layoutError = object({
  stage: enumString(["page", "text", "operators", "geometry"]),
  code: string,
  message: string,
});
const layoutPoint = object({ x: number, y: number });
const layoutRawItem = object({
  id: string,
  source_index: integer,
  text: string,
  is_whitespace: boolean,
  text_kind: enumString(["empty", "whitespace", "non_whitespace"]),
  has_eol: boolean,
  raw_transform: { type: "array", minItems: 6, maxItems: 6, items: nullable(number) },
  raw_width: nullable(number),
  raw_height: nullable(number),
  font_name: nullable(string),
  font: object({
    family: nullable(string),
    ascent: nullable(number),
    descent: nullable(number),
    vertical: boolean,
  }),
  geometry_kind: { const: "pdfjs_text_run_advance_box" },
  geometry_valid: boolean,
  bbox_status: enumString(["valid", "degenerate", "invalid"]),
  geometry_provenance: object({
    formula: { const: "pdfjs_text_item_style_metric_advance_box_approximation" },
    quad_order: { const: "anchor_top_terminal_top_anchor_bottom_terminal_bottom" },
    advance_source: enumString(["item_width", "item_height"]),
    ascent_source: nullable(enumString(["style_ascent", "style_descent_fallback", "default_0_8"])),
    ascent_ratio: nullable(number),
  }),
  quad: nullable({ type: "array", minItems: 4, maxItems: 4, items: layoutPoint }),
  bbox: nullable(layoutBox),
  x: nullable(number),
  y: nullable(number),
  width: nullable(number),
  height: nullable(number),
  line_height: nullable(number),
  direction: enumString(["ltr", "rtl", "ttb", "unknown"]),
  reading_order_index: integer,
  line_id: nullable(string),
  column_index: nullable(integer),
});
const layoutLine = object({
  id: string,
  source_first_index: integer,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  direction: enumString(["ltr", "rtl", "ttb", "unknown"]),
  item_ids: stringArray,
  reading_order_index: integer,
  column_index: integer,
});
const layoutBlock = object({
  id: string,
  kind: enumString(["page_flow", "column_flow", "spanning_flow"]),
  column_index: integer,
  line_ids: stringArray,
});
const markdownGapCode = enumString([
  "PAGE_RANGE_INCOMPLETE",
  "SOURCE_ITEM_LIMIT_REACHED",
  "SOURCE_CHARACTER_LIMIT_REACHED",
  "MARKDOWN_BYTE_LIMIT_REACHED",
  "TEXT_LAYER_FAILED",
  "TEXT_LAYER_EMPTY",
  "OCR_NOT_PERFORMED",
  "IMAGE_CONTENT_NOT_RENDERED",
  "VECTOR_CONTENT_NOT_INTERPRETED",
  "RAW_PAGE_GEOMETRY_UNAVAILABLE",
  "INVALID_TEXT_GEOMETRY",
  "LINK_ANNOTATIONS_UNAVAILABLE",
  "LINK_MAPPING_AMBIGUOUS",
  "UNSUPPORTED_LINK_TARGET",
  "TABLE_TOPOLOGY_UNKNOWN",
  "CONTROL_CHARACTERS_SANITIZED",
]);
const markdownGap = object({
  code: markdownGapCode,
  page: nullable(integer),
  message: string,
});
const markdownPage = object({
  page: { type: "integer", minimum: 1 },
  conversion_status: enumString(["complete", "partial", "failed"]),
  markdown_bytes: { type: "integer", minimum: 0 },
  line_count: { type: "integer", minimum: 0 },
  rendered_line_count: { type: "integer", minimum: 0 },
  gaps: arrayOf(markdownGap),
});
const markdownSavedOutput = nullable(object({
  path: string,
  encoding: { const: "utf-8" },
  bytes: { type: "integer", minimum: 0 },
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  commit_method: { const: "same_directory_atomic" },
  reopened_verified: { const: true },
  overwritten: boolean,
}));
const layoutPage = object({
  id: string,
  page: integer,
  text_layer_status: enumString(["present", "empty", "partial", "failed"]),
  image_detection_status: enumString(["detected", "not_detected", "failed"]),
  modality_hint: enumString(["text-layer-candidate", "mixed-content-candidate", "image-only-candidate", "vector-only-candidate", "empty-candidate", "unknown"]),
  extraction_status: enumString(["complete", "partial", "failed"]),
  needs_visual_inspection: boolean,
  geometry: layoutGeometry,
  has_image_operations: nullable(boolean),
  has_vector_paint_operations: nullable(boolean),
  raw_items: arrayOf(layoutRawItem),
  lines: arrayOf(layoutLine),
  blocks: arrayOf(layoutBlock),
  reading_order: object({
    strategy: enumString(["source_order_fallback", "two_column_left_to_right", "unavailable_output_omitted"]),
    confidence: { const: "not_calibrated" },
    column_count: integer,
    limitations: stringArray,
  }),
  flow_text: string,
  spatial_text: string,
  counts: object({
    observed_items: integer,
    returned_items: integer,
    observed_non_whitespace_items: integer,
    returned_non_whitespace_items: integer,
    observed_characters: integer,
    returned_characters: integer,
  }),
  truncation: layoutPageTruncation,
  errors: arrayOf(layoutError),
  limitations: stringArray,
});

export const TOOL_SUCCESS_OUTPUT_SCHEMAS = Object.freeze({
  read_pdf_fields: activeDocument(),
  fill_pdf: activeDocument({ filled_fields: stringArray, fill_errors: stringArray }),
  bulk_fill_from_csv: object({
    row_count: integer,
    results: arrayOf(object({
      filename: string,
      output_path: string,
      fields_filled: integer,
      errors: stringArray,
      status: enumString(["ok", "warning", "error"]),
    })),
    preview_records: arrayOf({ type: "object", additionalProperties: string }),
  }),
  fill_with_profile: activeDocument({
    profile_name: string,
    filled_fields: stringArray,
    fill_errors: stringArray,
  }),
  extract_to_csv: object({
    output_csv: string,
    source_pdf_count: integer,
    field_count: integer,
    row_count: integer,
    preview_row_count: integer,
    headers: stringArray,
    preview_rows: arrayOf({ type: "object", additionalProperties: string }),
  }),
  validate_pdf: validationSuccess,
  read_pdf_content: { type: "object", anyOf: [contentTextSuccess, contentImageSuccess] },
  read_pdf_pages: object({
    pdf_path: string,
    file_name: string,
    total_pages: integer,
    start_page: integer,
    end_page: integer,
    pages: arrayOf(pageTextPreview),
    text_found: boolean,
    truncated: boolean,
  }),
  read_pdf_layout: object({
    ir: object({ name: { const: "pdf-tools.extraction-ir" }, version: { const: "1.0.0" } }),
    parser: object({ name: { const: "pdfjs-dist" }, version: { const: "5.4.624" } }),
    source: object({
      pdf_path: string,
      file_name: string,
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      size_bytes: integer,
    }),
    id_scope: object({
      kind: { const: "source_parser_ir_options" },
      source_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      parser_version: { const: "5.4.624" },
      ir_version: { const: "1.0.0" },
      requested_start_page: integer,
      requested_end_page: integer,
      max_items: integer,
      max_characters: integer,
      max_output_characters: integer,
    }),
    page_range: object({
      requested_start_page: integer,
      requested_end_page: integer,
      start_page: integer,
      end_page: integer,
      total_pages: integer,
    }),
    extraction_status: enumString(["complete", "partial", "failed"]),
    pages: arrayOf(layoutPage),
    limits: object({
      max_items: integer,
      max_characters: integer,
      max_output_characters: integer,
      deadline_ms: integer,
    }),
    truncation: layoutDocumentTruncation,
    limitations: stringArray,
  }),
  convert_pdf_to_markdown: object({
    renderer: object({
      name: { const: "pdf-tools.layout-markdown-renderer" },
      version: { const: "1.1.0" },
    }),
    conversion_status: enumString(["complete", "partial", "failed"]),
    markdown: string,
    markdown_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    markdown_bytes: { type: "integer", minimum: 0 },
    options: object({ include_page_boundaries: boolean }),
    limits: object({ max_markdown_bytes: { type: "integer", minimum: 1, maximum: 200000 } }),
    pages: arrayOf(markdownPage),
    gaps: arrayOf(markdownGap),
    limitations: stringArray,
    provenance: object({
      source: object({
        file_name: string,
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        size_bytes: integer,
      }),
      layout: object({
        name: { const: "pdf-tools.extraction-ir" },
        version: { const: "1.0.0" },
        parser_name: { const: "pdfjs-dist" },
        parser_version: { const: "5.4.624" },
        page_range: object({
          start_page: integer,
          end_page: integer,
          total_pages: integer,
        }),
      }),
    }),
    saved_output: markdownSavedOutput,
  }),
  render_pdf_page: object({
    pdf_path: string,
    file_name: string,
    page: integer,
    total_pages: integer,
    width_points: integer,
    height_points: integer,
    rendered_width_px: integer,
    rendered_height_px: integer,
    scale: number,
    renderer: enumString(["native-canvas", "macos-sips"]),
    mime_type: { const: "image/png" },
  }),
  render_pdf_region: object({
    pdf_path: string,
    file_name: string,
    page: integer,
    total_pages: integer,
    region_points: regionPoints,
    rendered_width_px: integer,
    rendered_height_px: integer,
    scale: number,
    renderer: enumString(["native-canvas", "macos-sips"]),
    mime_type: { const: "image/png" },
  }),
  search_pdf_text: object({
    pdf_path: string,
    file_name: string,
    total_pages: integer,
    query: string,
    match_count: integer,
    truncated: boolean,
    matches: arrayOf(object({
      page: integer,
      char_index: integer,
      match_text: string,
      snippet: string,
    })),
  }),
  get_pdf_resource_uri: object({
    uri: string,
    pdf_path: string,
    file_name: string,
    size_bytes: integer,
  }),
  get_pdf_identity: object({
    schema_version: { const: "1.0" },
    requested_path: string,
    canonical_path: string,
    file_name: string,
    size_bytes: { type: "integer", minimum: 0, maximum: 250 * 1024 * 1024 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    identity_method: { const: "race_aware_descriptor_sha256" },
    pdf_parsed: { const: false },
  }),
  display_pdf: activeDocument(),
  get_active_document: {
    type: "object",
    anyOf: [
      object({
        active_path: { type: "null" },
        backup_path: { type: "null" },
        last_mutation_tool: { type: "null" },
        last_mutation_at: { type: "null" },
      }),
      activeDocument(),
    ],
  },
  set_active_document: activeDocument(),
  read_pdf_bytes: object({
    pdfPath: string,
    bytes: string,
    offset: integer,
    byteCount: integer,
    totalBytes: integer,
    hasMore: boolean,
  }),
  merge_pdfs: activeDocument({
    total_pages: integer,
    metadata_fields_omitted: stringArray,
  }),
  split_pdf: object({
    input_path: string,
    output_directory: string,
    file_count: integer,
    files: arrayOf(object({
      filename: string,
      output_path: string,
      start_page: integer,
      end_page: integer,
      page_count: integer,
    })),
  }),
  rotate_pdf_pages: activeDocument({
    rotated_pages: integer,
    degrees: { type: "number", enum: [90, 180, 270] },
  }),
  reorder_pdf_pages: activeDocument({ page_order: integerArray }),
  apply_page_plan: activeDocument({
    deleted_pages: integer,
    rotated_pages: integer,
    page_order: integerArray,
    rotations: { type: "object", additionalProperties: { type: "number", enum: [0, 90, 180, 270] } },
  }),
  get_page_analysis: object({
    total_pages: integer,
    content_analysis_status: enumString(["complete", "partial", "degraded"]),
    content_analysis_complete: boolean,
    content_pages_requested: integer,
    content_pages_complete: integer,
    likely_blank_pages: integerArray,
    nonblank_pages: integerArray,
    unknown_pages: integerArray,
    analysis_errors: arrayOf(analysisError),
    retry_guidance: nullable(string),
    mutation_guidance: string,
    pages: arrayOf(pageAnalysis),
    majority_orientation: enumString(["portrait", "landscape"]),
  }),
  create_signature: object({
    name: string,
    style: enumString(["typed", "image"]),
    path: string,
    bytes: integer,
  }),
  list_signatures: object({
    signatures: arrayOf(object({
      name: string,
      style: enumString(["typed", "image"]),
      display_name: nullable(string),
      created_at: nullable(string),
    })),
  }),
  load_signature: object({
    name: string,
    style: enumString(["typed", "image"]),
    display_name: nullable(string),
    preview_data_url: nullable(string),
    created_at: nullable(string),
  }),
  add_signature_field: activeDocument({
    pdf_path: string,
    page: integer,
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
  }),
  apply_signature: activeDocument({
    pdf_path: string,
    signature_name: string,
    page: integer,
    x: number,
    y: number,
    width: number,
    height: number,
    signer: string,
    confirmed_at: string,
    intent_statement: string,
    signing_mode: enumString(["signature", "initials"]),
    tier: { const: "basic-local-stamp" },
  }),
  prepare_signing_packet: activeDocument({
    pdf_path: string,
    pending_signatures: arrayOf(placement),
    filled_count: integer,
    fill_errors: arrayOf(fillError),
  }),
  apply_text: activeDocument({
    pdf_path: string,
    page: integer,
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
  }),
  detect_signature_zones: object({
    detection_status: enumString(["complete", "partial"]),
    zones: arrayOf(signatureZone),
    warnings: arrayOf(zoneDetectionWarning),
    // Zone coordinates are top-left origin relative to the page MediaBox.
    // PDF.js exposes only the view (CropBox intersected with MediaBox), so a
    // renderer cannot derive the MediaBox on its own and would misplace every
    // overlay on a page where those boxes differ.
    page_geometry: arrayOf(object({
      page: integer,
      origin_x: number,
      origin_y: number,
      width: number,
      height: number,
    })),
  }),
  fetch_pdf_from_url: activeDocument({
    pdf_path: string,
    bytes: integer,
    content_type: string,
    source_url: string,
  }),
  reveal_in_finder: object({
    path: string,
    platform: enumString(["darwin", "win32", "linux", "aix", "freebsd", "openbsd", "sunos", "android"]),
  }),
});

const specialErrorSchemas = {
  get_pdf_identity: [pdfIdentityError],
  validate_pdf: [validationFailure],
  read_pdf_content: [contentFailure, pdfResourceLimitError],
  read_pdf_pages: [pdfResourceLimitError],
  read_pdf_layout: [layoutPasswordError, pdfResourceLimitError],
  convert_pdf_to_markdown: [layoutPasswordError, pdfResourceLimitError],
  render_pdf_page: [pdfResourceLimitError],
  render_pdf_region: [pdfResourceLimitError],
  search_pdf_text: [pdfResourceLimitError],
  get_page_analysis: [pdfResourceLimitError],
  detect_signature_zones: [layoutPasswordError, pdfResourceLimitError],
};
for (const toolName of [
  "add_signature_field",
  "apply_page_plan",
  "apply_signature",
  "apply_text",
  "bulk_fill_from_csv",
  "fill_pdf",
  "fill_with_profile",
  "merge_pdfs",
  "prepare_signing_packet",
  "reorder_pdf_pages",
  "rotate_pdf_pages",
  "split_pdf",
]) {
  specialErrorSchemas[toolName] = [
    ...(specialErrorSchemas[toolName] ?? []),
    pdfResourceLimitError,
  ];
}

export const TOOL_ERROR_OUTPUT_SCHEMAS = Object.freeze(Object.fromEntries(
  Object.keys(TOOL_SUCCESS_OUTPUT_SCHEMAS).map(name => [
    name,
    {
      type: "object",
      anyOf: [standardError, ...(specialErrorSchemas[name] || [])],
    },
  ]),
));

// The pinned SDK validates structuredContent whenever it is present, including
// isError results. Keep every advertised error branch exact while the live
// success validator below deliberately excludes all error shapes.
export const TOOL_OUTPUT_SCHEMAS = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_SUCCESS_OUTPUT_SCHEMAS).map(([name, successSchema]) => [
    name,
    {
      type: "object",
      anyOf: [successSchema, standardError, ...(specialErrorSchemas[name] || [])],
    },
  ]),
));

const validatorProvider = new AjvJsonSchemaValidator();
const successValidators = new Map(Object.entries(TOOL_SUCCESS_OUTPUT_SCHEMAS).map(
  ([name, schema]) => [name, validatorProvider.getValidator(schema)],
));
const errorValidators = new Map(Object.entries(TOOL_ERROR_OUTPUT_SCHEMAS).map(
  ([name, schema]) => [name, validatorProvider.getValidator(schema)],
));
const standardErrorValidator = validatorProvider.getValidator(standardError);
const semanticSuccessValidators = new Map([
  ["read_pdf_layout", validatePdfLayoutSemantics],
  ["convert_pdf_to_markdown", validateMarkdownConversionSemantics],
]);

export function withToolOutputSchema(tool) {
  const outputSchema = TOOL_OUTPUT_SCHEMAS[tool.name];
  return outputSchema ? { ...tool, outputSchema } : tool;
}

export function hasToolOutputSchema(toolName) {
  return Object.prototype.hasOwnProperty.call(TOOL_OUTPUT_SCHEMAS, toolName);
}

export function createTypedToolError({
  message,
  code = "tool_execution_failed",
  content = null,
  structuredContent = null,
}) {
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("Typed tool errors require a non-empty message.");
  }
  if (typeof code !== "string" || code.length === 0) {
    throw new TypeError("Typed tool errors require a non-empty code.");
  }
  return {
    content: content ?? [{ type: "text", text: message }],
    structuredContent: structuredContent ?? {
      status: "failed",
      error: {
        error_schema_version: 1,
        code,
      },
    },
    isError: true,
  };
}

export function validateStructuredToolResult(toolName, result) {
  if (result?.isError === true) {
    if (result.structuredContent === undefined) {
      return internalValidationError(toolName, "the error result omitted required structured content");
    }
    const validation = (errorValidators.get(toolName) || standardErrorValidator)(result.structuredContent);
    if (!validation.valid) {
      return internalValidationError(toolName, `invalid structured error: ${validation.errorMessage}`);
    }
    return result;
  }

  const validator = successValidators.get(toolName);
  if (!validator) {
    if (result?.structuredContent === undefined) return result;
    return internalValidationError(toolName, "structured content was returned without an advertised output schema");
  }
  if (result?.structuredContent === undefined) {
    return internalValidationError(toolName, "the successful result omitted required structured content");
  }

  const validation = validator(result.structuredContent);
  if (!validation.valid) {
    return internalValidationError(toolName, validation.errorMessage);
  }
  const semanticValidator = semanticSuccessValidators.get(toolName);
  if (semanticValidator) {
    try {
      semanticValidator(result.structuredContent);
    } catch (error) {
      return internalValidationError(toolName, error.message);
    }
  }
  return result;
}

function internalValidationError(toolName, detail) {
  console.error(`[PDF Tools] Output validation failed for ${toolName}: ${detail}`);
  return createTypedToolError({
    message:
      `Internal output validation failed for ${toolName}. `
      + "No unvalidated structured result was returned.",
    code: "internal_validation_error",
  });
}
