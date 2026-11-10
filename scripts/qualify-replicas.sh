#!/usr/bin/env bash
# Qualifies several app replicas behind a load balancer (docker-compose.replicas.yml) on one PostgreSQL, from the
# shipped image, on a disposable project with synthetic secrets:
#   - requests are spread over the replicas and a session made on one works on every other one;
#   - webhook captures sent concurrently through the balancer are stored exactly once each;
#   - a rolling restart (each replica in turn, SIGTERM) loses no request;
#   - scheduled checks run once per interval in total, not once per replica (no duplicates, no starvation),
#     including while replicas restart;
#   - a failing monitor opens exactly one incident although every replica's scheduler sees it.
# Never pushes an image. Cleans up containers and volumes.
set -euo pipefail

project="montral-replicas-$$"
port="${MONTRAL_QUALIFY_PORT:-18081}"
base="http://127.0.0.1:${port}"
work="$(mktemp -d)"
jar="$work/cookies"
compose=(docker compose -p "$project" -f docker-compose.yml -f docker-compose.replicas.yml --env-file "$work/.env")
replicas=2
load_pid=""

cleanup() {
  status=$?
  [[ -n "$load_pid" ]] && kill "$load_pid" 2>/dev/null || true
  if [[ $status -ne 0 ]]; then
    echo "--- montral logs (tail) ---"; "${compose[@]}" logs --no-color --tail 60 montral || true
    echo "--- lb logs (tail) ---"; "${compose[@]}" logs --no-color --tail 40 lb || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit $status
}
trap cleanup EXIT

cat > "$work/.env" <<EOF
POSTGRES_PASSWORD=qualify-$(openssl rand -hex 12)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=${base}
PORT=${port}
REPLICAS=${replicas}
MONTRAL_IMAGE=montral:qualify
SELFCHECK_URLS=
ALLOW_PRIVATE_TARGETS=true
EOF

