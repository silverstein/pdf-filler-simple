#!/usr/bin/env python3
"""Networked setup helper for one exact Docling layout-model revision."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest_file(filename: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(filename, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RuntimeError("model artifact is not a single-link regular file")
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b""):
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("model artifact changed while it was hashed")
        return metadata.st_size, digest.hexdigest()
    finally:
        os.close(descriptor)


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--models-path", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = arguments()
    config = json.loads(args.config.read_bytes())
    model = config["layout_model"]
    models_path = args.models_path.resolve(strict=True)
    if not models_path.is_dir() or models_path.is_symlink() or (models_path.stat().st_mode & 0o777) != 0o700:
        raise RuntimeError("models path must be a real mode-0700 directory")
    if any(models_path.iterdir()):
        raise RuntimeError("models path must be empty before pinned model setup")
    from huggingface_hub import snapshot_download
    repository_path = models_path / model["repository"].replace("/", "--")
    snapshot_download(repo_id=model["repository"], revision=model["revision"], local_dir=repository_path)
    files = []
    for candidate in sorted(repository_path.rglob("*")):
        if candidate.is_symlink():
            raise RuntimeError("downloaded model snapshot contains a symbolic link")
        if candidate.is_file():
            size, digest = digest_file(candidate)
            files.append({"relative_path": candidate.relative_to(models_path).as_posix(), "bytes": size, "sha256": digest})
    matching_weights = [item for item in files if item["bytes"] == model["weight_bytes"] and item["sha256"] == model["weight_sha256"]]
    if len(matching_weights) != 1:
        raise RuntimeError("downloaded snapshot does not contain exactly one pinned layout weight")
    by_path = {item["relative_path"]: item for item in files}
    repository_prefix = model["repository"].replace("/", "--")
    for filename, digest_key in (("config.json", "config_sha256"), ("preprocessor_config.json", "preprocessor_config_sha256")):
        observed = by_path.get(f"{repository_prefix}/{filename}")
        if observed is None or observed["sha256"] != model[digest_key]:
            raise RuntimeError(f"downloaded snapshot has the wrong {filename}")
    inventory = {
        "inventory_id": "pdf-tools.docling-layout-model-inventory.v1",
        "repository": model["repository"],
        "revision": model["revision"],
        "files": files,
        "file_set_sha256": hashlib.sha256(("pdf-tools.docling-layout-model-files.v1\0" + canonical_json(files)).encode()).hexdigest(),
        "networked_setup": True,
        "execution_state": "not_run",
    }
    inventory_path = models_path / "layout-model-inventory.v1.json"
    descriptor = os.open(inventory_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.write(descriptor, (canonical_json(inventory) + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    print(json.dumps({"inventory_path": str(inventory_path), "file_set_sha256": inventory["file_set_sha256"]}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Pinned layout setup failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
