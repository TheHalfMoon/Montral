#!/usr/bin/env bash
# Detect active donor product branding without inspecting or rewriting the
# pinned original-source snapshots/attribution outside apps and packages.
set -euo pipefail
if [[ ! -d apps || ! -d packages ]]; then
  echo 'Expected apps and packages directories for source-branding check' >&2
  exit 1
fi
hits="$(mktemp)"
trap 'rm -f "$hits"' EXIT
# Do NOT pipe grep to head in the conditional: head returns 0 even when grep
# reports no matches. Capture grep's tri-state exit code directly instead.
if grep -R -l -i -E 'openuptime|uptimeflare|webhook.site' apps packages \
  --include='*.ts' --include='*.tsx' --include='*.astro' --include='*.json' \
  --exclude-dir=dist --exclude-dir=.astro --exclude-dir=node_modules > "$hits"; then
  echo 'Unexpected upstream product branding in active code:' >&2
  sed -n '1p' "$hits" >&2
  exit 1
else
  grep_status=$?
  if [[ "$grep_status" -ne 1 ]]; then
    echo "Active source-brand scan could not complete (grep exit $grep_status)" >&2
    exit 1
  fi
fi
echo 'MONTRAL_ACTIVE_BRAND_SCAN_PASS: no donor product branding in active code'
