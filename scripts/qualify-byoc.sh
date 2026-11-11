#!/usr/bin/env bash
# Qualifies the BYOC reference deployment (docker-compose.yml + docker-compose.byoc.yml, see docs/BYOC.md) with NO
# internet egress. Everything runs on one `docker network create --internal` network, which has no route out:
#   - a separate PostgreSQL container plays the customer's own database (reached only through DATABASE_URL; the bundled
#     postgres service stays off);
#   - the app container runs with the overlay's settings as shipped (self-check off by default, read-only root
#     filesystem, no capabilities, no-new-privileges, no operators) and must start, migrate and turn healthy;
#   - a client container on the same network signs up, creates a heartbeat monitor and pings it, creates a webhook inbox
#     and posts to it, runs a ping monitor, exports the audit log, and reads everything back, also after the app
#     container is recreated (all state is in the customer's database);
#   - scripts/byoc-egress-log.cjs, preloaded into the server process for this test only, records every TCP/TLS connect,
#     UDP send and DNS query the process attempts; the run fails if anything but the customer database and loopback was
#     contacted. A canary inside the container proves the recorder sees fetch, TLS and resolver calls.
# Before the app starts, the network itself is shown to have no egress (by name and by IP). Never pushes an image and
# never contacts anything outside the runner once the images are pulled and built. Cleans up everything it created.
set -euo pipefail

project="montral-byoc-$$"
net="${project}-internal"
db="${project}-customer-db"
client="${project}-client"
image="${MONTRAL_BYOC_IMAGE:-montral:byoc-qualify}"
client_image="curlimages/curl:8.11.1"
db_image="postgres:18.6-alpine"
base="http://montral:8080"
work="$(mktemp -d)"
root="$(pwd)"
compose=(docker compose -p "$project" -f "$root/docker-compose.yml" -f "$root/docker-compose.byoc.yml" -f "$work/ci-isolation.yml" --env-file "$work/.env")

cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- montral logs (tail) ---"; "${compose[@]}" logs --no-color --tail 80 montral 2>/dev/null || true
    echo "--- customer database logs (tail) ---"; docker logs --tail 30 "$db" 2>&1 || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$db" "$client" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit $status
}
trap cleanup EXIT
fail() { echo "BYOC_FAIL: $*" >&2; exit 1; }
json() { python3 -c 'import json,sys; v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v.get(k) if isinstance(v,dict) else None
print("" if v is None else v)' "$1"; }

db_password="byoc-$(openssl rand -hex 12)"
cp scripts/byoc-egress-log.cjs "$work/byoc-egress-log.cjs"
chmod a+r "$work/byoc-egress-log.cjs"
# POSTGRES_PASSWORD is only there because docker-compose.yml interpolates it; the bundled database is not started.
# SELFCHECK_URLS is deliberately absent: the overlay's own default (self-check off) must apply.
cat > "$work/.env" <<EOF
POSTGRES_PASSWORD=unused
DATABASE_URL=postgres://montral:${db_password}@customer-db:5432/montral
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=${base}
MONTRAL_IMAGE=${image}
ALLOW_PRIVATE_TARGETS=true
NODE_OPTIONS="--max-old-space-size=512 --require /qualify/byoc-egress-log.cjs"
EOF
# test-only isolation layer: the app's only network is the internal one, nothing is published, the recorder is mounted
cat > "$work/ci-isolation.yml" <<EOF
services:
  montral:
    ports: !reset []
    volumes:
      - ${work}/byoc-egress-log.cjs:/qualify/byoc-egress-log.cjs:ro
networks:
  default:
    name: ${net}
    external: true
EOF

app() { "${compose[@]}" ps -q montral; }
wait_healthy() {
  local deadline=$((SECONDS + 180))
  until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(app)" 2>/dev/null)" == healthy ]]; do
    if (( SECONDS > deadline )); then fail "montral container did not become healthy on the internal-only network"; fi
    sleep 3
  done
}
http() { docker exec "$client" curl "$@"; }
api() { # method path [json]
  local args=(-fsS -X "$1" -H "origin: $base" -H "content-type: application/json" -b /tmp/jar -c /tmp/jar "$base$2")
  [[ $# -ge 3 ]] && args+=(--data "$3")
  http "${args[@]}"
}

echo "== build the image (the only step with internet access, besides pulling base images)"
docker build -q -t "$image" . >/dev/null
docker image inspect "$client_image" >/dev/null 2>&1 || docker pull -q "$client_image" >/dev/null
docker image inspect "$db_image" >/dev/null 2>&1 || docker pull -q "$db_image" >/dev/null

echo "== internal-only network, customer database, client"
docker network create --internal "$net" >/dev/null
[[ "$(docker network inspect -f '{{.Internal}}' "$net")" == true ]] || fail "network $net is not internal"
docker run -d --name "$db" --network "$net" --network-alias customer-db \
  -e POSTGRES_USER=montral -e POSTGRES_PASSWORD="$db_password" -e POSTGRES_DB=montral "$db_image" >/dev/null
docker run -d --name "$client" --network "$net" --entrypoint sh "$client_image" -c 'while :; do sleep 3600; done' >/dev/null
deadline=$((SECONDS + 60))
until docker exec "$db" pg_isready -U montral -d montral >/dev/null 2>&1; do
  (( SECONDS > deadline )) && fail "customer database did not become ready"
  sleep 2
done

echo "== the network has no egress: public names and public IPs are unreachable from it"
for target in https://www.cloudflare.com/cdn-cgi/trace https://www.gstatic.com/generate_204 http://1.1.1.1/ http://8.8.8.8/; do
  if http -s -o /dev/null -m 5 "$target" 2>/dev/null; then fail "$target is reachable from the internal network"; fi
done

echo "== start the app with the BYOC overlay (bundled postgres off, external DATABASE_URL)"
services="$("${compose[@]}" config --services | tr '\n' ' ')"
[[ "$services" == "montral " ]] || fail "the BYOC overlay should leave only the app service active, got: $services"
"${compose[@]}" config --format json > "$work/config.json"
python3 - "$work/config.json" <<'PY' || fail "merged compose configuration does not carry the BYOC settings"
import json, sys
s = json.load(open(sys.argv[1]))["services"]["montral"]
env = s["environment"]
assert env.get("SELFCHECK_URLS") == "", env.get("SELFCHECK_URLS")
assert env.get("MONTRAL_OPERATOR_USER_IDS") == "", env.get("MONTRAL_OPERATOR_USER_IDS")
assert env["DATABASE_URL"].startswith("postgres://montral:") and "@customer-db:5432/" in env["DATABASE_URL"]
assert s.get("read_only") is True and s.get("cap_drop") == ["ALL"], (s.get("read_only"), s.get("cap_drop"))
assert "no-new-privileges:true" in s.get("security_opt", [])
assert not s.get("depends_on"), s.get("depends_on")
PY
"${compose[@]}" up -d montral
wait_healthy
cid="$(app)"
[[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" == true ]] || fail "root filesystem is not read-only"
[[ "$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$cid")" == '["ALL"]' ]] || fail "capabilities are not dropped"
[[ "$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid")" == "$net " ]] || fail "app is attached to more than the internal network"
[[ "$(docker exec "$cid" id -un)" == node ]] || fail "app is not running as the unprivileged node user"
if docker exec "$cid" sh -c 'echo x > /home/node/.byoc-write-test' 2>/dev/null; then fail "the app's root filesystem accepted a write (home of node)"; fi
if docker exec "$cid" wget -q -T 5 -O /dev/null http://1.1.1.1/ 2>/dev/null; then fail "the app container reached a public IP"; fi

echo "== app over HTTP from inside the network: sign-up, heartbeat, webhook inbox, ping monitor, audit export"
html="$(http -fsS "$base/")"
grep -q '<html' <<<"$html" || fail "web app did not serve HTML"
browser_fonts=no; grep -q 'fonts.googleapis.com' <<<"$html" && browser_fonts=yes
api GET /api/config | grep '"auth"' >/dev/null || fail "/api/config missing auth section"
email="byoc-$(openssl rand -hex 6)@example.com"
password="byoc-$(openssl rand -hex 12)"
api POST /api/auth/sign-up/email "{\"email\":\"$email\",\"name\":\"BYOC QA\",\"password\":\"$password\"}" >/dev/null

hb="$(api POST /api/monitors '{"name":"BYOC nightly job","type":"heartbeat","intervalSec":3600,"graceSec":600}')"
hb_id="$(json id <<<"$hb")"; hb_token="$(json heartbeatToken <<<"$hb")"
[[ -n "$hb_id" && -n "$hb_token" ]] || fail "heartbeat monitor create failed: $hb"
http -fsS -X POST "$base/api/heartbeat/$hb_token" | grep '"ok":true' >/dev/null || fail "heartbeat ping was not accepted"
hb_read="$(api GET "/api/monitors/$hb_id")"
grep -q '"status":"up"' <<<"$hb_read" || fail "heartbeat monitor is not up after its ping: $hb_read"

inbox="$(api POST /api/hooks/inboxes '{"name":"BYOC payments callbacks"}')"
inbox_id="$(json id <<<"$inbox")"; inbox_path="$(json path <<<"$inbox")"
[[ -n "$inbox_id" && "$inbox_path" == /api/hooks/receive/* ]] || fail "webhook inbox create failed: $inbox"
nonce="byoc-$(openssl rand -hex 8)"
http -fsS -o /dev/null -X POST -H 'content-type: application/json' -H 'x-event-type: byoc.qualify' --data "{\"nonce\":\"$nonce\"}" "$base$inbox_path" \
  || fail "posting to the webhook inbox failed"
api GET "/api/hooks/inboxes/$inbox_id/events" | grep "$nonce" >/dev/null || fail "webhook event not stored"

ping_mon="$(api POST /api/monitors '{"name":"BYOC loopback ping","type":"ping","target":"127.0.0.1"}')"
ping_id="$(json id <<<"$ping_mon")"
[[ -n "$ping_id" ]] || fail "ping monitor create failed: $ping_mon"
api POST "/api/monitors/$ping_id/check" '{}' | grep '"ok":true' >/dev/null || fail "ping monitor check failed (read-only root, no capabilities)"
ping_read="$(api GET "/api/monitors/$ping_id")"
grep -q '"status":"up"' <<<"$ping_read" || fail "ping monitor is not up: $ping_read"

audit_csv="$(api GET '/api/audit-events/export?format=csv')"
for action in monitor.create hook_inbox.create; do
  grep -q "$action" <<<"$audit_csv" || fail "audit export lacks $action"
done
audit_rows=$(( $(wc -l <<<"$audit_csv") - 1 ))

echo "== recreate the app container: all state lives in the customer database"
docker logs "$cid" > "$work/egress-1.log" 2>&1
"${compose[@]}" up -d --force-recreate montral
wait_healthy
cid="$(app)"
health="$(http -s -o /dev/null -w '%{http_code}' "$base/health")"; [[ "$health" == 200 ]] || fail "health after recreate: $health"
docker exec "$client" rm -f /tmp/jar
api POST /api/auth/sign-in/email "{\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
monitors="$(api GET /api/monitors)"
grep -q "BYOC nightly job" <<<"$monitors" && grep -q "BYOC loopback ping" <<<"$monitors" || fail "monitors did not survive recreating the app container"
api GET "/api/hooks/inboxes/$inbox_id/events" | grep "$nonce" >/dev/null || fail "webhook event did not survive recreating the app container"
docker logs "$cid" > "$work/egress-2.log" 2>&1

echo "== the recorder sees fetch, TLS, net and resolver calls (canary inside the app container)"
canary="$(timeout 60 docker exec "$cid" node --input-type=module -e "
import { Resolver } from 'node:dns/promises';
await fetch('https://byoc-canary-fetch.example.net/', { signal: AbortSignal.timeout(10000) }).catch(() => {});
await new Resolver({ timeout: 2000, tries: 1 }).resolveTxt('byoc-canary-txt.example.net').catch(() => {});
" 2>&1 || true)"
for want in '"host":"byoc-canary-fetch.example.net"' '"name":"byoc-canary-txt.example.net"'; do
  grep -q "BYOC_EGRESS .*$want" <<<"$canary" || fail "egress recorder did not see the canary ($want): $canary"
done

echo "== every connection the server attempted, over both container lifetimes"
facts="$(python3 - "$work/egress-1.log" "$work/egress-2.log" <<'PY'
import json, sys
allowed_hosts = {"customer-db", "127.0.0.1", "::1", "localhost"}
# server.listen(port, BIND_HOST) passes the bind address through dns.lookup; an IP literal resolves locally, no query
allowed_names = {"customer-db", "localhost", "0.0.0.0", "::", "127.0.0.1", "::1"}
events, bad = [], []
for path in sys.argv[1:]:
    for line in open(path, encoding="utf-8", errors="replace"):
        if not line.startswith("BYOC_EGRESS "):
            continue
        e = json.loads(line[len("BYOC_EGRESS "):])
        events.append(e)
        if e["kind"] in ("connect", "udp") and e["host"] not in allowed_hosts:
            bad.append(e)
        if e["kind"] == "dns" and e["name"] not in allowed_names:
            bad.append(e)
db = sum(1 for e in events if e["kind"] == "connect" and e["host"] == "customer-db")
loop = sum(1 for e in events if e["kind"] == "connect" and e["host"] in ("127.0.0.1", "::1", "localhost"))
dns = sum(1 for e in events if e["kind"] == "dns")
if not db:
    print("the recorder logged no database connection: it was not loaded into the server", file=sys.stderr); sys.exit(1)
if bad:
    print("connections outside the customer network:", file=sys.stderr)
    for e in bad[:20]: print("  " + json.dumps(e), file=sys.stderr)
    sys.exit(1)
print(f"{len(events)} recorded attempts: {db} to customer-db:5432, {loop} loopback, {dns} DNS lookups (customer-db, or the local bind address literal), 0 elsewhere")
PY
)" || fail "outbound connection check failed"
echo "$facts"

echo "BYOC_PASS: internal-only network (no route to public names or IPs); app healthy on the BYOC overlay with the customer's own PostgreSQL via DATABASE_URL (bundled postgres off), self-check off, operators none, read-only root filesystem, cap_drop ALL, no-new-privileges, user node; sign-up, heartbeat monitor pinged and up, webhook inbox event stored, loopback ping monitor up, audit CSV export (${audit_rows} rows) with monitor.create and hook_inbox.create; data survived app container recreation; egress recorder: ${facts}; served HTML references Google Fonts for the end user's browser: ${browser_fonts} (browser-side, see docs/BYOC.md)"
