#!/usr/bin/env python3
"""Evaluation-only Docling adapter for the Phase 1 direct-PDF protocol.

This process deliberately does not answer arbitrary target schemas. It emits
parser observations (page text, raw tables, and native provenance) and an exact
typed abstention for every requested leaf. Canonical ODA evidence is always
empty because Docling geometry has not passed the ODA coordinate/source-item
reconciliation gate.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import stat
import sys
from typing import Any


PROTOCOL = "pdf-tools.extraction-candidate.v1"
CANDIDATE_ID = "candidate.direct_pdf.v1"
ENGINE_ID = "docling"
MAX_STDIN_BYTES = 16 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID = re.compile(r"[^A-Za-z0-9._:-]+")
FORBIDDEN_TRUTH_KEYS = {
    "ground_truth", "expected", "partition", "category", "fact_ids",
    "truth_boxes", "answer_state", "evaluation_policy", "scorer_thresholds",
    "repo_root", "repository_root",
}
PACKAGE_IMPORTS = {
    "docling-slim": "docling",
    "docling-core": "docling_core",
    "docling-ibm-models": "docling_ibm_models",
    "docling-parse": "docling_parse",
    "ocrmac": "ocrmac",
    "pypdfium2": "pypdfium2",
    "torch": "torch",
    "torchvision": "torchvision",
    "accelerate": "accelerate",
    "huggingface-hub": "huggingface_hub",
    "defusedxml": "defusedxml",
}


class AdapterError(Exception):
    """Stable candidate failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_bounded_stdin() -> bytes:
    data = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(data) > MAX_STDIN_BYTES:
        raise AdapterError("REQUEST_TOO_LARGE", "Candidate request exceeds the adapter input ceiling")
    if not data:
        raise AdapterError("REQUEST_EMPTY", "Candidate request is empty")
    return data


def exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise AdapterError("REQUEST_CONTRACT_INVALID", f"{label} keys do not match the Phase 1 contract")


def collect_keys(value: Any) -> list[str]:
    keys: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            keys.append(key)
            keys.extend(collect_keys(child))
    elif isinstance(value, list):
        for child in value:
            keys.extend(collect_keys(child))
    return keys


