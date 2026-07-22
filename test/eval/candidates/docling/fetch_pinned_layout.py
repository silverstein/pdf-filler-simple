#!/usr/bin/env python3
"""Networked setup helper for one exact, content-addressed Docling layout model."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile


SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_CONFIG_BYTES = 1024 * 1024
MAX_INVENTORY_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_CACHE_ENTRIES = 100000
MAX_CACHE_DEPTH = 128


def publish_fresh(staging: Path, target: Path) -> None:
    """Atomically publish a directory while refusing a concurrently-created target."""
    libc = ctypes.CDLL(None, use_errno=True)
    source = os.fsencode(staging)
    destination = os.fsencode(target)
    if sys.platform == "darwin":
        operation = libc.renamex_np
        operation.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        operation.restype = ctypes.c_int
        result = operation(source, destination, 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        operation = getattr(libc, "renameat2", None)
        if operation is None:
            raise RuntimeError("atomic no-replace publication is unavailable")
        operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        operation.restype = ctypes.c_int
        result = operation(-100, source, -100, destination, 0x00000001)  # AT_FDCWD, RENAME_NOREPLACE
    else:
        raise RuntimeError("atomic no-replace publication is unsupported on this platform")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), target)


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def within(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_private_empty_cache(cache_path: Path) -> tuple[int, int]:
    if not cache_path.is_absolute() or Path(os.path.abspath(cache_path)) != cache_path:
        raise RuntimeError("HF cache path must be canonical absolute")
    metadata = cache_path.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700
            or cache_path.is_symlink() or cache_path.resolve(strict=True) != cache_path):
        raise RuntimeError("HF cache path must be a real mode-0700 directory")
    configured = os.environ.get("HF_HOME")
    if configured != str(cache_path):
        raise RuntimeError("HF_HOME does not match the receipt-bound cache path")
    isolation_paths = []
    for name in ("HOME", "TMPDIR"):
        value = os.environ.get(name)
        if value is None:
            raise RuntimeError(f"{name} is required for cache isolation")
        candidate = Path(value)
        if not candidate.is_absolute() or Path(os.path.abspath(candidate)) != candidate:
            raise RuntimeError(f"{name} must be canonical absolute")
        candidate_metadata = candidate.lstat()
        if (not stat.S_ISDIR(candidate_metadata.st_mode) or stat.S_IMODE(candidate_metadata.st_mode) != 0o700
                or candidate.is_symlink() or candidate.resolve(strict=True) != candidate):
            raise RuntimeError(f"{name} must be a real mode-0700 directory")
        isolation_paths.append(candidate)
    for other in isolation_paths:
        if within(other, cache_path) or within(cache_path, other):
            raise RuntimeError("HF cache path must be disjoint from HOME and TMPDIR")
    if any(cache_path.iterdir()):
        raise RuntimeError("HF cache path must be empty before setup")
    return metadata.st_dev, metadata.st_ino


def clear_cache_directory(descriptor: int, budget: list[int], depth: int = 0) -> None:
    if depth > MAX_CACHE_DEPTH:
        raise RuntimeError("HF cache cleanup exceeds its depth ceiling")
    for name in os.listdir(descriptor):
        budget[0] -= 1
        if budget[0] < 0:
            raise RuntimeError("HF cache cleanup exceeds its entry ceiling")
        before = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        if stat.S_ISDIR(before.st_mode):
            child = os.open(name, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0), dir_fd=descriptor)
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    raise RuntimeError("HF cache directory was substituted during cleanup")
                clear_cache_directory(child, budget, depth + 1)
                after = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if (after.st_dev, after.st_ino) != (opened.st_dev, opened.st_ino):
                    raise RuntimeError("HF cache directory was substituted during cleanup")
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=descriptor)
        else:
            os.unlink(name, dir_fd=descriptor)
    os.fsync(descriptor)


def clear_private_cache(cache_path: Path, identity: tuple[int, int]) -> None:
    descriptor = os.open(cache_path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISDIR(metadata.st_mode) or (metadata.st_dev, metadata.st_ino) != identity):
            raise RuntimeError("HF cache root was substituted during setup")
        clear_cache_directory(descriptor, [MAX_CACHE_ENTRIES])
        if os.listdir(descriptor):
            raise RuntimeError("HF cache root did not return to its empty private state")
    finally:
        os.close(descriptor)
    after = cache_path.lstat()
    if (cache_path.is_symlink() or cache_path.resolve(strict=True) != cache_path
            or stat.S_IMODE(after.st_mode) != 0o700 or (after.st_dev, after.st_ino) != identity):
        raise RuntimeError("HF cache root was substituted during setup")


def remove_local_download_metadata(repository_path: Path) -> None:
    repository_metadata = repository_path.lstat()
    if (repository_path.is_symlink() or not stat.S_ISDIR(repository_metadata.st_mode)
            or repository_path.resolve(strict=True) != repository_path):
        raise RuntimeError("model repository download path is not a real directory")
    cache_path = repository_path / ".cache"
    if not cache_path.exists() and not cache_path.is_symlink():
        return
    cache_metadata = cache_path.lstat()
    if cache_path.is_symlink() or not stat.S_ISDIR(cache_metadata.st_mode):
        raise RuntimeError("model download .cache is not a real directory")
    cache_entries = list(cache_path.iterdir())
    if len(cache_entries) != 1 or cache_entries[0].name != "huggingface":
        raise RuntimeError("model download .cache contains unexpected entries")
    huggingface_path = cache_entries[0]
    huggingface_metadata = huggingface_path.lstat()
    if huggingface_path.is_symlink() or not stat.S_ISDIR(huggingface_metadata.st_mode):
        raise RuntimeError("model download Hugging Face metadata is not a real directory")
    for root, directories, filenames in os.walk(huggingface_path, followlinks=False):
        root_path = Path(root)
        for name in directories:
            directory = root_path / name
            if directory.is_symlink() or not stat.S_ISDIR(directory.lstat().st_mode):
                raise RuntimeError("model download metadata contains an unexpected directory")
        for name in filenames:
            candidate = root_path / name
            metadata = candidate.lstat()
            if (candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                    or not (name == ".gitignore" or name.endswith((".metadata", ".lock", ".incomplete")))):
                raise RuntimeError("model download metadata contains an unexpected file")
    shutil.rmtree(huggingface_path)
    cache_path.rmdir()
    fsync_directory(repository_path)


def write_exclusive(filename: Path, value: bytes) -> None:
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        offset = 0
        while offset < len(value):
            written = os.write(descriptor, value[offset:])
            if written < 1:
                raise RuntimeError("exclusive setup write made no progress")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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
    parser.add_argument("--hf-cache-path", required=True, type=Path)
    return parser.parse_args()


def setup(args) -> int:
    if not SHA256.fullmatch(args.expected_config_sha256):
        raise RuntimeError("expected config SHA-256 is invalid")
    config_bytes = read_regular(args.config, MAX_CONFIG_BYTES, 0o600)
    if hashlib.sha256(config_bytes).hexdigest() != args.expected_config_sha256:
        raise RuntimeError("config does not match its receipt-bound SHA-256")
    config = json.loads(config_bytes, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
    model = config["layout_model"]
    models_path = args.models_path
    if not models_path.is_absolute() or Path(os.path.abspath(models_path)) != models_path:
        raise RuntimeError("models path must be canonical absolute")
    parent = models_path.parent
    parent_real = parent.resolve(strict=True)
    if parent_real != parent or parent.is_symlink() or not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) != 0o700:
        raise RuntimeError("models parent must be a real mode-0700 directory")
    intent_path = parent / f".{models_path.name}.publication-intent.v1.json"
    if models_path.exists() or models_path.is_symlink():
        if not intent_path.exists() or intent_path.is_symlink():
            raise RuntimeError("fresh content-addressed models target must not already exist")
        target_metadata = models_path.lstat()
        if (not stat.S_ISDIR(target_metadata.st_mode) or stat.S_IMODE(target_metadata.st_mode) != 0o700
                or models_path.resolve(strict=True) != models_path):
            raise RuntimeError("published model recovery target is not a real mode-0700 directory")
        intent_bytes = read_regular(intent_path, MAX_INVENTORY_BYTES, 0o600)
        intent = json.loads(intent_bytes, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
        inventory_path = models_path / "layout-model-inventory.v1.json"
        inventory_bytes = read_regular(inventory_path, MAX_INVENTORY_BYTES, 0o600)
        inventory = json.loads(inventory_bytes, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
        expected_intent = {
            "protocol": "pdf-tools.docling-model-publication-intent.v1",
            "target": str(models_path),
            "config_sha256": args.expected_config_sha256,
            "file_set_sha256": inventory.get("file_set_sha256"),
        }
        if intent_bytes != (canonical_json(intent) + "\n").encode() or intent != expected_intent:
            raise RuntimeError("published model recovery intent is invalid")
        validate_inventory(models_path, model, inventory)
        fsync_directory(parent)
        os.unlink(intent_path)
        try:
            fsync_directory(parent)
        except OSError:
            pass  # The target was already durably reconciled; a stale intent is safe to revalidate.
        print(json.dumps({"inventory_path": str(inventory_path), "file_set_sha256": inventory["file_set_sha256"], "reused": False, "recovered_after_parent_fsync": True}, separators=(",", ":")))
        return 0
    if intent_path.exists() or intent_path.is_symlink():
        raise RuntimeError("model publication intent exists without its published target")

    staging = Path(tempfile.mkdtemp(prefix=f".{models_path.name}.staging-", dir=parent))
    os.chmod(staging, 0o700)
    try:
        from huggingface_hub import snapshot_download
        repository_path = staging / model["repository"].replace("/", "--")
        snapshot_download(repo_id=model["repository"], revision=model["revision"], local_dir=repository_path)
        remove_local_download_metadata(repository_path)
        files = scan_files(staging, normalize_modes=True)
        inventory = {
            "inventory_id": "pdf-tools.docling-layout-model-inventory.v1",
            "repository": model["repository"],
            "revision": model["revision"],
            "files": files,
            "file_set_sha256": hashlib.sha256(("pdf-tools.docling-layout-model-files.v1\0" + canonical_json(files)).encode()).hexdigest(),
            "networked_setup": True,
            "execution_state": "not_run",
        }
        validate_inventory(staging, model, inventory)
        inventory_path = staging / "layout-model-inventory.v1.json"
        write_exclusive(inventory_path, (canonical_json(inventory) + "\n").encode())
        for directory, _, filenames in os.walk(staging, topdown=False, followlinks=False):
            for filename in filenames:
                file_descriptor = os.open(Path(directory) / filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    os.fsync(file_descriptor)
                finally:
                    os.close(file_descriptor)
            fsync_directory(Path(directory))
        intent = {
            "protocol": "pdf-tools.docling-model-publication-intent.v1",
            "target": str(models_path),
            "config_sha256": args.expected_config_sha256,
            "file_set_sha256": inventory["file_set_sha256"],
        }
        write_exclusive(intent_path, (canonical_json(intent) + "\n").encode())
        fsync_directory(parent)
        publish_fresh(staging, models_path)
        if os.environ.get("PDF_TOOLS_DOCLING_TEST_PARENT_FSYNC_FAILURE") == "1":
            raise OSError("injected post-publication parent fsync failure")
        fsync_directory(parent)
        os.unlink(intent_path)
        try:
            fsync_directory(parent)
        except OSError:
            pass  # Publication was already durable before intent cleanup.
        print(json.dumps({"inventory_path": str(models_path / inventory_path.name), "file_set_sha256": inventory["file_set_sha256"], "reused": False, "recovered_after_parent_fsync": False}, separators=(",", ":")))
        return 0
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        if intent_path.exists() and not models_path.exists():
            os.unlink(intent_path)
            fsync_directory(parent)
        raise


def main() -> int:
    args = arguments()
    cache_identity = validate_private_empty_cache(args.hf_cache_path)
    try:
        return setup(args)
    finally:
        clear_private_cache(args.hf_cache_path, cache_identity)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Pinned layout setup failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
