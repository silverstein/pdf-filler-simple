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
from contextlib import contextmanager
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
from typing import Any


PROTOCOL = "pdf-tools.extraction-candidate.v1"
CANDIDATE_ID = "candidate.direct_pdf.v1"
ENGINE_ID = "docling"
MAX_STDIN_BYTES = 16 * 1024 * 1024
MAX_RECEIPT_BYTES = 1024 * 1024
MAX_MODEL_INVENTORY_BYTES = 16 * 1024 * 1024
MAX_MODEL_FILE_BYTES = 512 * 1024 * 1024
MAX_MODEL_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_SCHEMA_DEPTH = 32
MAX_SCHEMA_NODES = 2048
MAX_SCHEMA_LEAVES = 1024
RESPONSE_ENVELOPE_RESERVE_BYTES = 768
TORCHINDUCTOR_CACHE_BASENAME = "torchinductor-cache"
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
HANDOFF_INPUT_ROLES = {
    "adapter_entrypoint", "model_setup_helper", "candidate_config", "candidate_config_schema",
    "candidate_request_schema", "candidate_response_schema", "handoff_schema",
    "handoff_generator_source", "handoff_verifier_source", "runtime_evidence_source",
    "handoff_authority", "handoff_verifier_cli", "finalization_schema",
    "supervisor_source", "supervisor_controller",
    "supervisor_evidence_schema", "supervisor_calibration_attestation",
    "bakeoff_capture_source",
    "direct_requirements",
}