def pointer_token(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def target_leaf_pointers(schema: Any, pointer: str = "") -> list[str]:
    if not isinstance(schema, dict):
        raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema must be an object")
    for keyword in ("$ref", "allOf", "oneOf", "not", "if", "then", "else"):
        if keyword in schema:
            raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", f"Unsupported target schema construct: {keyword}")
    if schema.get("type") == "object" or "properties" in schema:
        properties = schema.get("properties")
        if schema.get("type") != "object" or schema.get("additionalProperties") is not False or not isinstance(properties, dict):
            raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Object schemas must be closed and declare properties")
        names = sorted(properties)
        if sorted(schema.get("required", [])) != names:
            raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Every object property must be required")
        result: list[str] = []
        for name in names:
            result.extend(target_leaf_pointers(properties[name], f"{pointer}/{pointer_token(name)}"))
        return result
    if (schema.get("type") in {"string", "number", "integer", "boolean", "null", "array"}
            or "const" in schema or isinstance(schema.get("enum"), list) or isinstance(schema.get("anyOf"), list)):
        return [pointer]
    raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema leaf is outside the Phase 1 subset")


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Candidate request must be an object")
    exact_keys(value, {"protocol", "request_id", "candidate_id", "input_mode", "source", "inputs", "task", "limits"}, "request")
    if value.get("protocol") != PROTOCOL or value.get("candidate_id") != CANDIDATE_ID or value.get("input_mode") != "direct_pdf":
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Adapter accepts only the Phase 1 direct-PDF candidate slot")
    if not isinstance(value.get("request_id"), str) or not SHA256.fullmatch(value["request_id"]):
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Request ID is not a SHA-256 binding")
    source = value.get("source")
    task = value.get("task")
    limits = value.get("limits")
    inputs = value.get("inputs")
    if not all(isinstance(item, dict) for item in (source, task, limits, inputs)):
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Request sections must be objects")
    exact_keys(source, {"path", "media_type", "sha256", "size_bytes", "page_count"}, "source")
    exact_keys(inputs, {"layout_ir", "raster_manifest"}, "inputs")
    exact_keys(task, {"instruction", "target_schema", "target_schema_sha256"}, "task")
    exact_keys(limits, {"deadline_ms", "max_stdout_bytes", "max_stderr_bytes", "max_request_bytes", "max_report_bytes", "max_source_bytes", "max_pages"}, "limits")
    if source.get("path") != "source.pdf" or source.get("media_type") != "application/pdf":
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Source must be the staged source.pdf")
    if inputs.get("layout_ir") is not None or inputs.get("raster_manifest") is not None:
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Direct-PDF requests cannot carry supplemental adapters")
    truth_projection = dict(value)
    truth_projection["task"] = dict(task)
    truth_projection["task"]["target_schema"] = {}
    if any(key in FORBIDDEN_TRUTH_KEYS for key in collect_keys(truth_projection)):
        raise AdapterError("TRUTH_PROJECTION_VIOLATION", "Candidate request contains a forbidden truth key")
    if not isinstance(task.get("target_schema"), dict):
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Target schema must be an object")
    if sha256(canonical_json(task["target_schema"])) != task.get("target_schema_sha256"):
        raise AdapterError("TARGET_SCHEMA_DIGEST_MISMATCH", "Target schema digest does not match its canonical bytes")
    limit_ranges = {
        "deadline_ms": (1, 600000), "max_stdout_bytes": (1024, 16777216),
        "max_stderr_bytes": (0, 4194304), "max_request_bytes": (1024, 16777216),
        "max_report_bytes": (1048576, 268435456), "max_source_bytes": (1, 1073741824),
        "max_pages": (1, 10000),
    }
    if any(type(limits.get(name)) is not int or limits[name] < minimum or limits[name] > maximum
           for name, (minimum, maximum) in limit_ranges.items()):
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Request limits are outside the Phase 1 contract")
    if type(source.get("size_bytes")) is not int or source["size_bytes"] < 1 or type(source.get("page_count")) is not int or source["page_count"] < 1:
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Source size and page count must be positive integers")
    if not isinstance(source.get("sha256"), str) or not SHA256.fullmatch(source["sha256"]):
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Source digest is not SHA-256")
    if source["size_bytes"] > limits["max_source_bytes"] or source["page_count"] > limits["max_pages"]:
        raise AdapterError("SOURCE_LIMIT_EXCEEDED", "Source exceeds the requested candidate limits")
    target_leaf_pointers(task["target_schema"])
    return value


def read_source(request: dict[str, Any]) -> Path:
    source_path = Path(request["source"]["path"])
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source_path, flags)
    except OSError as error:
        raise AdapterError("SOURCE_OPEN_FAILED", "Staged source could not be opened as a regular file") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise AdapterError("SOURCE_TYPE_INVALID", "Staged source must be a single-link regular file")
        expected_size = request["source"]["size_bytes"]
        if metadata.st_size != expected_size:
            raise AdapterError("SOURCE_SIZE_MISMATCH", "Staged source size does not match the runner binding")
        digest = hashlib.sha256()
        observed = 0
        while True:
            chunk = os.read(descriptor, min(1024 * 1024, expected_size - observed + 1))
            if not chunk:
                break
            observed += len(chunk)
            if observed > expected_size:
                raise AdapterError("SOURCE_SIZE_MISMATCH", "Staged source grew while it was read")
            digest.update(chunk)
        after = os.fstat(descriptor)
        if observed != expected_size or digest.hexdigest() != request["source"]["sha256"]:
            raise AdapterError("SOURCE_DIGEST_MISMATCH", "Staged source bytes do not match the runner binding")
        if (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise AdapterError("SOURCE_MUTATED", "Staged source changed while it was read")
    finally:
        os.close(descriptor)
    return source_path.resolve(strict=True)


def load_config(config_path: Path) -> dict[str, Any]:
    try:
        raw = config_path.read_bytes()
        config = json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        raise AdapterError("CONFIG_INVALID", "Pinned Docling configuration could not be loaded") from error
    if (config.get("config_id") != "pdf-tools.extraction-docling-candidate-config.v1"
            or config.get("candidate_id") != CANDIDATE_ID or config.get("input_mode") != "direct_pdf"
            or config.get("execution_state") != "adapter_ready_not_executed"):
        raise AdapterError("CONFIG_INVALID", "Pinned Docling configuration identity is invalid")
    if config.get("table_model", {}).get("enabled") is not False:
        raise AdapterError("TABLE_MODEL_NOT_REVIEWED", "TableFormer must remain disabled until its license review is complete")
    if config.get("ocr", {}).get("automatic_selection") is not False:
        raise AdapterError("OCR_SELECTION_UNSAFE", "Automatic OCR selection is forbidden")
    packages = config.get("packages")
    if not isinstance(packages, list) or len(packages) != len(PACKAGE_IMPORTS):
        raise AdapterError("PACKAGE_SET_MISMATCH", "Pinned Python package set is incomplete")
    package_names = [item.get("name") for item in packages if isinstance(item, dict)]
    if set(package_names) != set(PACKAGE_IMPORTS) or len(package_names) != len(set(package_names)):
        raise AdapterError("PACKAGE_SET_MISMATCH", "Pinned Python package names are incomplete or duplicated")
    for package in packages:
        if (not isinstance(package.get("version"), str) or not package["version"]
                or not isinstance(package.get("wheel_sha256"), str) or not SHA256.fullmatch(package["wheel_sha256"])):
            raise AdapterError("PACKAGE_SET_MISMATCH", "Pinned Python package identity is malformed")
    if config.get("install_requirement") != "docling-slim[convert-core,format-pdf,models-local,feat-ocr-mac]==2.114.0":
        raise AdapterError("PACKAGE_SET_MISMATCH", "Pinned Docling slim extras are invalid")
    return config


def verify_python_packages(config: dict[str, Any]) -> None:
    expected = {item["name"]: item["version"] for item in config["packages"]}
    if set(expected) != set(PACKAGE_IMPORTS):
        raise AdapterError("PACKAGE_SET_MISMATCH", "Pinned Python package set is incomplete or contains extras")
    for distribution, module in PACKAGE_IMPORTS.items():
        try:
            observed = importlib.metadata.version(distribution)
            __import__(module)
        except (importlib.metadata.PackageNotFoundError, ImportError) as error:
            raise AdapterError("PACKAGE_MISSING", f"Required pinned package is unavailable: {distribution}") from error
        if observed != expected[distribution]:
            raise AdapterError("PACKAGE_VERSION_MISMATCH", f"Installed version does not match the pin for {distribution}")


def verify_layout_artifacts(artifacts_path: Path, config: dict[str, Any]) -> None:
    if not artifacts_path.is_absolute() or not artifacts_path.is_dir() or artifacts_path.is_symlink():
        raise AdapterError("ARTIFACT_ROOT_INVALID", "Docling artifact root must be an absolute, existing real directory")
    expected_bytes = config["layout_model"]["weight_bytes"]
    expected_sha = config["layout_model"]["weight_sha256"]
    matches: list[Path] = []
    for candidate in artifacts_path.rglob("*"):
        if candidate.is_symlink():
            raise AdapterError("ARTIFACT_LINK_FORBIDDEN", "Docling artifact root contains a symbolic link")
        if candidate.is_file() and candidate.stat().st_size == expected_bytes:
            digest = hashlib.sha256()
            with candidate.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() == expected_sha:
                matches.append(candidate)
    if len(matches) != 1:
        raise AdapterError("LAYOUT_WEIGHT_IDENTITY_MISMATCH", "Exactly one pinned layout weight must be present")
    repository_path = artifacts_path / config["layout_model"]["repository"].replace("/", "--")
    for filename, digest_key in (("config.json", "config_sha256"), ("preprocessor_config.json", "preprocessor_config_sha256")):
        candidate = repository_path / filename
        if not candidate.is_file() or candidate.is_symlink() or sha256(candidate.read_bytes()) != config["layout_model"][digest_key]:
            raise AdapterError("LAYOUT_CONFIG_IDENTITY_MISMATCH", f"Pinned layout {filename} is missing or changed")


def page_map(document: dict[str, Any], expected_count: int) -> dict[int, dict[str, float]]:
    pages = document.get("pages")
    if not isinstance(pages, dict):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling export does not contain a page map")
    result: dict[int, dict[str, float]] = {}
    for key, page in pages.items():
        if not isinstance(page, dict) or not isinstance(page.get("size"), dict):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling page geometry is missing")
        page_number = page.get("page_no", int(key) if str(key).isdigit() else None)
        width = page["size"].get("width")
        height = page["size"].get("height")
        if (type(page_number) is not int or page_number < 1 or isinstance(width, bool) or isinstance(height, bool)
                or not isinstance(width, (int, float)) or not isinstance(height, (int, float)) or width <= 0 or height <= 0):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling page geometry is invalid")
        if page_number in result:
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling export contains duplicate pages")
        result[page_number] = {"width": float(width), "height": float(height)}
    if sorted(result) != list(range(1, expected_count + 1)):
        raise AdapterError("PAGE_BINDING_MISMATCH", "Docling page map does not match the runner page count")
    return result


def native_bbox(bbox: Any, geometry: dict[str, float]) -> tuple[dict[str, float], str]:
    if not isinstance(bbox, dict):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Native provenance bbox is missing")
    values = [bbox.get(name) for name in ("l", "t", "r", "b")]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in values):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Native provenance bbox is not numeric")
    left, top, right, bottom = [float(value) for value in values]
    origin = bbox.get("coord_origin", "TOPLEFT")
    if origin == "TOPLEFT":
        x, y, width, height = left, top, right - left, bottom - top
        coordinate_space = "docling.engine-top-left-points.v1"
    elif origin == "BOTTOMLEFT":
        x, y, width, height = left, bottom, right - left, top - bottom
        coordinate_space = "docling.engine-bottom-left-points.v1"
    else:
        raise AdapterError("DOCLING_EXPORT_INVALID", "Unknown Docling coordinate origin")
    if (width <= 0 or height <= 0 or x < 0 or y < 0
            or x + width > geometry["width"] or y + height > geometry["height"]):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Native provenance bbox lies outside the engine page")
    return {"x": x, "y": y, "width": width, "height": height}, coordinate_space


