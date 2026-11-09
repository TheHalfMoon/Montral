#!/usr/bin/env bash
# Qualifies the shipped Docker setup as a self-hoster runs it: the Dockerfile image and docker-compose.yml with its
# pinned PostgreSQL, on a disposable project with synthetic secrets. Proves the stack starts healthy, the app works
# end to end over HTTP, data survives a full stop/start of both containers (the named PostgreSQL volume), and the
# image's unprivileged user can send ICMP (ping monitors). Never pushes an image. Cleans up containers and volumes.
set -euo pipefail

project="montral-qualify-$$"
port="${MONTRAL_QUALIFY_PORT:-18080}"
base="http://127.0.0.1:${port}"
work="$(mktemp -d)"
jar="$work/cookies"
compose=(docker compose -p "$project" --env-file "$work/.env")

cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- montral logs (tail) ---"; "${compose[@]}" logs --no-color --tail 80 montral || true
    echo "--- postgres logs (tail) ---"; "${compose[@]}" logs --no-color --tail 40 postgres || true
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
MONTRAL_IMAGE=montral:qualify
SELFCHECK_URLS=
EOF

wait_healthy() {
  local deadline=$((SECONDS + 180))
  until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$("${compose[@]}" ps -q montral)" 2>/dev/null)" == healthy ]]; do
    if (( SECONDS > deadline )); then echo "montral container did not become healthy" >&2; return 1; fi
    sleep 3
  done
  curl -fsS "$base/health" >/dev/null
}
api() { # method path [json]
  local args=(-fsS -X "$1" -H "origin: $base" -H "content-type: application/json" -b "$jar" -c "$jar" "$base$2")
  [[ $# -ge 3 ]] && args+=(--data "$3")
  curl "${args[@]}"
}

echo "== build image and start the compose stack"
docker build -q -t montral:qualify . >/dev/null
"${compose[@]}" up -d --wait postgres
"${compose[@]}" up -d montral
wait_healthy

pg_version="$("${compose[@]}" exec -T postgres psql -U montral -d montral -tAc 'SHOW server_version')"
compose_image="$(sed -n 's/^ *image: *\(postgres:[^ ]*\) *$/\1/p' docker-compose.yml)"
echo "postgres server ${pg_version} from ${compose_image}"
[[ "$compose_image" == postgres:${pg_version%% *}* ]] || { echo "server version ${pg_version} does not match ${compose_image}" >&2; exit 1; }
[[ "$("${compose[@]}" exec -T montral id -un)" == node ]] || { echo "app container is not running as the unprivileged node user" >&2; exit 1; }

echo "== app over HTTP: pages, config, sign-up, write and read"
curl -fsS "$base/" | grep '<html' >/dev/null || { echo "web app did not serve HTML" >&2; exit 1; }
api GET /api/config | grep '"auth"' >/dev/null || { echo "/api/config missing auth section" >&2; exit 1; }
email="qualify-$(openssl rand -hex 6)@example.com"
password="qualify-$(openssl rand -hex 12)"
api POST /api/auth/sign-up/email "{\"email\":\"$email\",\"name\":\"Docker QA\",\"password\":\"$password\"}" >/dev/null
monitor_name="Docker persistence $(openssl rand -hex 4)"
api POST /api/monitors "{\"name\":\"$monitor_name\",\"type\":\"heartbeat\"}" | grep '"id"' >/dev/null || { echo "monitor create failed" >&2; exit 1; }
api GET /api/monitors | grep "$monitor_name" >/dev/null || { echo "created monitor not listed" >&2; exit 1; }

echo "== unprivileged ICMP inside the image (ping monitors)"
"${compose[@]}" exec -T montral ping -c 1 -W 2 127.0.0.1 >/dev/null || { echo "ping as node user failed inside the image" >&2; exit 1; }

echo "== full stop and start: data must survive in the named volume"
"${compose[@]}" stop
"${compose[@]}" up -d --wait postgres
"${compose[@]}" up -d montral
wait_healthy
rm -f "$jar"
api POST /api/auth/sign-in/email "{\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
api GET /api/monitors | grep "$monitor_name" >/dev/null || { echo "monitor did not survive the restart" >&2; exit 1; }

echo "== container recreation (an image upgrade replaces the app container): data still there"
"${compose[@]}" up -d --force-recreate montral
wait_healthy
api GET /api/monitors | grep "$monitor_name" >/dev/null || { echo "monitor did not survive recreating the app container" >&2; exit 1; }

echo "== downgrade protection: an older PostgreSQL major refuses the volume instead of starting empty"
"${compose[@]}" stop
volume="$(docker volume ls -q --filter "label=com.docker.compose.project=${project}" | grep pgdata)"
pgdata="$("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["postgres"]["environment"]["PGDATA"])')"
set +e
downgrade_log="$(timeout 60 docker run --rm -e POSTGRES_PASSWORD=unused -e PGDATA="$pgdata" -v "$volume:/var/lib/postgresql" postgres:17-alpine 2>&1)"
downgrade_status=$?
set -e
if [[ $downgrade_status -eq 0 || $downgrade_status -eq 124 ]]; then
  echo "PostgreSQL 17 did not refuse the PostgreSQL 18 volume (exit ${downgrade_status})" >&2; echo "$downgrade_log" | tail -20 >&2; exit 1
fi
# What matters: it found the existing cluster (no new, empty one was initialised) and refused to run on it. PostgreSQL 17
# stops either at 18's configuration file or at the data directory version check, whichever it reaches first.
grep -q 'Skipping initialization' <<<"$downgrade_log" || { echo "the older image did not recognise the existing cluster:" >&2; echo "$downgrade_log" | tail -20 >&2; exit 1; }
grep -q -i -E 'incompatible|configuration file .* contains errors' <<<"$downgrade_log" || { echo "downgrade refused for an unexpected reason:" >&2; echo "$downgrade_log" | tail -20 >&2; exit 1; }
"${compose[@]}" run --rm --no-deps -T --entrypoint sh postgres -c 'test ! -e /var/lib/postgresql/data/PG_VERSION' || { echo "a second cluster was initialised in the volume" >&2; exit 1; }
"${compose[@]}" up -d --wait postgres
"${compose[@]}" up -d montral
wait_healthy
api GET /api/monitors | grep "$monitor_name" >/dev/null || { echo "data missing after the refused downgrade" >&2; exit 1; }

echo "DOCKER_COMPOSE_PASS: image built, ${compose_image} (server ${pg_version}) healthy, sign-up and monitor write/read, ping as node, data survived stop/start and app container recreation, PostgreSQL 17 refused the 18 volume without touching it"
