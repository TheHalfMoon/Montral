# Montral probe

A probe runs one check on request, from wherever it is deployed. Deploy it in several places and Montral can check a
monitor from all of them, so an outage that only some of the world sees is told apart from a real one.

Probes run **http**, **tcp** and **websocket** checks only. Database checks carry credentials and stay on the scheduler;
heartbeats are not checks of ours at all.

## How it fits together

```
scheduler ──signed POST──▶ https://probe.example.app/api/probe/eu-central ──▶ target
                                         │
              {ok, statusCode, latencyMs, error} ◀──┘
```

Every request carries `x-montral-timestamp` and `x-montral-signature` (HMAC-SHA256 of `<timestamp>.<body>` under `PROBE_SECRET`).
A probe refuses anything unsigned or older than 60 seconds, and refuses private and internal targets whatever the
signature says (unless its own operator sets `ALLOW_PRIVATE_TARGETS`), so it is not an open proxy.

## Run it as a container or on any Node host

The probe is a plain Node server, so it can run on any VPS or machine in any country, with or without Docker. Build the
image from the repository root:

```bash
docker build -f apps/probe/Dockerfile -t montral-probe .
docker run -d --restart unless-stopped -p 8787:8787 \
  -e PROBE_SECRET=$(openssl rand -hex 32) -e PROBE_REGION=sao-paulo \
  montral-probe
curl http://localhost:8787/          # {"ok":true,"region":"sao-paulo"}
```

No Montral probe image or GitHub release has been published. Build the image from this private repository as shown above; do not pull an unrelated registry image.

`docker-compose.yml` in this folder does the same with sensible defaults (loopback-only port, read-only filesystem, no
capabilities) and can terminate HTTPS itself with Caddy:

```bash
cd apps/probe
cp .env.example .env                      # set PROBE_SECRET
PROBE_DOMAIN=probe-sao.example.com docker compose --profile tls up -d   # DNS name must point at this host
```

Without the `tls` profile it listens on `127.0.0.1:8787` for your own reverse proxy. Montral needs an `https` URL
(plain `http` is accepted for `localhost` only).

Without Docker (Node 22):

```bash
pnpm install
pnpm --filter @montral/probe build:node
PROBE_SECRET=… PROBE_REGION=sao-paulo node apps/probe/dist/server.mjs
```

| Variable | Meaning |
|---|---|
| `PROBE_SECRET` | Required. Current signing secret shared with the API; unsigned requests are refused. |
| `PROBE_PREVIOUS_SECRET` | Optional. Older signing key accepted by probes **only** until the explicit UTC expiry below. Never set on the API. |
| `PROBE_PREVIOUS_SECRET_EXPIRES_AT` | Required to activate the previous key. UTC timestamp formatted `YYYY-MM-DDTHH:mm:ssZ` (for example `2027-01-01T00:00:00Z`). If absent, malformed or elapsed, old signatures are refused. |
| `PROBE_REGION` | Label returned by the health check. The name users see comes from the API's `PROBE_REGIONS`. |
| `PORT`, `HOST` | Where to listen. Default `8787` on `0.0.0.0`. |
| `CHECK_USER_AGENT` | User-Agent of HTTP checks. Set it to the same value as on the API so every region looks alike. |
| `ALLOW_PRIVATE_TARGETS` | `true` lets this probe check private and internal addresses of the network it runs in. Off by default. Use it for a probe that lives inside the network you want to watch (an office, a home lab), and only there. |

The server answers `SIGTERM` by finishing checks in flight, so `docker stop` is clean.

### Separate signing keys per probe region (opt-in)

On the scheduler/API deployment, `PROBE_REGIONS` holds **public region URLs**, and a separate **private environment secret** `PROBE_SECRETS` may hold a JSON object keyed by those region IDs. Example (placeholder values only):

```sh
PROBE_REGIONS='{"us-east":"https://north.example.test/check","eu-central":"https://south.example.test/check"}'
PROBE_SECRETS='{"us-east":"<long-random-key-for-north>","eu-central":"<different-long-key-for-south>"}'
```

Each probe must have its **own** `PROBE_SECRET` matching its scheduler-side `PROBE_SECRETS` entry. Set these as private deployment secrets, not in `PROBE_REGIONS`, public documentation, logs, status responses or repository files. An entry overrides the shared `PROBE_SECRET` only for that region; a compromised regional key does not authenticate to any other region that has a different configured key. A region not listed in `PROBE_SECRETS` still uses the legacy shared `PROBE_SECRET` if one exists. For full region isolation, configure **every** remote region and unset the shared fallback. Regions with no signing key are not advertised.

