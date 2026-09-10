"""The export's shards, read and validated (D-255).

A dataset is a directory: manifest.json plus JSONL shards. The manifest
names the schema version, the event range, the counts, and a SHA-256 per
shard; a shard that does not hash to its manifest entry is refused, so a
training run can never silently learn from a truncated or edited file.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Manifest:
    dataset_id: str
    schema_version: int
    from_event: str | None
    to_event: str | None
    counts: dict[str, int]
    shards: dict[str, str]  # file name -> sha256


def read_manifest(root: Path) -> Manifest:
    raw = json.loads((root / "manifest.json").read_text())
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"dataset schema {raw.get('schemaVersion')} is not {SCHEMA_VERSION}")
    return Manifest(
        dataset_id=raw["datasetId"],
        schema_version=raw["schemaVersion"],
        from_event=raw.get("fromEvent"),
        to_event=raw.get("toEvent"),
        counts=dict(raw.get("counts", {})),
        shards=dict(raw["shards"]),
    )


def verify_shard(root: Path, name: str, expected: str) -> Path:
    path = root / name
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        raise ValueError(f"{name} hashes to {digest[:12]}…, manifest says {expected[:12]}…")
    return path


def read_jsonl(path: Path) -> Iterator[dict]:
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def trajectories(root: Path) -> Iterator[dict]:
    manifest = read_manifest(root)
    for name, digest in manifest.shards.items():
        if name.startswith("trajectories"):
            yield from read_jsonl(verify_shard(root, name, digest))


def pairs(root: Path) -> Iterator[dict]:
    manifest = read_manifest(root)
    for name, digest in manifest.shards.items():
        if name.startswith("pairs"):
            yield from read_jsonl(verify_shard(root, name, digest))