def safe_id(value: str) -> str:
    cleaned = SAFE_ID.sub("_", value).strip("_")
    return cleaned[:120] or "item"


def native_record(item_id: str, page: int, bbox: Any, quote: str, native_ref: Any,
                  geometry: dict[str, float], engine_version: str) -> dict[str, Any]:
    translated_bbox, coordinate_space = native_bbox(bbox, geometry)
    return {
        "id": safe_id(item_id),
        "page": page,
        "coordinate_space": coordinate_space,
        "bbox": translated_bbox,
        "native_ref": native_ref if isinstance(native_ref, str) else None,
        "quote": quote if isinstance(quote, str) else "",
        "origin": {"engine_id": ENGINE_ID, "engine_version": engine_version},
        "page_geometry": {
            "width": geometry["width"], "height": geometry["height"], "rotation": 0,
            "box_basis": "engine_display_box", "user_unit_handling": "unknown",
        },
    }


def table_value(cell: dict[str, Any]) -> tuple[bool, Any]:
    if "value" in cell:
        return True, cell["value"]
    if "text" in cell:
        return True, cell["text"]
    return False, None


def translate_table(table: dict[str, Any], index: int, pages: dict[int, dict[str, float]],
                    engine_version: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    data = table.get("data")
    if not isinstance(data, dict) or type(data.get("num_rows")) is not int or type(data.get("num_cols")) is not int:
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table dimensions are missing")
    rows, columns = data["num_rows"], data["num_cols"]
    if rows < 1 or columns < 1 or not isinstance(data.get("table_cells", []), list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table dimensions or cells are invalid")
    cells: list[dict[str, Any]] = []
    occupied: set[tuple[int, int]] = set()
    merged: list[dict[str, int]] = []
    native: list[dict[str, Any]] = []
    table_pages: set[int] = set()
    table_ref = table.get("self_ref")
    for prov_index, provenance in enumerate(table.get("prov", [])):
        if not isinstance(provenance, dict) or type(provenance.get("page_no")) is not int or provenance["page_no"] not in pages:
            raise AdapterError("PAGE_BINDING_MISMATCH", "Docling table provenance references an unknown page")
        page = provenance["page_no"]
        table_pages.add(page)
        native.append(native_record(f"docling.table.{index}.prov.{prov_index}", page, provenance.get("bbox"), "", table_ref, pages[page], engine_version))
    if not table_pages:
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table has no page provenance")
    default_page = min(table_pages)
    for cell_index, cell in enumerate(data.get("table_cells", [])):
        if not isinstance(cell, dict):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table cell is not an object")
        present, value = table_value(cell)
        if not present:
            continue
        start_row = cell.get("start_row_offset_idx")
        start_column = cell.get("start_col_offset_idx")
        end_row = cell.get("end_row_offset_idx")
        end_column = cell.get("end_col_offset_idx")
        if not all(type(item) is int for item in (start_row, start_column, end_row, end_column)):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table cell offsets are invalid")
        row_span = end_row - start_row
        column_span = end_column - start_column
        if (row_span < 1 or column_span < 1 or start_row < 0 or start_column < 0
                or end_row > rows or end_column > columns
                or cell.get("row_span", row_span) != row_span or cell.get("col_span", column_span) != column_span):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table cell span is inconsistent")
        for row in range(start_row + 1, end_row + 1):
            for column in range(start_column + 1, end_column + 1):
                coordinate = (row, column)
                if coordinate in occupied:
                    raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table cells overlap")
                occupied.add(coordinate)
        translated = {
            "row": start_row + 1, "column": start_column + 1,
            "row_span": row_span, "column_span": column_span,
            "present": True, "value": value,
        }
        cells.append(translated)
        if row_span > 1 or column_span > 1:
            merged.append({
                "start_row": start_row + 1, "start_column": start_column + 1,
                "end_row": end_row, "end_column": end_column,
            })
        if cell.get("bbox") is not None:
            native.append(native_record(
                f"docling.table.{index}.cell.{cell_index}", default_page, cell["bbox"],
                value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                f"{table_ref or '#/tables/' + str(index)}/data/table_cells/{cell_index}",
                pages[default_page], engine_version,
            ))
    result = {
        "id": safe_id(f"docling.table.{index}"), "pages": sorted(table_pages),
        "row_count": rows, "column_count": columns, "merged_regions": merged, "cells": cells,
    }
    return result, native


def translate_export(document: dict[str, Any], request: dict[str, Any], engine_version: str) -> dict[str, Any]:
    pages = page_map(document, request["source"]["page_count"])
    page_chunks: dict[int, list[str]] = {page: [] for page in pages}
    native: list[dict[str, Any]] = []
    texts = document.get("texts", [])
    if not isinstance(texts, list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling text collection is invalid")
    for item_index, item in enumerate(texts):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not isinstance(item.get("prov", []), list):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling text item is invalid")
        text = item["text"]
        item_pages: set[int] = set()
        for prov_index, provenance in enumerate(item.get("prov", [])):
            if not isinstance(provenance, dict) or type(provenance.get("page_no")) is not int or provenance["page_no"] not in pages:
                raise AdapterError("PAGE_BINDING_MISMATCH", "Docling text provenance references an unknown page")
            page = provenance["page_no"]
            item_pages.add(page)
            native.append(native_record(
                f"docling.text.{item_index}.prov.{prov_index}", page, provenance.get("bbox"), text,
                item.get("self_ref"), pages[page], engine_version,
            ))
        if item.get("content_layer", "body") == "body":
            for page in sorted(item_pages):
                page_chunks[page].append(text)
    exported_page_texts = document.get("_oda_body_page_texts")
    if exported_page_texts is not None:
        if (not isinstance(exported_page_texts, dict) or set(exported_page_texts) != {str(page) for page in pages}
                or any(not isinstance(value, str) for value in exported_page_texts.values())):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling BODY page-text export is invalid")
        page_chunks = {page: [exported_page_texts[str(page)]] for page in pages}
    tables: list[dict[str, Any]] = []
    exported_tables = document.get("tables", [])
    if not isinstance(exported_tables, list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table collection is invalid")
    for table_index, table in enumerate(exported_tables):
        if not isinstance(table, dict):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table item is invalid")
        translated, table_native = translate_table(table, table_index, pages, engine_version)
        tables.append(translated)
        native.extend(table_native)
    page_texts = [{
        "page": page, "text": "\n".join(page_chunks[page]), "text_kind": "visual_parser",
        "source_item_ids": [], "origin": {"engine_id": ENGINE_ID, "engine_version": engine_version},
    } for page in sorted(pages)]
    gaps = [{
        "field_path": pointer, "reason": "unsupported_modality",
        "detail": "Parser-only Docling lane does not answer arbitrary target schemas",
    } for pointer in target_leaf_pointers(request["task"]["target_schema"])]
    return {
        "protocol": PROTOCOL, "request_id": request["request_id"], "status": "abstained", "decision": "abstain",
        "structured_candidate": None, "page_texts": page_texts, "tables": tables,
        "native_evidence": native, "evidence": [], "field_evidence": [], "gaps": gaps,
        "diagnostics": {"code": None, "message": None},
    }


def run_docling(source_path: Path, artifacts_path: Path, config: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["DOCLING_ARTIFACTS_PATH"] = str(artifacts_path)
    verify_python_packages(config)
    verify_layout_artifacts(artifacts_path, config)
    try:
        from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling_core.types.doc import ContentLayer

        options = PdfPipelineOptions(
            artifacts_path=artifacts_path,
            document_timeout=max(1.0, request["limits"]["deadline_ms"] / 1000),
            do_ocr=False,
            do_table_structure=False,
            enable_remote_services=False,
            allow_external_plugins=False,
            accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=1),
        )
        converter = DocumentConverter(
            allowed_formats=[InputFormat.PDF],
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
        )
        conversion = converter.convert(
            source_path,
            max_num_pages=request["limits"]["max_pages"],
            max_file_size=request["limits"]["max_source_bytes"],
            raises_on_error=True,
        )
        document = conversion.document.export_to_dict()
        document["_oda_body_page_texts"] = {
            str(page): conversion.document.export_to_text(
                page_no=page,
                included_content_layers={ContentLayer.BODY},
                traverse_pictures=True,
            )
            for page in range(1, request["source"]["page_count"] + 1)
        }
    except AdapterError:
        raise
    except Exception as error:
        raise AdapterError("DOCLING_CONVERSION_FAILED", f"Docling conversion failed: {type(error).__name__}") from error
    if not isinstance(document, dict):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling export is not an object")
    return document


def error_response(request: dict[str, Any], error: AdapterError) -> dict[str, Any]:
    code = re.sub(r"[^A-Z0-9_]", "_", error.code.upper())[:64]
    if not re.match(r"^[A-Z][A-Z0-9_]{1,63}$", code):
        code = "ADAPTER_FAILURE"
    return {
        "protocol": PROTOCOL, "request_id": request["request_id"], "status": "error", "decision": "abstain",
        "structured_candidate": None, "page_texts": [], "tables": [], "native_evidence": [],
        "evidence": [], "field_evidence": [], "gaps": [],
        "diagnostics": {"code": code, "message": str(error)[:500]},
    }


def emit(response: dict[str, Any], max_bytes: int) -> None:
    encoded = canonical_json(response)
    if len(encoded) + 1 > max_bytes:
        raise AdapterError("OUTPUT_LIMIT_EXCEEDED", "Adapter response exceeds the request output ceiling")
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--artifacts-path", required=True, type=Path)
    parser.add_argument("--translate-export", type=Path, help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    request: dict[str, Any] | None = None
    try:
        request = validate_request(json.loads(read_bounded_stdin()))
        source_path = read_source(request)
        config = load_config(args.config.resolve(strict=True))
        if args.translate_export is not None:
            if os.environ.get("PDF_TOOLS_DOCLING_TEST_EXPORT") != "1":
                raise AdapterError("TEST_SEAM_FORBIDDEN", "Synthetic export translation is available only to the adapter test harness")
            document = json.loads(args.translate_export.read_bytes())
        else:
            document = run_docling(source_path, args.artifacts_path.resolve(strict=True), config, request)
        engine_version = next(item["version"] for item in config["packages"] if item["name"] == "docling-slim")
        response = translate_export(document, request, engine_version)
        emit(response, request["limits"]["max_stdout_bytes"])
        return 0
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        print(f"Invalid JSON input: {type(error).__name__}", file=sys.stderr)
        return 2
    except AdapterError as error:
        if request is None:
            print(f"{error.code}: {error}", file=sys.stderr)
            return 2
        try:
            emit(error_response(request, error), request["limits"]["max_stdout_bytes"])
            return 0
        except AdapterError as output_error:
            print(f"{output_error.code}: {output_error}", file=sys.stderr)
            return 2


if __name__ == "__main__":
    raise SystemExit(main())