The configuration is deliberately fail-closed: any malformed JSON, unknown region, non-string, too-short or whitespace-padded key in `PROBE_SECRETS` disables **all** remote regions rather than silently falling back to the shared key. The scheduler logs a generic configuration problem without key material. Configure and validate offline before production use.

To rotate one isolated region, first stage its probe with the new primary key, its old key in `PROBE_PREVIOUS_SECRET`, and a short explicit UTC expiry; then update **only** that region's entry in the API `PROBE_SECRETS`, and remove the probe's previous key after all old API replicas drain. No operator API registration, remote secret provisioning or automatic fleet-wide distribution is implemented. Deploying multiple Vercel functions within **one** Vercel project shares its environment variables: per-region isolation requires **separate** project/secret scopes (or independent deployments). Never claim isolation between functions that still use the same key.

### Staged signing-key rotation

For legacy deployments, the API signs with one shared `PROBE_SECRET`. Operators may optionally configure distinct signing keys per region through a private API-side `PROBE_SECRETS` map (see above). Each probe can temporarily verify against its current and previous secrets. To rotate without a synchronized redeployment:

1. First deploy every probe region and replica with the new `PROBE_SECRET`, the old `PROBE_PREVIOUS_SECRET` and a near-future UTC `PROBE_PREVIOUS_SECRET_EXPIRES_AT` deadline that comfortably covers rollout. The expiry is mandatory; missing or expired dates disable old-key verification. Keep the API signing with the old key. Verify a signed check on every region, not merely the unauthenticated health GET.
2. After all probes have been upgraded, switch the API `PROBE_SECRET` to the new key. New signatures will verify, while requests signed by old API replicas can still be accepted during the overlap.
3. After old API replicas and in-flight checks have drained, remove `PROBE_PREVIOUS_SECRET` from every probe. Never leave the old key enabled indefinitely.

The previous-key setting belongs only on probes, including Node, Docker, Vercel or Cloudflare, and never changes the API signer. A probe without a primary key remains disabled regardless of a previous key. The timestamp check still rejects requests outside 60 seconds. The overlap **expires automatically** at the configured UTC deadline, but does not provide independent per-probe identities or remote revocation. A compromised old key remains valid until expiry or removal, whichever happens first. Keep keys in private deployment secrets, not in the repository or command history.

## Deploy to Vercel (several regions)

One project, one function per region, each pinned to a single Vercel region.

```bash
cd apps/probe
pnpm install
pnpm build:vercel                   # all of regions.json; or PROBE_BUILD_REGIONS=us-east,eu-central pnpm build:vercel

npx vercel link                     # once, creates a project for apps/probe
npx vercel env add PROBE_SECRET production   # a long random string; configure matching API PROBE_SECRET or per-region PROBE_SECRETS
npx vercel deploy --prebuilt --prod
```

`regions.json` maps the id Montral uses (`eu-central`) to a Vercel region code (`fra1`). The ids are yours: they are
what monitors store, so renaming one later means re-saving the monitors that use it.

Running a function in more than one region needs a paid Vercel plan, and each plan has its own cap on how many regions
a project may use. Check Vercel's current limits before choosing how many to build. Private targets are always refused
on Vercel.

## Tell Montral about them

On the API (Worker secrets, or `.env` for self-hosting):

```bash
PROBE_SECRET=<the same secret>
PROBE_REGIONS='{"us-east":"https://probe.example.app/api/probe/us-east","eu-central":"https://probe.example.app/api/probe/eu-central","ap-southeast":{"url":"https://probe.example.app/api/probe/ap-southeast","name":"Singapore"},"sao-paulo":{"url":"https://probe-sao.example.com/","name":"São Paulo"}}'
```

A value is a URL, or `{ "url": …, "name": … }` to label it yourself. Nothing configured means every monitor runs from
`auto`, the scheduler's own location, exactly as before. Regions show up in the dashboard and in `GET /api/regions`.

## Develop

```bash
pnpm test        # handler and server: signatures, validation, private-target refusal, real http/tcp/websocket checks,
                 # and the production bundle driven over HTTP under plain Node
pnpm typecheck
```

### HTTP request bodies

Upgrade probes before enabling HTTP bodies or PUT/PATCH/DELETE/OPTIONS checks. The health GET advertises `http-request-body-v1`; the scheduler verifies this before sending new request semantics. Old probes are unavailable for these checks rather than silently dropping a body. If every selected probe is unavailable, existing local fallback applies. Bodies support up to 16 KiB UTF-8, and a probe refuses a signed request larger than 64 KiB before checking the signature. On a redirect to another origin the custom headers are dropped, and a 307 or 308 that would resend the body there is refused; a 301, 302 or 303 turns the request into a GET without the body, and a same-host http to https upgrade keeps it.
