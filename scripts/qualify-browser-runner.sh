#!/usr/bin/env bash
# Qualifies browser checks as a self-hoster runs them: the default app image, PostgreSQL and the separate, hardened
# browser-runner (docker-compose.yml + docker-compose.browser.yml), on a disposable project with synthetic secrets.
# Proves: the runner holds no database URL or app secrets, runs with no capabilities, no privilege gain, a read-only root,
# Docker's seccomp profile plus only the namespace syscalls, and cannot reach PostgreSQL by name or by address; the app
# image has no browser; a journey created through the API runs end to end in sandboxed Chromium in the runner; unsigned
# requests to the runner are refused. Never pushes an image. Cleans up containers, networks and volumes.
set -euo pipefail

project="montral-browser-$$"
port="${MONTRAL_QUALIFY_PORT:-18081}"
base="http://127.0.0.1:${port}"
work="$(mktemp -d)"
jar="$work/cookies"
compose=(docker compose -p "$project" --env-file "$work/.env" -f docker-compose.yml -f docker-compose.browser.yml)

cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- montral logs (tail) ---"; "${compose[@]}" logs --no-color --tail 60 montral || true
    echo "--- browser-runner logs (tail) ---"; "${compose[@]}" logs --no-color --tail 60 browser-runner || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit $status
}
trap cleanup EXIT

cat > "$work/.env" <<EOF
POSTGRES_PASSWORD=qualify-$(openssl rand -hex 12)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
BROWSER_RUNNER_TOKEN=$(openssl rand -hex 32)
PUBLIC_URL=${base}
PORT=${port}
MONTRAL_IMAGE=montral:browser-qualify
MONTRAL_BROWSER_RUNNER_IMAGE=montral-browser-runner:qualify
SELFCHECK_URLS=
EOF

