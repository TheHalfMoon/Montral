#!/usr/bin/env python3
"""Fail closed when integrated-main GitHub Actions evidence is incomplete.

Usage:
  gh run list --commit SHA --event push --limit 100 --json name,event,headSha,status,conclusion,databaseId > runs.json
  python scripts/verify-main-workflows.py --sha SHA --runs-json runs.json

This is a read-only evidence check. It does not authorize a release.
"""
import argparse
import json
import sys
from pathlib import Path

REQUIRED = frozenset({
    "Windows Docker prerequisite safety",
    "Montral source integrity",
    "Montral Terraform provider",
    "Montral cross-browser and accessibility",
    "Montral failover qualification",
    "Montral upgrade, rollback and disaster recovery",
    "Montral browser checks",
    "Montral Docker Compose qualification",
    "Montral app CI",
    "Montral macOS PostgreSQL 18 qualification",
    "Montral load qualification",
})


def verify(sha: str, runs: list[dict]) -> list[str]:
    errors = []
    if len(sha) != 40 or any(c not in "0123456789abcdef" for c in sha):
        return ["SHA must be a full lowercase 40-character commit hash"]
    for name in sorted(REQUIRED):
        matches = [r for r in runs if r.get("name") == name
                   and r.get("headSha") == sha and r.get("event") == "push"]
        if not matches:
            errors.append(f"{name}: missing exact-SHA push run")
            continue
        # Multiple attempts are allowed only when each is the same exact SHA.
        # GitHub's databaseId distinguishes runs; never mix evidence from other commits.
        if not any(r.get("status") == "completed"
                   and r.get("conclusion") == "success"
                   and isinstance(r.get("databaseId"), int)
                   and r["databaseId"] > 0 for r in matches):
            errors.append(f"{name}: no completed successful run with a valid run ID")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--runs-json", type=Path, required=True)
    args = parser.parse_args()
    try:
        runs = json.loads(args.runs_json.read_text(encoding="utf-8-sig"))
        if not isinstance(runs, list) or any(not isinstance(r, dict) for r in runs):
            raise ValueError("expected JSON array of workflow objects")
    except (OSError, ValueError) as exc:
        print(f"Evidence invalid: {exc}", file=sys.stderr)
        return 2
    errors = verify(args.sha, runs)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"PASS: {len(REQUIRED)} exact-main push workflows successful for {args.sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
