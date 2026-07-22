#!/usr/bin/env python3
"""Networked setup helper for one exact, content-addressed Docling layout model."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_CONFIG_BYTES = 1024 * 1024
MAX_INVENTORY_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_regular(filename: Path, max_bytes: int, required_mode: int | None = None) -> bytes:
    descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 1 <= before.st_size <= max_bytes
                or (required_mode is not None and stat.S_IMODE(before.st_mode) != required_mode)):
            raise RuntimeError("trusted setup input violates its file contract")
        data = bytearray()
        while len(data) <= max_bytes:
            chunk = os.read(descriptor, min(1024 * 1024, max_bytes + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("trusted setup input changed while read")
        if len(data) != before.st_size:
            raise RuntimeError("trusted setup input length changed while read")
        return bytes(data)
    finally:
        os.close(descriptor)


def digest_file(filename: Path) -> tuple[int, str]:
    descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or not 1 <= metadata.st_size <= MAX_FILE_BYTES
                or stat.S_IMODE(metadata.st_mode) != 0o600):
            raise RuntimeError("model artifact is not a bounded mode-0600 single-link regular file")
        digest = hashlib.sha256()
        observed = 0
        while observed <= MAX_FILE_BYTES:
            chunk = os.read(descriptor, min(1024 * 1024, MAX_FILE_BYTES + 1 - observed))
            if not chunk:
                break
            observed += len(chunk)
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("model artifact changed while it was hashed")
        if observed != metadata.st_size:
            raise RuntimeError("model artifact length changed while it was hashed")
        return metadata.st_size, digest.hexdigest()
    finally:
        os.close(descriptor)


def scan_files(models_path: Path, normalize_modes: bool = False) -> list[dict]:
    files = []
    total = 0
    for root, directories, filenames in os.walk(models_path, followlinks=False):
        root_path = Path(root)
        for name in directories:
            directory = root_path / name
            if directory.is_symlink():
                raise RuntimeError("model snapshot contains a symbolic-link directory")
            if normalize_modes:
                os.chmod(directory, 0o700)
            elif stat.S_IMODE(directory.stat().st_mode) != 0o700:
                raise RuntimeError("model snapshot directory is not mode-0700")
        for name in sorted(filenames):
            candidate = root_path / name
            relative = candidate.relative_to(models_path).as_posix()
            if relative == "layout-model-inventory.v1.json":
                continue
            if candidate.is_symlink():
                raise RuntimeError("model snapshot contains a symbolic link")
            if normalize_modes:
                os.chmod(candidate, 0o600)
            size, digest = digest_file(candidate)
            total += size
            if total > MAX_TOTAL_BYTES or len(files) >= 10000:
                raise RuntimeError("model snapshot exceeds its bounded inventory contract")
            files.append({"relative_path": relative, "bytes": size, "sha256": digest})
    return sorted(files, key=lambda item: item["relative_path"])


def validate_inventory(models_path: Path, model: dict, inventory: dict) -> dict:
    if (not isinstance(inventory, dict)
            or set(inventory) != {"inventory_id", "repository", "revision", "files", "file_set_sha256", "networked_setup", "execution_state"}
            or inventory.get("inventory_id") != "pdf-tools.docling-layout-model-inventory.v1"
            or inventory.get("repository") != model["repository"] or inventory.get("revision") != model["revision"]
            or inventory.get("networked_setup") is not True or inventory.get("execution_state") != "not_run"
            or not isinstance(inventory.get("files"), list) or not inventory["files"]):
        raise RuntimeError("model inventory identity is invalid")
    observed = scan_files(models_path)
    if observed != inventory["files"]:
        raise RuntimeError("model files do not match their stable inventory")
    expected_file_set = hashlib.sha256(("pdf-tools.docling-layout-model-files.v1\0" + canonical_json(observed)).encode()).hexdigest()
    if inventory.get("file_set_sha256") != expected_file_set:
        raise RuntimeError("model inventory file-set digest is invalid")
    matching_weights = [item for item in observed if item["bytes"] == model["weight_bytes"] and item["sha256"] == model["weight_sha256"]]
    if len(matching_weights) != 1:
        raise RuntimeError("model snapshot does not contain exactly one pinned layout weight")
    by_path = {item["relative_path"]: item for item in observed}
    repository_prefix = model["repository"].replace("/", "--")
    for filename, digest_key in (("config.json", "config_sha256"), ("preprocessor_config.json", "preprocessor_config_sha256")):
        record = by_path.get(f"{repository_prefix}/{filename}")
        if record is None or record["sha256"] != model[digest_key]:
            raise RuntimeError(f"model snapshot has the wrong {filename}")
    return inventory


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--expected-config-sha256", required=True)
    parser.add_argument("--models-path", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = arguments()
    if not SHA256.fullmatch(args.expected_config_sha256):
        raise RuntimeError("expected config SHA-256 is invalid")
    config_bytes = read_regular(args.config, MAX_CONFIG_BYTES, 0o600)
    if hashlib.sha256(config_bytes).hexdigest() != args.expected_config_sha256:
        raise RuntimeError("config does not match its receipt-bound SHA-256")
    config = json.loads(config_bytes, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
    model = config["layout_model"]
    models_path = args.models_path.resolve(strict=True)
    if (not models_path.is_dir() or models_path.is_symlink() or (models_path.stat().st_mode & 0o777) != 0o700):
        raise RuntimeError("models path must be a real mode-0700 directory")
    inventory_path = models_path / "layout-model-inventory.v1.json"
    if any(models_path.iterdir()):
        inventory_bytes = read_regular(inventory_path, MAX_INVENTORY_BYTES, 0o600)
        inventory = json.loads(inventory_bytes, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
        if inventory_bytes != (canonical_json(inventory) + "\n").encode():
            raise RuntimeError("existing model inventory is not canonical")
        validate_inventory(models_path, model, inventory)
        print(json.dumps({"inventory_path": str(inventory_path), "file_set_sha256": inventory["file_set_sha256"], "reused": True}, separators=(",", ":")))
        return 0

    from huggingface_hub import snapshot_download
    repository_path = models_path / model["repository"].replace("/", "--")
    snapshot_download(repo_id=model["repository"], revision=model["revision"], local_dir=repository_path)
    files = scan_files(models_path, normalize_modes=True)
    inventory = {
        "inventory_id": "pdf-tools.docling-layout-model-inventory.v1",
        "repository": model["repository"],
        "revision": model["revision"],
        "files": files,
        "file_set_sha256": hashlib.sha256(("pdf-tools.docling-layout-model-files.v1\0" + canonical_json(files)).encode()).hexdigest(),
        "networked_setup": True,
        "execution_state": "not_run",
    }
    validate_inventory(models_path, model, inventory)
    descriptor = os.open(inventory_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.write(descriptor, (canonical_json(inventory) + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    print(json.dumps({"inventory_path": str(inventory_path), "file_set_sha256": inventory["file_set_sha256"], "reused": False}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Pinned layout setup failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
