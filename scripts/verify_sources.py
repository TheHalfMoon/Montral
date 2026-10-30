#!/usr/bin/env python3
"""Verify Montral's exact upstream source snapshots without running donor code."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "source-manifest.json"
SOURCES = {
    "montral-core": ("8dcba0780907c70c3225ec8e6891d73ec823352a", 431),
    "montral-cloud-probes": ("8035521268a54222959eaf720c82f530e755b6bb", 72),
    "montral-webhooks-legacy": ("96b7b4275b4481eedd8a3f052aa44642eb3b4ae2", 135),
}

def snapshot() -> dict:
    result = {"schema_version": 1, "sources": {}}
    for name, (commit, count) in SOURCES.items():
        folder = ROOT / "vendor" / name
        if not folder.is_dir():
            raise RuntimeError(f"Missing required snapshot: {name}")
        files = {}
        for path in sorted(p for p in folder.rglob("*") if p.is_file() or p.is_symlink()):
            relative = path.relative_to(folder).as_posix()
            if path.is_symlink():
                data = ("SYMLINK:" + str(path.readlink())).encode()
            else:
                data = path.read_bytes()
            files[relative] = hashlib.sha256(data).hexdigest()
        if len(files) != count:
            raise RuntimeError(f"{name}: expected {count} tracked files; found {len(files)}")
        if not (folder / "LICENSE").is_file():
            raise RuntimeError(f"{name}: missing upstream LICENSE")
        result["sources"][name] = {"upstream_commit": commit, "file_count": count, "files": files}
    return result

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Record initial manifest once after archived source import")
    args = parser.parse_args()
    current = snapshot()
    if args.write:
        if MANIFEST.exists():
            raise SystemExit("Manifest already exists; never silently regenerate the source pin")
        MANIFEST.write_text(json.dumps(current, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print("Montral source manifest created")
        return
    expected = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if expected != current:
        missing = [s for s in expected.get("sources", {}) if s not in current["sources"]]
        raise SystemExit(f"Montral source snapshot integrity FAILED; missing sources: {missing}")
    print(f"Verified {sum(x['file_count'] for x in current['sources'].values())} source files across three pinned donors")

if __name__ == "__main__":
    main()