psql() { "${compose[@]}" exec -T postgres psql -U montral -d montral -tAc "$1"; }
app_ids() { "${compose[@]}" ps -q montral; }
wait_replicas() { # every replica healthy, then the balancer answers
  local deadline=$((SECONDS + 240)) ids healthy
  while :; do
    ids="$(app_ids)"; healthy=0
    for id in $ids; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" == healthy ]] && healthy=$((healthy + 1)); done
    (( healthy == replicas )) && curl -fsS "$base/health" >/dev/null 2>&1 && return 0
    if (( SECONDS > deadline )); then echo "replicas not healthy (${healthy}/${replicas})" >&2; return 1; fi
    sleep 3
  done
}
api() { # method path [json]
  local args=(-fsS -X "$1" -H "origin: $base" -H "content-type: application/json" -b "$jar" -c "$jar" "$base$2")
  [[ $# -ge 3 ]] && args+=(--data "$3")
  curl "${args[@]}"
}
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

echo "== build the image and start ${replicas} replicas behind the load balancer"
docker build -q -t montral:qualify . >/dev/null
"${compose[@]}" up -d --wait postgres
"${compose[@]}" up -d montral lb
wait_replicas
[[ "$(app_ids | wc -l)" -eq $replicas ]] || { echo "expected ${replicas} app containers" >&2; exit 1; }

echo "== sessions and requests across replicas"
email="replicas-$(openssl rand -hex 6)@example.com"
password="replicas-$(openssl rand -hex 12)"
api POST /api/auth/sign-up/email "{\"email\":\"$email\",\"name\":\"Replica QA\",\"password\":\"$password\"}" >/dev/null
upstreams="$work/upstreams"
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null -D - -H "origin: $base" -b "$jar" "$base/api/monitors" | tr -d '\r' | sed -n 's/^x-montral-upstream: //Ip' >> "$upstreams"
done
served="$(sort -u "$upstreams" | wc -l)"
[[ "$(wc -l < "$upstreams")" -eq 40 ]] || { echo "not every authenticated request succeeded" >&2; exit 1; }
(( served >= replicas )) || { echo "requests reached ${served} replica(s), expected ${replicas}" >&2; exit 1; }

echo "== concurrent webhook captures through the balancer are stored exactly once"
inbox="$(api POST /api/hooks/inboxes '{"name":"Replica inbox"}')"
inbox_id="$(json "['id']" <<<"$inbox")"
inbox_path="$(json "['path']" <<<"$inbox")"
seq 1 60 | xargs -P 8 -I{} curl -fsS -o /dev/null -X POST -H 'content-type: application/json' --data '{"n":{}}' "$base$inbox_path"
captured="$(psql "select count(*), count(distinct body) from montral_hook_event where inbox_id = '${inbox_id}'")"
[[ "$captured" == "60|60" ]] || { echo "captured (rows|distinct bodies) ${captured}, expected 60|60" >&2; exit 1; }

echo "== monitors: six healthy HTTP checks through the balancer and one failing check, 60 s interval"
monitor_ids=()
for i in 1 2 3 4 5 6; do
  m="$(api POST /api/monitors "{\"name\":\"Replica check ${i}\",\"type\":\"http\",\"target\":\"http://lb:8080/health\",\"intervalSec\":60}")"
  monitor_ids+=("$(json "['id']" <<<"$m")")
done
failing="$(api POST /api/monitors '{"name":"Replica failing","type":"http","target":"http://lb:8080/api/replica-qualification-missing","intervalSec":60,"failureThreshold":1}')"
failing_id="$(json "['id']" <<<"$failing")"
started_epoch="$(psql "select extract(epoch from now())::bigint")"

echo "== rolling restart under load: one replica at a time, no request lost"
codes="$work/codes"
( while :; do curl -s -o /dev/null -w '%{http_code}\n' -H "origin: $base" -b "$jar" "$base/api/monitors" >> "$codes"; sleep 0.1; done ) &
load_pid=$!
sleep 5
for id in $(app_ids); do
  docker restart -t 20 "$id" >/dev/null
  wait_replicas
  sleep 5
done
kill "$load_pid"; wait "$load_pid" 2>/dev/null || true; load_pid=""
total="$(wc -l < "$codes")"
bad="$(grep -vc '^200$' "$codes" || true)"
(( total >= 100 )) || { echo "only ${total} requests during the rolling restart" >&2; exit 1; }
(( bad == 0 )) || { echo "${bad} of ${total} requests failed during the rolling restart: $(sort "$codes" | uniq -c | tr '\n' ' ')" >&2; exit 1; }

echo "== scheduled checks: once per interval in total, across ${replicas} schedulers"
window=330
while (( $(psql "select extract(epoch from now())::bigint") - started_epoch < window )); do sleep 10; done
ids_sql="$(printf "'%s'," "${monitor_ids[@]}")"; ids_sql="${ids_sql%,}"
stats="$(psql "with r as (
    select monitor_id, checked_at, checked_at - lag(checked_at) over (partition by monitor_id order by checked_at) as gap
    from check_result where monitor_id in (${ids_sql}) and checked_at >= to_timestamp(${started_epoch}))
  select count(*), min(n), max(n), coalesce(extract(epoch from min(min_gap))::int, -1) from (
    select monitor_id, count(*) as n, min(gap) as min_gap from r group by monitor_id) per")"
IFS='|' read -r all_results min_n max_n min_gap <<<"$stats"
[[ "$all_results" -eq 6 ]] || { echo "only ${all_results} of 6 monitors produced results" >&2; exit 1; }
# 330 s at a 60 s interval: about 5 runs each. Twice that would mean every replica ran each check.
(( min_n >= 3 )) || { echo "a monitor ran only ${min_n} times in ${window} s (starved)" >&2; exit 1; }
(( max_n <= 8 )) || { echo "a monitor ran ${max_n} times in ${window} s (duplicated across replicas)" >&2; exit 1; }
(( min_gap >= 15 )) || { echo "two results of one monitor ${min_gap} s apart (a run claimed twice)" >&2; exit 1; }
ok_results="$(psql "select count(*) filter (where ok), count(*) from check_result where monitor_id in (${ids_sql}) and checked_at >= to_timestamp(${started_epoch})")"
[[ "${ok_results%%|*}" == "${ok_results##*|}" ]] || { echo "healthy checks through the balancer failed: ${ok_results}" >&2; exit 1; }

echo "== a failing monitor opens exactly one incident"
incidents="$(psql "select count(*), count(*) filter (where resolved_at is null) from incident where monitor_id = '${failing_id}'")"
[[ "$incidents" == "1|1" ]] || { echo "incidents (all|open) for the failing monitor: ${incidents}, expected 1|1" >&2; exit 1; }
failing_runs="$(psql "select count(*) from check_result where monitor_id = '${failing_id}' and not ok")"
(( failing_runs >= 3 && failing_runs <= 7 )) || { echo "failing monitor ran ${failing_runs} times" >&2; exit 1; }

echo "REPLICAS_PASS: ${replicas} replicas behind nginx served ${served} distinct upstreams with one session; 60/60 concurrent webhook captures stored once; rolling restart lost 0 of ${total} requests; ${window} s of scheduling: ${min_n}-${max_n} runs per 60 s monitor, minimum gap ${min_gap} s, all healthy; failing monitor: 1 incident from ${failing_runs} failed runs"