class AdapterError(Exception):
    """Stable candidate failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def js_string(value: str) -> str:
    escaped = []
    short = {"\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", '"': '\\"', "\\": "\\\\"}
    for character in value:
        code = ord(character)
        if character in short:
            escaped.append(short[character])
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            escaped.append(f"\\u{code:04x}")
        else:
            escaped.append(character)
    return f'"{"".join(escaped)}"'


def utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", "surrogatepass")


def js_number(value: int | float) -> str:
    numeric = float(value)
    if not (numeric == numeric and abs(numeric) != float("inf")):
        return "null"
    if numeric == 0:
        return "0"
    representation = repr(numeric).lower()
    if "e" not in representation:
        if representation.endswith(".0"):
            return representation[:-2]
        return representation
    mantissa, exponent_text = representation.split("e")
    exponent = int(exponent_text)
    negative = mantissa.startswith("-")
    unsigned = mantissa[1:] if negative else mantissa
    whole, _, fraction = unsigned.partition(".")
    digits = whole + fraction
    decimal_position = len(whole) + exponent
    sign = "-" if negative else ""
    if -6 < decimal_position <= 21:
        if decimal_position <= 0:
            return f"{sign}0.{('0' * -decimal_position)}{digits}"
        if decimal_position >= len(digits):
            return f"{sign}{digits}{'0' * (decimal_position - len(digits))}"
        return f"{sign}{digits[:decimal_position]}.{digits[decimal_position:]}"
    normalized = digits[0]
    if len(digits) > 1:
        normalized += f".{digits[1:]}"
    scientific_exponent = decimal_position - 1
    exponent_sign = "+" if scientific_exponent >= 0 else ""
    return f"{sign}{normalized}e{exponent_sign}{scientific_exponent}"


def canonical_json_text(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return js_string(value)
    if isinstance(value, list):
        return f"[{','.join(canonical_json_text(item) for item in value)}]"
    if isinstance(value, dict):
        members = [f"{js_string(key)}:{canonical_json_text(value[key])}" for key in sorted(value, key=utf16_sort_key)]
        return f"{{{','.join(members)}}}"
    raise AdapterError("JSON_VALUE_INVALID", "Value is outside the JSON data model")


def canonical_json(value: Any) -> bytes:
    return canonical_json_text(value).encode("utf-8")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def strict_json_loads(value: bytes) -> Any:
    def finite_float(raw: str) -> float:
        parsed = float(raw)
        if not math.isfinite(parsed):
            raise ValueError("non-finite JSON number")
        return parsed

    def finite_int(raw: str) -> int:
        parsed = int(raw)
        try:
            finite = math.isfinite(float(parsed))
        except OverflowError as error:
            raise ValueError("non-finite JSON number") from error
        if not finite:
            raise ValueError("non-finite JSON number")
        return parsed

    return json.loads(value, parse_float=finite_float, parse_int=finite_int,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))


def read_bounded_stdin() -> bytes:
    data = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(data) > MAX_STDIN_BYTES:
        raise AdapterError("REQUEST_TOO_LARGE", "Candidate request exceeds the adapter input ceiling")
    if not data:
        raise AdapterError("REQUEST_EMPTY", "Candidate request is empty")
    return data


def read_stable_regular(filename: Path, max_bytes: int, required_mode: int | None = None) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(filename, flags)
    except OSError as error:
        raise AdapterError("TRUSTED_INPUT_OPEN_FAILED", "Trusted input could not be opened without following links") from error
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size < 1
                or before.st_size > max_bytes or (required_mode is not None and stat.S_IMODE(before.st_mode) != required_mode)):
            raise AdapterError("TRUSTED_INPUT_INVALID", "Trusted input violates its file contract")
        data = bytearray()
        while len(data) <= max_bytes:
            chunk = os.read(descriptor, min(1024 * 1024, max_bytes + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise AdapterError("TRUSTED_INPUT_MUTATED", "Trusted input changed while it was read")
        if len(data) != before.st_size:
            raise AdapterError("TRUSTED_INPUT_INVALID", "Trusted input length changed while it was read")
        return bytes(data)
    finally:
        os.close(descriptor)


def digest_stable_regular(filename: Path, max_bytes: int, required_mode: int | None = None) -> tuple[int, str]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(filename, flags)
    except OSError as error:
        raise AdapterError("TRUSTED_INPUT_OPEN_FAILED", "Trusted input could not be opened without following links") from error
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size < 1
                or before.st_size > max_bytes or (required_mode is not None and stat.S_IMODE(before.st_mode) != required_mode)):
            raise AdapterError("TRUSTED_INPUT_INVALID", "Trusted input violates its file contract")
        digest = hashlib.sha256()
        observed = 0
        while observed <= max_bytes:
            chunk = os.read(descriptor, min(1024 * 1024, max_bytes + 1 - observed))
            if not chunk:
                break
            observed += len(chunk)
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise AdapterError("TRUSTED_INPUT_MUTATED", "Trusted input changed while it was read")
        if observed != before.st_size:
            raise AdapterError("TRUSTED_INPUT_INVALID", "Trusted input length changed while it was read")
        return observed, digest.hexdigest()
    finally:
        os.close(descriptor)


def require_canonical_real_path(filename: Path, *, directory: bool, required_mode: int | None = None) -> Path:
    if not filename.is_absolute() or Path(os.path.abspath(filename)) != filename:
        raise AdapterError("HANDOFF_PATH_MISMATCH", "Handoff paths must be canonical absolute paths")
    current = Path(filename.anchor)
    for component in filename.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except OSError as error:
            raise AdapterError("HANDOFF_PATH_MISMATCH", "Handoff path could not be inspected") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise AdapterError("HANDOFF_PATH_MISMATCH", "Handoff paths must not contain symbolic links")
    try:
        metadata = filename.stat()
        resolved = filename.resolve(strict=True)
    except OSError as error:
        raise AdapterError("HANDOFF_PATH_MISMATCH", "Handoff path could not be resolved") from error
    if resolved != filename or (directory and not stat.S_ISDIR(metadata.st_mode)) or (not directory and not stat.S_ISREG(metadata.st_mode)):
        raise AdapterError("HANDOFF_PATH_MISMATCH", "Handoff path type or identity is invalid")
    if required_mode is not None and stat.S_IMODE(metadata.st_mode) != required_mode:
        raise AdapterError("HANDOFF_PATH_MISMATCH", "Handoff path mode is invalid")
    return resolved


def verify_receipt_anchor(receipt_path: Path, expected_sha256: str, config_path: Path, artifacts_path: Path) -> dict[str, Any]:
    if not SHA256.fullmatch(expected_sha256):
        raise AdapterError("RECEIPT_TRUST_INVALID", "Expected handoff receipt digest is not SHA-256")
    receipt_bytes = read_stable_regular(receipt_path, MAX_RECEIPT_BYTES, 0o600)
    if sha256(receipt_bytes) != expected_sha256:
        raise AdapterError("RECEIPT_DIGEST_MISMATCH", "Handoff receipt does not match the out-of-band digest")
    try:
        receipt = strict_json_loads(receipt_bytes)
    except (json.JSONDecodeError, ValueError) as error:
        raise AdapterError("RECEIPT_INVALID", "Handoff receipt is not strict JSON") from error
    if receipt_bytes != canonical_json(receipt) + b"\n":
        raise AdapterError("RECEIPT_NONCANONICAL", "Handoff receipt bytes are not canonical")
    if (not isinstance(receipt, dict) or receipt.get("protocol") != "pdf-tools.docling-macos-handoff.v1"
            or receipt.get("execution_state") != "not_run" or not SHA256.fullmatch(str(receipt.get("handoff_id", "")))):
        raise AdapterError("RECEIPT_INVALID", "Handoff receipt identity is invalid")
    identity = receipt.get("identity")
    if (not isinstance(identity, dict)
            or sha256(b"pdf-tools.docling-macos-handoff.v1\0" + canonical_json(identity)) != receipt["handoff_id"]):
        raise AdapterError("RECEIPT_INVALID", "Handoff receipt identity digest is invalid")
    roots = receipt.get("roots")
    inputs = receipt.get("inputs")
    if not isinstance(roots, dict) or not isinstance(inputs, list):
        raise AdapterError("RECEIPT_INVALID", "Handoff receipt inventory is missing")
    snapshot = require_canonical_real_path(Path(roots.get("sidecar_snapshot", "")), directory=True, required_mode=0o700)
    by_role: dict[str, dict[str, Any]] = {}
    input_bytes_by_role: dict[str, bytes] = {}
    for item in inputs:
        if (not isinstance(item, dict) or set(item) != {"role", "filename", "bytes", "sha256"}
                or item.get("role") in by_role or not isinstance(item.get("filename"), str)
                or Path(item["filename"]).name != item["filename"] or type(item.get("bytes")) is not int
                or item["bytes"] < 1 or not SHA256.fullmatch(str(item.get("sha256", "")))):
            raise AdapterError("RECEIPT_INVALID", "Handoff receipt input inventory is invalid")
        by_role[item["role"]] = item
        input_path = snapshot / item["filename"]
        data = read_stable_regular(input_path, MAX_STDIN_BYTES, 0o600)
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise AdapterError("HANDOFF_INPUT_MISMATCH", "Retained handoff input does not match the anchored receipt")
        input_bytes_by_role[item["role"]] = data
    if set(by_role) != HANDOFF_INPUT_ROLES or identity.get("inputs") != inputs or identity.get("fixtures") != receipt.get("fixtures"):
        raise AdapterError("RECEIPT_INVALID", "Handoff receipt does not bind the exact retained inventories")
    expected_config = require_canonical_real_path(snapshot / by_role["candidate_config"]["filename"], directory=False, required_mode=0o600)
    expected_adapter = require_canonical_real_path(snapshot / by_role["adapter_entrypoint"]["filename"], directory=False, required_mode=0o600)
    observed_config = require_canonical_real_path(config_path, directory=False, required_mode=0o600)
    observed_adapter = require_canonical_real_path(Path(__file__), directory=False, required_mode=0o600)
    if observed_config != expected_config or observed_adapter != expected_adapter:
        raise AdapterError("HANDOFF_PATH_MISMATCH", "Adapter or configuration path is outside the anchored handoff")
    observed_artifacts = require_canonical_real_path(artifacts_path, directory=True, required_mode=0o700)
    expected_artifacts = require_canonical_real_path(Path(roots.get("models", "")), directory=True, required_mode=0o700)
    if observed_artifacts != expected_artifacts:
        raise AdapterError("HANDOFF_PATH_MISMATCH", "Model path is outside the anchored handoff")
    return {"receipt": receipt, "inputs_by_role": by_role, "input_bytes_by_role": input_bytes_by_role}


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


def bound_json_shape(value: Any, depth: int = 0, state: dict[str, int] | None = None) -> None:
    if state is None:
        state = {"nodes": 0}
    state["nodes"] += 1
    if depth > MAX_SCHEMA_DEPTH or state["nodes"] > MAX_SCHEMA_NODES:
        raise AdapterError("TARGET_SCHEMA_TOO_COMPLEX", "Target schema exceeds the adapter complexity ceiling")
    if isinstance(value, dict):
        for child in value.values():
            bound_json_shape(child, depth + 1, state)
    elif isinstance(value, list):
        for child in value:
            bound_json_shape(child, depth + 1, state)


def target_leaf_pointers(schema: Any, pointer: str = "", depth: int = 0,
                         state: dict[str, int] | None = None) -> list[str]:
    if state is None:
        state = {"leaves": 0}
    if depth > MAX_SCHEMA_DEPTH:
        raise AdapterError("TARGET_SCHEMA_TOO_COMPLEX", "Target schema exceeds the adapter depth ceiling")
    if not isinstance(schema, dict):
        raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema must be an object")
    for keyword in ("$ref", "allOf", "oneOf", "not", "if", "then", "else"):
        if keyword in schema:
            raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", f"Unsupported target schema construct: {keyword}")
    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        allowed_types = {"string", "number", "integer", "boolean", "null", "array", "object"}
        if (not schema_type or any(not isinstance(item, str) or item not in allowed_types for item in schema_type)
                or len(schema_type) != len(set(schema_type))):
            raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema type union is malformed")
        raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema type unions are outside the Phase 1 subset")
    if schema_type is not None and not isinstance(schema_type, str):
        raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema type must be a string")
    if schema_type == "object" or "properties" in schema:
        properties = schema.get("properties")
        if schema_type != "object" or schema.get("additionalProperties") is not False or not isinstance(properties, dict):
            raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Object schemas must be closed and declare properties")
        names = sorted(properties, key=utf16_sort_key)
        required = schema.get("required", [])
        if (not isinstance(required, list) or any(not isinstance(name, str) for name in required)
                or len(required) != len(names) or sorted(required, key=utf16_sort_key) != names):
            raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Every object property must be required")
        result: list[str] = []
        for name in names:
            result.extend(target_leaf_pointers(properties[name], f"{pointer}/{pointer_token(name)}", depth + 1, state))
        return result
    enum_value = schema.get("enum")
    if "enum" in schema and (not isinstance(enum_value, list) or not enum_value):
        raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema enum is malformed")
    any_of = schema.get("anyOf")
    if "anyOf" in schema and (not isinstance(any_of, list) or not any_of
            or any(not isinstance(branch, (dict, bool)) for branch in any_of)):
        raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema anyOf is malformed")
    if (schema_type in {"string", "number", "integer", "boolean", "null", "array"}
            or "const" in schema or isinstance(enum_value, list) or isinstance(any_of, list)):
        state["leaves"] += 1
        if state["leaves"] > MAX_SCHEMA_LEAVES:
            raise AdapterError("TARGET_SCHEMA_TOO_COMPLEX", "Target schema exceeds the adapter leaf ceiling")
        return [pointer]
    raise AdapterError("TARGET_SCHEMA_UNSUPPORTED", "Target schema leaf is outside the Phase 1 subset")


def validate_request(value: Any, raw_bytes: int) -> dict[str, Any]:
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
    if not isinstance(task.get("instruction"), str) or not task["instruction"]:
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Candidate instruction must be a nonempty string")
    bound_json_shape(task["target_schema"])
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
    if raw_bytes > limits["max_request_bytes"]:
        raise AdapterError("REQUEST_TOO_LARGE", "Candidate request exceeds its declared input ceiling")
    if type(source.get("size_bytes")) is not int or source["size_bytes"] < 1 or type(source.get("page_count")) is not int or source["page_count"] < 1:
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Source size and page count must be positive integers")
    if not isinstance(source.get("sha256"), str) or not SHA256.fullmatch(source["sha256"]):
        raise AdapterError("REQUEST_CONTRACT_INVALID", "Source digest is not SHA-256")
    if source["size_bytes"] > limits["max_source_bytes"] or source["page_count"] > limits["max_pages"]:
        raise AdapterError("SOURCE_LIMIT_EXCEEDED", "Source exceeds the requested candidate limits")
    target_leaf_pointers(task["target_schema"])
    return value


@contextmanager
def staged_source(request: dict[str, Any]):
    source_path = Path(request["source"]["path"])
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source_path, flags)
    except OSError as error:
        raise AdapterError("SOURCE_OPEN_FAILED", "Staged source could not be opened as a regular file") from error
    staging_root = Path(tempfile.mkdtemp(prefix="pdf-tools-docling-source-")).resolve(strict=True)
    os.chmod(staging_root, 0o700)
    private_path = staging_root / "source.pdf"
    torchinductor_cache = staging_root / TORCHINDUCTOR_CACHE_BASENAME
    destination = None
    try:
        destination = os.open(private_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o400)
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
            view = memoryview(chunk)
            while view:
                written = os.write(destination, view)
                if written < 1:
                    raise AdapterError("SOURCE_STAGE_FAILED", "Private source staging did not make progress")
                view = view[written:]
        os.fsync(destination)
        after = os.fstat(descriptor)
        if observed != expected_size or digest.hexdigest() != request["source"]["sha256"]:
            raise AdapterError("SOURCE_DIGEST_MISMATCH", "Staged source bytes do not match the runner binding")
        if (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise AdapterError("SOURCE_MUTATED", "Staged source changed while it was read")
        os.close(destination)
        destination = None
        private_size, private_digest = digest_stable_regular(private_path, expected_size, 0o400)
        if private_size != expected_size or private_digest != request["source"]["sha256"]:
            raise AdapterError("SOURCE_STAGE_FAILED", "Private source staging changed the verified bytes")
        try:
            os.mkdir(torchinductor_cache, 0o700)
            cache_metadata = os.lstat(torchinductor_cache)
            if (not stat.S_ISDIR(cache_metadata.st_mode) or stat.S_ISLNK(cache_metadata.st_mode)
                    or stat.S_IMODE(cache_metadata.st_mode) != 0o700 or cache_metadata.st_nlink < 1
                    or torchinductor_cache.resolve(strict=True) != torchinductor_cache
                    or torchinductor_cache.parent != staging_root):
                raise AdapterError("TORCHINDUCTOR_CACHE_INVALID", "Private TorchInductor cache is not an exact staging child")
        except OSError as error:
            raise AdapterError("TORCHINDUCTOR_CACHE_INVALID", "Private TorchInductor cache could not be created") from error
        had_torchinductor_cache = "TORCHINDUCTOR_CACHE_DIR" in os.environ
        previous_torchinductor_cache = os.environ.get("TORCHINDUCTOR_CACHE_DIR")
        os.environ["TORCHINDUCTOR_CACHE_DIR"] = str(torchinductor_cache)
        try:
            yield private_path
        finally:
            if had_torchinductor_cache:
                os.environ["TORCHINDUCTOR_CACHE_DIR"] = previous_torchinductor_cache
            else:
                os.environ.pop("TORCHINDUCTOR_CACHE_DIR", None)
    finally:
        if destination is not None:
            os.close(destination)
        os.close(descriptor)
        shutil.rmtree(staging_root)


def load_config(raw: bytes) -> dict[str, Any]:
    try:
        config = strict_json_loads(raw)
    except (json.JSONDecodeError, ValueError) as error:
        raise AdapterError("CONFIG_INVALID", "Pinned Docling configuration could not be loaded") from error
    if (not isinstance(config, dict) or config.get("config_id") != "pdf-tools.extraction-docling-candidate-config.v1"
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
    if (not artifacts_path.is_absolute() or not artifacts_path.is_dir() or artifacts_path.is_symlink()
            or stat.S_IMODE(artifacts_path.stat().st_mode) != 0o700):
        raise AdapterError("ARTIFACT_ROOT_INVALID", "Docling artifact root must be an absolute, existing real directory")
    inventory_path = artifacts_path / "layout-model-inventory.v1.json"
    try:
        inventory_bytes = read_stable_regular(inventory_path, MAX_MODEL_INVENTORY_BYTES, 0o600)
        inventory = strict_json_loads(inventory_bytes)
    except (json.JSONDecodeError, ValueError) as error:
        raise AdapterError("LAYOUT_INVENTORY_INVALID", "Pinned layout inventory is not strict JSON") from error
    if (not isinstance(inventory, dict)
            or set(inventory) != {"inventory_id", "repository", "revision", "files", "file_set_sha256", "networked_setup", "execution_state"}
            or inventory.get("inventory_id") != "pdf-tools.docling-layout-model-inventory.v1"
            or inventory.get("repository") != config["layout_model"]["repository"]
            or inventory.get("revision") != config["layout_model"]["revision"]
            or inventory.get("networked_setup") is not True or inventory.get("execution_state") != "not_run"
            or not isinstance(inventory.get("files"), list) or not 1 <= len(inventory["files"]) <= 10000):
        raise AdapterError("LAYOUT_INVENTORY_INVALID", "Pinned layout inventory identity is invalid")
    if inventory_bytes != (json.dumps(inventory, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode():
        raise AdapterError("LAYOUT_INVENTORY_INVALID", "Pinned layout inventory bytes are not canonical")
    if (not SHA256.fullmatch(str(inventory.get("file_set_sha256", "")))
            or hashlib.sha256(("pdf-tools.docling-layout-model-files.v1\0" + json.dumps(
                inventory["files"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))).encode()).hexdigest()
            != inventory["file_set_sha256"]):
        raise AdapterError("LAYOUT_INVENTORY_INVALID", "Pinned layout inventory digest is invalid")
    records: dict[str, dict[str, Any]] = {}
    total_bytes = 0
    for item in inventory["files"]:
        if (not isinstance(item, dict) or set(item) != {"relative_path", "bytes", "sha256"}
                or not isinstance(item.get("relative_path"), str) or not item["relative_path"]
                or Path(item["relative_path"]).is_absolute() or ".." in Path(item["relative_path"]).parts
                or item["relative_path"] in records or type(item.get("bytes")) is not int
                or not 1 <= item["bytes"] <= MAX_MODEL_FILE_BYTES
                or not SHA256.fullmatch(str(item.get("sha256", "")))):
            raise AdapterError("LAYOUT_INVENTORY_INVALID", "Pinned layout inventory contains an invalid record")
        total_bytes += item["bytes"]
        if total_bytes > MAX_MODEL_TOTAL_BYTES:
            raise AdapterError("LAYOUT_INVENTORY_INVALID", "Pinned layout inventory exceeds the aggregate byte ceiling")
        records[item["relative_path"]] = item
    observed_paths: set[str] = set()
    for root, directories, filenames in os.walk(artifacts_path, followlinks=False):
        root_path = Path(root)
        for name in directories:
            directory = root_path / name
            if directory.is_symlink() or stat.S_IMODE(directory.stat().st_mode) != 0o700:
                raise AdapterError("ARTIFACT_LINK_FORBIDDEN", "Docling artifact root contains a link or weak directory")
        for name in filenames:
            candidate = root_path / name
            if candidate.is_symlink():
                raise AdapterError("ARTIFACT_LINK_FORBIDDEN", "Docling artifact root contains a symbolic link")
            observed_paths.add(candidate.relative_to(artifacts_path).as_posix())
    if observed_paths != set(records) | {"layout-model-inventory.v1.json"}:
        raise AdapterError("LAYOUT_INVENTORY_INVALID", "Docling artifact root does not match its exact inventory")
    expected_bytes = config["layout_model"]["weight_bytes"]
    expected_sha = config["layout_model"]["weight_sha256"]
    matches: list[str] = []
    for relative_path, item in records.items():
        size, digest = digest_stable_regular(artifacts_path / relative_path, MAX_MODEL_FILE_BYTES, 0o600)
        if size != item["bytes"] or digest != item["sha256"]:
            raise AdapterError("LAYOUT_INVENTORY_INVALID", "Docling model file does not match its stable inventory")
        if size == expected_bytes and digest == expected_sha:
            matches.append(relative_path)
    if len(matches) != 1:
        raise AdapterError("LAYOUT_WEIGHT_IDENTITY_MISMATCH", "Exactly one pinned layout weight must be present")
    repository_path = artifacts_path / config["layout_model"]["repository"].replace("/", "--")
    for filename, digest_key in (("config.json", "config_sha256"), ("preprocessor_config.json", "preprocessor_config_sha256")):
        candidate = repository_path / filename
        size, digest = digest_stable_regular(candidate, MAX_MODEL_FILE_BYTES, 0o600)
        if size < 1 or digest != config["layout_model"][digest_key]:
            raise AdapterError("LAYOUT_CONFIG_IDENTITY_MISMATCH", f"Pinned layout {filename} is missing or changed")


def project_bbox(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling bbox is not an object")
    return {name: value.get(name) for name in ("l", "t", "r", "b", "coord_origin")}


def project_provenance(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling provenance is not an object")
    return {
        "page_no": value.get("page_no"),
        "bbox": project_bbox(value.get("bbox")),
        "charspan": value.get("charspan"),
    }


def project_docling_export(document: Any) -> dict[str, Any]:
    """Return only the scrubbed DoclingDocument fields consumed by this adapter."""
    if not isinstance(document, dict):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling export must be an object")
    if document.get("schema_name") != "DoclingDocument" or document.get("version") != "1.10.0":
        raise AdapterError("DOCLING_EXPORT_VERSION_MISMATCH", "Docling export schema identity does not match the pinned adapter contract")
    if not isinstance(document.get("name"), str) or not document["name"]:
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling export name is invalid")
    raw_pages = document.get("pages")
    raw_texts = document.get("texts")
    raw_tables = document.get("tables")
    if not isinstance(raw_pages, dict) or not isinstance(raw_texts, list) or not isinstance(raw_tables, list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling export collections are invalid")
    pages: dict[str, Any] = {}
    for key, page in raw_pages.items():
        if not isinstance(key, str) or not isinstance(page, dict) or not isinstance(page.get("size"), dict):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling page projection is invalid")
        pages[key] = {
            "page_no": page.get("page_no"),
            "size": {"width": page["size"].get("width"), "height": page["size"].get("height")},
        }
    texts: list[dict[str, Any]] = []
    for text_item in raw_texts:
        if (not isinstance(text_item, dict) or not isinstance(text_item.get("self_ref"), str)
                or not isinstance(text_item.get("text"), str) or not isinstance(text_item.get("prov"), list)):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling text projection is invalid")
        projected_text = {
            "self_ref": text_item["self_ref"],
            "text": text_item["text"],
            "prov": [project_provenance(item) for item in text_item["prov"]],
        }
        if "content_layer" in text_item:
            if not isinstance(text_item["content_layer"], str):
                raise AdapterError("DOCLING_EXPORT_INVALID", "Docling text content layer is invalid")
            projected_text["content_layer"] = text_item["content_layer"]
        texts.append(projected_text)
    tables: list[dict[str, Any]] = []
    for table_item in raw_tables:
        if (not isinstance(table_item, dict) or not isinstance(table_item.get("self_ref"), str)
                or not isinstance(table_item.get("prov"), list) or not isinstance(table_item.get("data"), dict)):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table projection is invalid")
        data = table_item["data"]
        cells = data.get("table_cells")
        if not isinstance(cells, list):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table-cell projection is invalid")
        projected_cells: list[dict[str, Any]] = []
        for cell in cells:
            if not isinstance(cell, dict) or not isinstance(cell.get("text"), str):
                raise AdapterError("DOCLING_EXPORT_INVALID", "Pinned Docling table cell text must be a required string")
            projected_cell = {
                "bbox": project_bbox(cell.get("bbox")),
                "row_span": cell.get("row_span"),
                "col_span": cell.get("col_span"),
                "start_row_offset_idx": cell.get("start_row_offset_idx"),
                "end_row_offset_idx": cell.get("end_row_offset_idx"),
                "start_col_offset_idx": cell.get("start_col_offset_idx"),
                "end_col_offset_idx": cell.get("end_col_offset_idx"),
                "text": cell["text"],
            }
            if "page_no" in cell:
                projected_cell["page_no"] = cell["page_no"]
            projected_cells.append(projected_cell)
        tables.append({
            "self_ref": table_item["self_ref"],
            "prov": [project_provenance(item) for item in table_item["prov"]],
            "data": {
                "num_rows": data.get("num_rows"),
                "num_cols": data.get("num_cols"),
                "table_cells": projected_cells,
            },
        })
    projection = {
        "schema_name": "DoclingDocument",
        "version": "1.10.0",
        "name": document["name"],
        "pages": pages,
        "texts": texts,
        "tables": tables,
    }
    if "_oda_body_page_texts" in document:
        projection["_oda_body_page_texts"] = document["_oda_body_page_texts"]
    return projection


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
                or not isinstance(width, (int, float)) or not isinstance(height, (int, float))
                or not math.isfinite(float(width)) or not math.isfinite(float(height)) or width <= 0 or height <= 0):
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
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) for value in values):
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


class TranslationBudget:
    def __init__(self, max_report_bytes: int, max_stdout_bytes: int):
        self.limit = max(0, min(max_report_bytes, max_stdout_bytes) - RESPONSE_ENVELOPE_RESERVE_BYTES)
        self.used = 0
        self.items = 0

    def consume(self, text: str = "", overhead: int = 256) -> None:
        self.items += 1
        self.used += overhead + len(text.encode("utf-8"))
        if self.items > 100000 or self.used > self.limit:
            raise AdapterError("DOCLING_EXPORT_LIMIT_EXCEEDED", "Docling export exceeds the bounded translation budget")

    def collection(self, value: list[Any]) -> None:
        if len(value) > min(100000, max(1, self.limit // 64)):
            raise AdapterError("DOCLING_EXPORT_LIMIT_EXCEEDED", "Docling export collection exceeds the bounded translation budget")


def native_record(item_id: str, page: int, bbox: Any, quote: str, native_ref: Any,
                  geometry: dict[str, float], engine_version: str, budget: TranslationBudget) -> dict[str, Any]:
    budget.consume(quote if isinstance(quote, str) else "", 512)
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
    if not isinstance(cell.get("text"), str):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Pinned Docling table cell text must be a required string")
    return True, cell["text"]


def translate_table(table: dict[str, Any], index: int, pages: dict[int, dict[str, float]],
                    engine_version: str, budget: TranslationBudget) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    data = table.get("data")
    if not isinstance(data, dict) or type(data.get("num_rows")) is not int or type(data.get("num_cols")) is not int:
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table dimensions are missing")
    rows, columns = data["num_rows"], data["num_cols"]
    if not isinstance(data.get("table_cells", []), list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table dimensions or cells are invalid")
    budget.collection(data.get("table_cells", []))
    if rows < 0 or columns < 0 or rows * columns > min(100000, max(1, budget.limit // 16)):
        raise AdapterError("DOCLING_EXPORT_LIMIT_EXCEEDED", "Docling table grid exceeds the bounded translation budget")
    cells: list[dict[str, Any]] = []
    occupied: set[tuple[int, int]] = set()
    merged: list[dict[str, int]] = []
    native: list[dict[str, Any]] = []
    table_pages: set[int] = set()
    table_ref = table.get("self_ref")
    provenance_items = table.get("prov", [])
    if not isinstance(provenance_items, list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table provenance is invalid")
    budget.collection(provenance_items)
    for prov_index, provenance in enumerate(provenance_items):
        if not isinstance(provenance, dict) or type(provenance.get("page_no")) is not int or provenance["page_no"] not in pages:
            raise AdapterError("PAGE_BINDING_MISMATCH", "Docling table provenance references an unknown page")
        page = provenance["page_no"]
        table_pages.add(page)
        native.append(native_record(f"docling.table.{index}.prov.{prov_index}", page, provenance.get("bbox"), "", table_ref, pages[page], engine_version, budget))
    if not table_pages:
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table has no page provenance")
    if rows == 0 and columns == 0 and not data.get("table_cells"):
        return None, native
    if rows < 1 or columns < 1:
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table dimensions are inconsistent")
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
        budget.consume(value, 256)
        cells.append(translated)
        if row_span > 1 or column_span > 1:
            merged.append({
                "start_row": start_row + 1, "start_column": start_column + 1,
                "end_row": end_row, "end_column": end_column,
            })
        if cell.get("bbox") is not None:
            cell_page = cell.get("page_no")
            if cell_page is None and len(table_pages) == 1:
                cell_page = next(iter(table_pages))
            if type(cell_page) is not int or cell_page not in table_pages:
                continue
            native.append(native_record(
                f"docling.table.{index}.cell.{cell_index}", cell_page, cell["bbox"],
                value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                f"{table_ref or '#/tables/' + str(index)}/data/table_cells/{cell_index}",
                pages[cell_page], engine_version, budget,
            ))
    result = {
        "id": safe_id(f"docling.table.{index}"), "pages": sorted(table_pages),
        "row_count": rows, "column_count": columns, "merged_regions": merged, "cells": cells,
    }
    return result, native


def translate_export(document: dict[str, Any], request: dict[str, Any], engine_version: str) -> dict[str, Any]:
    document = project_docling_export(document)
    pages = page_map(document, request["source"]["page_count"])
    budget = TranslationBudget(
        request["limits"]["max_report_bytes"],
        request["limits"]["max_stdout_bytes"],
    )
    page_chunks: dict[int, list[str]] = {page: [] for page in pages}
    native: list[dict[str, Any]] = []
    texts = document.get("texts", [])
    if not isinstance(texts, list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling text collection is invalid")
    budget.collection(texts)
    for item_index, item in enumerate(texts):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not isinstance(item.get("prov", []), list):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling text item is invalid")
        text = item["text"]
        provenance_items = item.get("prov", [])
        budget.collection(provenance_items)
        for prov_index, provenance in enumerate(provenance_items):
            if not isinstance(provenance, dict) or type(provenance.get("page_no")) is not int or provenance["page_no"] not in pages:
                raise AdapterError("PAGE_BINDING_MISMATCH", "Docling text provenance references an unknown page")
            page = provenance["page_no"]
            charspan = provenance.get("charspan")
            if (not isinstance(charspan, list) or len(charspan) != 2 or any(type(value) is not int for value in charspan)
                    or charspan[0] < 0 or charspan[1] <= charspan[0] or charspan[1] > len(text)):
                raise AdapterError("DOCLING_EXPORT_INVALID", "Docling text provenance charspan is invalid")
            quote = text[charspan[0]:charspan[1]]
            native.append(native_record(
                f"docling.text.{item_index}.prov.{prov_index}", page, provenance.get("bbox"), quote,
                item.get("self_ref"), pages[page], engine_version, budget,
            ))
            if item.get("content_layer", "body") == "body":
                page_chunks[page].append(quote)
    exported_page_texts = document.get("_oda_body_page_texts")
    if exported_page_texts is not None:
        if (not isinstance(exported_page_texts, dict) or set(exported_page_texts) != {str(page) for page in pages}
                or any(not isinstance(value, str) for value in exported_page_texts.values())):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling BODY page-text export is invalid")
        page_chunks = {page: [exported_page_texts[str(page)]] for page in pages}
        for value in exported_page_texts.values():
            budget.consume(value, 256)
    tables: list[dict[str, Any]] = []
    exported_tables = document.get("tables", [])
    if not isinstance(exported_tables, list):
        raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table collection is invalid")
    budget.collection(exported_tables)
    for table_index, table in enumerate(exported_tables):
        if not isinstance(table, dict):
            raise AdapterError("DOCLING_EXPORT_INVALID", "Docling table item is invalid")
        translated, table_native = translate_table(table, table_index, pages, engine_version, budget)
        if translated is not None:
            tables.append(translated)
        native.extend(table_native)
    page_texts = [{
        "page": page, "text": "\n".join(page_chunks[page]), "text_kind": "visual_parser",
        "source_item_ids": [], "origin": {"engine_id": ENGINE_ID, "engine_version": engine_version},
    } for page in sorted(pages)]
    pointers = target_leaf_pointers(request["task"]["target_schema"])
    budget.collection(pointers)
    gaps = [{
        "field_path": pointer, "reason": "unsupported_modality",
        "detail": "Parser-only Docling lane does not answer arbitrary target schemas",
    } for pointer in pointers]
    return {
        "protocol": PROTOCOL, "request_id": request["request_id"], "status": "abstained", "decision": "abstain",
        "structured_candidate": None, "page_texts": page_texts, "tables": tables,
        "native_evidence": native, "evidence": [], "field_evidence": [], "gaps": gaps,
        "diagnostics": {"code": None, "message": None},
    }


def require_conversion_success(status: Any) -> None:
    raw = getattr(status, "value", status)
    normalized = str(raw).strip().lower()
    if normalized not in {"success", "conversionstatus.success"}:
        bounded = re.sub(r"[^a-z0-9_.-]", "_", normalized)[:64] or "unknown"
        raise AdapterError("DOCLING_CONVERSION_INCOMPLETE", f"Docling conversion did not complete successfully ({bounded})")


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
        require_conversion_success(conversion.status)
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
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--expected-receipt-sha256", required=True)
    parser.add_argument("--translate-export", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--test-conversion-status", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    request: dict[str, Any] | None = None
    try:
        raw_request = read_bounded_stdin()
        parsed_request = strict_json_loads(raw_request)
        if (isinstance(parsed_request, dict) and isinstance(parsed_request.get("request_id"), str)
                and SHA256.fullmatch(parsed_request["request_id"]) and isinstance(parsed_request.get("limits"), dict)
                and type(parsed_request["limits"].get("max_stdout_bytes")) is int
                and 1024 <= parsed_request["limits"]["max_stdout_bytes"] <= 16777216):
            request = parsed_request
        request = validate_request(parsed_request, len(raw_request))
        config_path = args.config if args.config.is_absolute() else Path.cwd() / args.config
        artifacts_path = args.artifacts_path if args.artifacts_path.is_absolute() else Path.cwd() / args.artifacts_path
        receipt_path = args.receipt if args.receipt.is_absolute() else Path.cwd() / args.receipt
        anchor = verify_receipt_anchor(receipt_path, args.expected_receipt_sha256, config_path, artifacts_path)
        config = load_config(anchor["input_bytes_by_role"]["candidate_config"])
        with staged_source(request) as source_path:
            if args.translate_export is not None:
                if os.environ.get("PDF_TOOLS_DOCLING_TEST_EXPORT") != "1":
                    raise AdapterError("TEST_SEAM_FORBIDDEN", "Synthetic export translation is available only to the adapter test harness")
                if args.test_conversion_status is not None:
                    require_conversion_success(args.test_conversion_status)
                try:
                    document = strict_json_loads(read_stable_regular(args.translate_export, request["limits"]["max_report_bytes"]))
                except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
                    raise AdapterError("DOCLING_EXPORT_INVALID", "Synthetic Docling export is not strict JSON") from error
            else:
                if args.test_conversion_status is not None:
                    raise AdapterError("TEST_SEAM_FORBIDDEN", "Synthetic conversion status is available only with the export test seam")
                document = run_docling(source_path, artifacts_path, config, request)
        engine_version = next(item["version"] for item in config["packages"] if item["name"] == "docling-slim")
        response = translate_export(document, request, engine_version)
        emit(response, request["limits"]["max_stdout_bytes"])
        return 0
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
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