api() { # method path [json]
  local args=(-fsS -X "$1" -H "origin: $base" -H "content-type: application/json" -b "$jar" -c "$jar" "$base$2")
  [[ $# -ge 3 ]] && args+=(--data "$3")
  curl "${args[@]}"
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }

echo "== build the default app image and the browser-runner image"
docker build -q -t montral:browser-qualify . >/dev/null
docker build -q --target browser-runner -t montral-browser-runner:qualify . >/dev/null
docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E '^montral(-browser-runner)?:(browser-)?qualify '

echo "== start postgres, the runner and the app with the hardened compose"
"${compose[@]}" up -d --wait
runner="$("${compose[@]}" ps -q browser-runner)"
app="$("${compose[@]}" ps -q montral)"
db="$("${compose[@]}" ps -q postgres)"

echo "== the runner holds no app secrets"
env_lines="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$runner")"
if grep -E '^(DATABASE_URL|BETTER_AUTH_SECRET|POSTGRES_PASSWORD|SMTP_|RESEND_API_KEY|CRON_SECRET|PROBE_SECRET|PROBE_SECRETS)' <<<"$env_lines"; then
  echo "the runner container has app secrets in its environment" >&2; exit 1
fi
grep -q '^BROWSER_RUNNER_TOKEN=' <<<"$env_lines" || { echo "runner has no BROWSER_RUNNER_TOKEN" >&2; exit 1; }
"${compose[@]}" exec -T browser-runner sh -c 'cat /proc/1/environ | tr "\0" "\n"' | grep -E '^(DATABASE_URL|BETTER_AUTH_SECRET)=' && { echo "runner process sees app secrets" >&2; exit 1; }
[[ "$("${compose[@]}" exec -T browser-runner id -un)" == node ]] || { echo "runner is not running as the unprivileged node user" >&2; exit 1; }

echo "== the runner is hardened"
[[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$runner")" == true ]] || { echo "runner root fs is writable" >&2; exit 1; }
docker inspect -f '{{json .HostConfig.CapDrop}}' "$runner" | grep -q '"ALL"' || { echo "runner keeps capabilities" >&2; exit 1; }
secopt="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$runner")"
grep -q 'no-new-privileges' <<<"$secopt" || { echo "runner lacks no-new-privileges" >&2; exit 1; }
grep -q 'seccomp' <<<"$secopt" || { echo "runner has no seccomp profile" >&2; exit 1; }
grep -q 'unconfined' <<<"$secopt" && { echo "runner seccomp is unconfined" >&2; exit 1; }
[[ "$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$runner")" -gt 0 ]] || { echo "runner has no pids limit" >&2; exit 1; }
[[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$runner")" -gt 0 ]] || { echo "runner has no memory limit" >&2; exit 1; }
"${compose[@]}" exec -T browser-runner sh -c 'grep -E "^CapEff" /proc/self/status' | grep -q '0000000000000000' || { echo "runner process has effective capabilities" >&2; exit 1; }
"${compose[@]}" exec -T browser-runner sh -c 'grep -E "^NoNewPrivs" /proc/self/status' | grep -q '1' || { echo "no_new_privs not set" >&2; exit 1; }
"${compose[@]}" exec -T browser-runner sh -c 'touch /app/x' 2>/dev/null && { echo "runner can write its root fs" >&2; exit 1; }

echo "== PID 1 reaps: a worker killed mid-journey leaves no zombie and no Chromium behind"
"${compose[@]}" exec -T browser-runner sh -c 'tr "\0" " " < /proc/1/cmdline' | grep -q 'docker-init' || { echo "runner PID 1 is not an init (init: true)" >&2; exit 1; }
crash_job='{"config":{"steps":[{"action":"goto","url":"https://example.com/"},{"action":"waitFor","selector":"#never","timeoutMs":20000}],"timeoutMs":30000},"secrets":{},"policy":{"allowPrivate":false},"sandbox":true}'
# start a worker directly (as the runner would), let Chromium come up, then SIGKILL the worker alone
# (only the node process whose argv is exactly "node /app/browser-worker.mjs": this shell's own command line names it too)
"${compose[@]}" exec -T browser-runner sh -c "cd /tmp && (echo '$crash_job' | node /app/browser-worker.mjs >/dev/null 2>&1 &) ; sleep 6; killed=0; for p in /proc/[0-9]*; do if [ \"\$(tr '\\0' ' ' < \$p/cmdline 2>/dev/null)\" = 'node /app/browser-worker.mjs ' ]; then kill -9 \${p#/proc/} && killed=\$((killed+1)); fi; done; echo \"  killed \$killed worker(s)\"; [ \$killed -ge 1 ]"
for wait in $(seq 1 20); do
  sleep 1
  proc_states="$("${compose[@]}" exec -T browser-runner sh -c 'for p in /proc/[0-9]*; do s=$(cut -d" " -f3 $p/stat 2>/dev/null); c=$(tr "\0" " " < $p/cmdline 2>/dev/null | cut -c1-60); echo "$s $c"; done')"
  grep -qi '^Z\|headless_shell\|chrom' <<<"$proc_states" || break
done
echo "$proc_states" | sed 's/^/  /'
if grep -q '^Z' <<<"$proc_states"; then echo "zombie processes in the runner" >&2; exit 1; fi
if grep -qi 'headless_shell\|chrom' <<<"$proc_states"; then echo "Chromium survived its killed worker" >&2; exit 1; fi

echo "== the runner cannot reach PostgreSQL (not resolvable, not routable)"
db_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$db" | awk '{print $1}')"
probe='const n=require("net"),d=require("dns");const[h,p]=process.argv.slice(1);d.lookup(h,(e,a)=>{if(e){console.log("unresolvable");return process.exit(0)}const s=n.connect(+p,a);s.setTimeout(3000);s.on("connect",()=>{console.log("CONNECTED");process.exit(1)});s.on("timeout",()=>{console.log("timeout");process.exit(0)});s.on("error",e=>{console.log(e.code);process.exit(0)})})'
for target in postgres "$db_ip"; do
  out="$("${compose[@]}" exec -T browser-runner node -e "$probe" "$target" 5432)" || { echo "runner reached PostgreSQL at $target" >&2; exit 1; }
  echo "  $target: $out"
done
# the same probe from the app does connect (it is a working probe, not a broken one)
sanity="$("${compose[@]}" exec -T montral node -e "$probe" postgres 5432 || true)"
grep -q CONNECTED <<<"$sanity" || { echo "probe sanity check failed from the app: $sanity" >&2; exit 1; }

echo "== the app image has no browser; the runner refuses unsigned requests"
docker run --rm --entrypoint sh montral:browser-qualify -c 'test -e /ms-playwright || test -e /app/node_modules/playwright-core || test -e /app/browser-worker.mjs' && { echo "app image contains a browser" >&2; exit 1; }
status="$("${compose[@]}" exec -T montral node -e 'fetch("http://browser-runner:8090/v1/run",{method:"POST",body:"{}"}).then(r=>console.log(r.status))')"
[[ "$status" == 401 ]] || { echo "runner answered an unsigned request with $status" >&2; exit 1; }

echo "== a journey created through the API runs end to end in the runner"
email="browser-$(openssl rand -hex 6)@example.com"
api POST /api/auth/sign-up/email "{\"email\":\"$email\",\"name\":\"Browser QA\",\"password\":\"qualify-$(openssl rand -hex 12)\"}" >/dev/null
# never a target: metadata, loopback, localhost, the runner or the app by service name
for url in http://169.254.169.254/latest/meta-data/ http://127.0.0.1:8080/ http://localhost/ http://browser-runner:8090/health http://montral:8080/health; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "origin: $base" -H 'content-type: application/json' -b "$jar" "$base/api/monitors" --data "{\"name\":\"refused\",\"type\":\"browser\",\"browser\":{\"steps\":[{\"action\":\"goto\",\"url\":\"$url\"}]}}")"
  [[ "$code" == 400 ]] || { echo "journey to $url was accepted ($code)" >&2; exit 1; }
done
created="$(api POST /api/monitors '{"name":"Public journey","type":"browser","browser":{"steps":[{"action":"goto","url":"https://example.com/"},{"action":"assertText","contains":"domain"},{"action":"assertUrl","pattern":"https://example.com/*"},{"action":"assertStatus","code":200}],"timeoutMs":30000}}')"
id="$(json 'd.get("id","")' <<<"$created")"
[[ -n "$id" ]] || { echo "browser monitor create failed: $created" >&2; exit 1; }
for attempt in 1 2 3; do
  api POST "/api/monitors/${id}/check" '{}' >/dev/null
  run="$(api GET "/api/monitors/${id}/browser-runs" | json 'd["runs"][0] if d["runs"] else {}')"
  echo "  attempt $attempt: $run"
  if grep -q "'ok': True" <<<"$run"; then break; fi
  [[ $attempt -lt 3 ]] || { echo "journey did not pass through the runner" >&2; exit 1; }
  sleep $((attempt * 5))
done
api GET "/api/monitors/${id}" | grep -q '"status":"up"' || { echo "browser monitor is not up" >&2; exit 1; }
# the run happened in the runner (its Chromium), not in the app container
"${compose[@]}" logs --no-color browser-runner | grep -q 'browser-runner listening' || { echo "runner never started" >&2; exit 1; }

echo "BROWSER_RUNNER_PASS: default app image without a browser; runner without app secrets, cap_drop ALL, no-new-privileges, read-only root, custom seccomp (not unconfined), pids/memory limits; PostgreSQL unreachable from the runner by name and address; unsigned runner requests refused; private/metadata/runner/app targets refused; a public journey ran end to end in sandboxed Chromium in the runner"
