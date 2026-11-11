#!/usr/bin/env python3
"""Validate the Montral-only tracked source tree without donor snapshots."""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACTIVE = ("apps/", "packages/", "docker/", "terraform-provider-montral/")
REQUIRED = ("README.md", "LICENSE", "Dockerfile", "apps/api/package.json",
            "apps/web/package.json", "apps/probe/package.json",
            "legal/MONTRAL_CORE_MIT_LICENSE.txt",
            "legal/MONTRAL_PROBES_APACHE_LICENSE.txt",
            "legal/MONTRAL_WEBHOOKS_MIT_LICENSE.txt")

def main() -> None:
    files = subprocess.check_output(
        ["git", "-C", str(ROOT), "ls-files", "--cached", "--others", "--exclude-standard"],
        text=True, encoding="utf-8"
    ).splitlines()
    paths = set(files)
    duplicates = sorted(x for x in paths if x.startswith("vendor/"))
    if (ROOT / "vendor").exists() or duplicates:
        raise SystemExit("Montral source identity FAIL: obsolete vendor snapshot present")
    missing = [x for x in REQUIRED if x not in paths or not (ROOT/x).is_file()]
    if missing:
        raise SystemExit(f"Montral source identity FAIL: required files missing: {missing}")
    unexpected = sorted(
        x for x in paths if x.startswith(ACTIVE)
        and any(name in x.lower() for name in ("openuptime","uptimeflare","webhooksite"))
    )
    if unexpected:
        raise SystemExit(f"Montral source identity FAIL: legacy paths {unexpected[:5]}")
    for package in ("apps/api","apps/web","apps/probe"):
        import json
        name = json.loads((ROOT/package/"package.json").read_text(encoding="utf-8"))["name"]
        if not name.startswith("@montral/"):
            raise SystemExit(f"Montral source identity FAIL: {package}: {name}")
    print("MONTRAL_SOURCE_ONLY_PASS: no duplicate vendor source and Montral application packages verified")

if __name__ == "__main__":
    main()
