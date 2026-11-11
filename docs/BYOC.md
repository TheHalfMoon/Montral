# Enterprise BYOC (bring your own cloud) reference deployment

This page is for a customer that runs Montral inside its own cloud account or data centre, against its own PostgreSQL,
and needs to know exactly what crosses its network boundary and what the vendor can reach. It describes what the code
does today and cites it (`path:line`, at the commit this page was written against; `apps/api/src/guards/byoc-overlay.test.ts`
fails if a cited file or line no longer exists). Where something is documented but not machine-verified, it says so.

Everything here is the self-hosted Docker build. Hosting, its cost and its operation are the customer's. There is no
license server, no license key and no product-side license enforcement: the repository is MIT-licensed (`LICENSE`), and
a deployment without a hosted edition reports itself as the community edition with unmetered allowances
(`apps/api/src/edition.ts:12`).

## 1. Deployment modes

| Mode | Command | What it is |
| --- | --- | --- |
| Single host | `docker compose up -d --build` | `docker-compose.yml`: one app container (API, web app and check scheduler in one Node process) and a bundled, pinned PostgreSQL 18. See `/docs/self-host#docker`. |
| BYOC overlay | `docker compose -f docker-compose.yml -f docker-compose.byoc.yml up -d --build` | The same app container against the customer's own PostgreSQL (`DATABASE_URL`), no reference-URL self-check, published on host loopback only, read-only root filesystem, no Linux capabilities, `no-new-privileges`, operator control plane pinned off. Qualified in CI (section 9). |
| Replicas | add `-f docker-compose.replicas.yml` | Several app replicas behind an nginx load balancer sharing one PostgreSQL; checks, escalations and deliveries are claimed in the database, so replicas need no coordination of their own. Qualified by `scripts/qualify-replicas.sh`; see `/docs/self-host#replicas`. |
| Browser checks | add `-f docker-compose.browser.yml` | A separate, hardened `browser-runner` container (Chromium) that gets no database URL and no app secrets, reachable from the app only over an internal network. Qualified by `scripts/qualify-browser-runner.sh` (workflow `montral-browser-checks.yml`); see `/docs/self-host#browser-checks`. |

The overlays combine (`-f docker-compose.yml -f docker-compose.byoc.yml -f docker-compose.replicas.yml`), but only the
BYOC overlay alone is qualified by the BYOC job; the combination is documented, not machine-verified. With the
replicas overlay the load balancer, not the app, publishes the port, so `PUBLISH_ADDRESS` from the BYOC overlay does
not apply there.

## 2. Customer-owned PostgreSQL

Set `DATABASE_URL=postgres://user:password@host:5432/db` in `.env`; the BYOC overlay passes it to the app and leaves the
bundled `postgres` service off (it is behind the `bundled-postgres` profile). The app runs its migrations in one
transaction on start, before it accepts requests (`/docs/self-host#upgrade`). Any PostgreSQL the customer operates or
buys as a managed service works the same way; the qualified server version is the one `docker-compose.yml` pins
(PostgreSQL 18, checked by `scripts/qualify-docker.sh`). The pool size is `DB_POOL_MAX` (default 10,
`apps/api/src/server.ts:105`): with replicas, budget `replicas x DB_POOL_MAX` connections.

`docker-compose.yml` interpolates `POSTGRES_PASSWORD` even when the bundled database is not started, so `.env` must
still contain a value (`POSTGRES_PASSWORD=unused`). Without the bundled database the app does not wait for one: it
retries its first connection for a bounded time and exits if the database stays unreachable (`restart: unless-stopped`
then restarts it).

## 3. Secrets

| Secret | Where it is read | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | `apps/api/src/server.ts:46-50` | Required. Signs sessions and tokens; keep it identical across upgrades, restores and replicas (`/docs/self-host#upgrade` relies on the same secret). |
| `DATABASE_URL` | `apps/api/src/env.ts:10` | The customer's database credentials. |
| `CRON_SECRET` | `apps/api/src/server.ts:46` | Optional; unset keeps `/internal/*` closed. |
| SMTP / Resend, OIDC client secret, GitHub OAuth secret, APNs key, `BROWSER_RUNNER_TOKEN` | `apps/api/src/env.ts` | Each only when that feature is wanted. |

Compose reads them from `.env` (keep it `chmod 600`, out of version control). Compose cannot turn a Docker secret file
into an environment variable by itself, and the app reads no `*_FILE` variables, so with Docker secrets or a cloud
secret manager the customer injects the values into the container environment with its own tooling (for example
rendering `.env` at deploy time). `MONTRAL_PLAN_CONFIG` / `MONTRAL_PLAN_CONFIG_JSON` (plan catalog) are only for a
deployment that meters usage; a BYOC deployment leaves them unset, together with every `MONTRAL_BILLING_*`,
`MONTRAL_METERING_ENABLED` and `LEMONSQUEEZY_*` variable.

## 4. Identity

Already supported, documented in `/docs/self-host`:

- Instance-wide OpenID Connect (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAINS`) and
  per-workspace SSO connections (`/docs/self-host#sso`). An identity provider on a private network or plain http needs
  `SSO_ALLOW_PRIVATE_IDP=true` (`apps/api/src/sso-oidc.ts:108-114`).
- SCIM 2.0 user provisioning and deprovisioning (`/docs/self-host#scim`).
- `DISABLE_SIGNUP=true` closes registration once the first account exists; invited people can still join.
- Two-factor authentication, available to every account.

## 5. Upgrade, rollback, backup and disaster recovery

- Upgrade and rollback: `/docs/self-host#upgrade`. Back up, pull the new source, `docker compose ... up -d --build`.
  Migrations only go forward; an older build refuses to start on a newer schema and changes nothing. Rolling back means
  restoring the pre-upgrade backup into an empty database. The procedure is qualified in CI by
  `scripts/qualify-upgrade.mjs` (workflow `montral-upgrade.yml`): seeded upgrade, rollback, and recovery from backups.
- Backup and restore: `/docs/backup`. With a customer-owned database, use the customer's own `pg_dump -Fc` / managed
  snapshots; the commands in `/docs/backup` run unchanged against any reachable PostgreSQL. `scripts/qualify-backup.mjs`
  and `scripts/qualify-backup-negative.mjs` qualify the documented commands.
- Keep `.env` (above all `BETTER_AUTH_SECRET`) with the backups: a restore needs the same secret.

## 6. Trust boundary: every outbound connection the software makes on its own

"On its own" excludes what a workspace user deliberately points it at: monitor targets (HTTP, TCP, ping, DNS record
names, certificates, WebSocket, browser-check pages) and alert channels (webhooks, Slack, Telegram, PagerDuty, Pushover,
email recipients). Those go where the user configures them, from the app container (or the browser-runner). Private
and internal addresses are refused unless `ALLOW_PRIVATE_TARGETS=true`.

The Montral server, browser-runner and probe contain **no telemetry, no usage reporting, no update check and no
phone-home**: a search of `apps/` and `packages/` for vendor or third-party hosts finds only the entries below, and the
BYOC CI job proves that a running instance contacts nothing but its database (section 9).

### Server (app container)

| Destination | Purpose | When | How to disable / redirect |
| --- | --- | --- | --- |
| `www.cloudflare.com`, `www.gstatic.com`, `www.apple.com` (`apps/api/src/selfcheck.ts:8-12`) | "Is it the target or us?" self-check: before a network-level check failure is recorded, the prober fetches these to tell an outage from its own lost connection | Only after a monitor check fails at the network level (DNS, connect, timeout), at most once per 5 s (`apps/api/src/selfcheck.ts:33-35`, `apps/api/src/selfcheck.ts:55-58`). Never at startup. | `SELFCHECK_URLS=` (empty) turns it off (`apps/api/src/selfcheck.ts:19-27`); the BYOC overlay does this by default. Set internal reference URLs instead to keep the feature inside the network. |
| `cloudflare-dns.com` (DNS over HTTPS) (`apps/api/src/dns.ts:40-44`) | Resolver for **DNS monitors** (a fixed public resolver so a record change never redirects the connection) | Only for DNS-type monitors a user creates | No setting; do not create DNS monitors, or use HTTP/TCP monitors. The name looked up is the user's target. |
| `data.iana.org` and the registry's RDAP server it names (`apps/api/src/domain-expiry.ts:7`) | Domain registration expiry | Only for domain-expiry monitors a user creates | No setting; do not create domain monitors. |
| The system DNS resolver, TXT queries (`apps/api/src/custom-domain.ts:65-70`) | Re-verifying status page custom domains and verified SSO email domains, every 6 hours (`apps/api/src/server.ts:244-252`) | Only when such domains exist | Do not configure custom domains / SSO domain verification. Uses the container's resolver, i.e. the customer's DNS. (`cloudflare-dns.com` in `apps/api/src/sso-domains.ts:17` is the Workers edition only, `apps/api/src/routes/sso.ts:200`.) |
| SMTP server from `SMTP_URL` / `SMTP_HOST`, or `smtp.resend.com:465` with `RESEND_API_KEY` (`apps/api/src/server.ts:74-84`) | Invitations, password reset, alert emails; a connection test at startup (`apps/api/src/server.ts:93`) | Only when SMTP or Resend and `EMAIL_FROM` are set | Leave unset: emails are written to the log instead. Point `SMTP_HOST` at an internal relay. |
| `github.com` / `api.github.com` (`apps/api/src/auth.ts:273-275`) | GitHub sign-in | Only with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, during a GitHub sign-in | Leave unset. |
| The OIDC issuer (discovery, token, JWKS) (`apps/api/src/sso-oidc.ts:108-114`) | Single sign-on | Only with `OIDC_*` set or a workspace SSO connection, during sign-in | Leave unset; use an IdP inside the network with `SSO_ALLOW_PRIVATE_IDP=true`. |
| `challenges.cloudflare.com` (Turnstile verification, `apps/api/src/auth.ts:545`) | Bot check on email sign-up | Only with both `TURNSTILE_*` keys | Leave unset. |
| `api.push.apple.com` (`apps/api/src/apns.ts:68`) | iOS push notifications | Only with all four `APNS_*` set and a registered device | Leave unset. |
| URLs in `PROBE_REGIONS` (`apps/api/src/probes.ts:155-174`) | Remote regional probes | Only with `PROBE_REGIONS` set and a monitor assigned to a region | Leave unset (the default): checks run from the app container only. |
| `api.lemonsqueezy.com` (`apps/api/src/montral-billing.ts:731-733`) | Checkout for the hosted billing edition | Only with billing configured | Leave every billing variable unset (BYOC never needs them). |
| `BROWSER_RUNNER_URL` | Signed jobs to the browser-runner | Only with browser checks enabled | Internal network of `docker-compose.browser.yml`. |

The HTTP `User-Agent` of checks names the project (`apps/api/src/netguard.ts:18-24`); it is a header sent to the
user's own targets, not a connection, and `CHECK_USER_AGENT` replaces it.

### Browser-runner (optional container)

It opens no connection of its own: it serves signed jobs on port 8090 (`apps/api/src/browser-runner.ts:126`) and its
Chromium visits only the pages of the browser check. Chromium is launched with background networking, component
updates, domain reliability reporting, sync, crash upload, phishing detection and pings disabled
(`apps/api/src/browser-worker.ts:38-53`). This is documented from the launch flags, not measured by the BYOC job.

### The end user's browser

These are requests the **user's browser** makes when it loads Montral pages; they leave from the user's device, not from
the server, and the BYOC job reports but does not block them:

| Destination | When | How to disable |
| --- | --- | --- |
| `fonts.googleapis.com` / `fonts.gstatic.com` (`apps/web/src/layouts/Base.astro:27-28`, allowed by the CSP in `apps/web/astro.config.mjs:54`) | Every page | **No setting today.** Block at the egress proxy (pages fall back to system fonts) or change the layout in a fork. Listed under "not yet provided". |
| `favicon.im` (`apps/web/src/lib/brand.ts:8`, used at `apps/web/src/pages/status/[slug].astro:79`) | A public status page that has a website link set shows that site's logo | Leave the status page's website link empty. |
| `challenges.cloudflare.com` (`apps/web/src/components/AuthForm.tsx:24`) | Sign-up form, only with Turnstile keys set | Leave `TURNSTILE_*` unset. |
| `plausible.io` or `PLAUSIBLE_SRC` (`apps/web/src/pages/ou-analytics.js.ts:15-16`) | Only with `PLAUSIBLE_DOMAIN` set | Leave `PLAUSIBLE_DOMAIN` unset (the default). |

## 7. What the vendor can access

By default, **nothing**. The software contains no remote administration channel, no support backdoor, no telemetry and
no outbound connection to the vendor (section 6); all data, sessions and audit events are in the customer's database.

- The operator control plane (`/api/operator`, `docs/OPERATOR.md`) exists only for users whose ids are listed in
  `MONTRAL_OPERATOR_USER_IDS` (`apps/api/src/env.ts:38-42`, mounted at `apps/api/src/app.ts:215-217`); unset or empty
  means every operator endpoint answers 403. The BYOC overlay pins it to empty, so even a stray `.env` value cannot turn
  it on; a customer that wants it for its own staff edits that line deliberately. Even then operators see workspace
  metadata, not monitor targets, channels, incidents or audit logs, and cannot sign in as a customer
  (`docs/OPERATOR.md`, "What operators can see").
- The vendor has no account on a BYOC instance unless the customer creates or invites one.

### Support-access procedure (recommended)

1. The customer invites a named vendor engineer by email into the one workspace concerned, with the least role that
   suffices (a member rather than an admin or owner), and never adds them to `MONTRAL_OPERATOR_USER_IDS`.
2. Time-box it: invitations expire after `INVITE_TTL_DAYS` (default 7, `apps/api/src/auth.ts:33-35`); set a short value
   for the session, and remove the member from the workspace as soon as the work is done.
3. Prefer screen sharing over access when the question allows it; never share `.env`, database credentials or backups.
4. Afterwards, review the workspace audit log (Workspace, Audit log; `GET /api/audit-events`) for the engineer's actions
   between invitation and removal, and export it for the ticket (below).

There is no built-in "support session" with automatic expiry of the membership itself; the expiry above applies to the
invitation, and removing the member is a manual step.

## 8. Compliance evidence the customer can produce

- **Audit log export**: `GET /api/audit-events/export?format=csv|jsonl` (`apps/api/src/routes/audit.ts:49-54`, mounted
  at `apps/api/src/app.ts:307`), up to 100,000 events per export (`apps/api/src/audit.ts:68`); the export itself is
  recorded as `audit.export`. The `audit_event` table is append-only apart from the retention function
  (`AUDIT_RETENTION_DAYS`, `/docs/self-host`).
- **Network evidence**: run `scripts/qualify-byoc.sh` on the customer's own build host; it prints `BYOC_PASS` with the
  recorded connection attempts (section 9).
- **Qualification scripts** the customer can rerun against its own build: `scripts/qualify-docker.sh` (image, compose,
  persistence, downgrade refusal), `scripts/qualify-replicas.sh`, `scripts/qualify-upgrade.mjs`,
  `scripts/qualify-backup.mjs`, `scripts/qualify-backup-negative.mjs`, `scripts/qualify-browser-runner.sh`.
- **Source provenance**: `docs/SOURCES.md` and `docs/source-manifest.json` record upstream sources and file hashes.

## 9. What CI verifies (job `byoc` in `.github/workflows/montral-docker.yml`)

`scripts/qualify-byoc.sh` builds the image, then on a `docker network create --internal` network (no route out):

- proves the network has no egress (public names and public IPs unreachable from it);
- starts a separate PostgreSQL as the "customer database" and the app with `docker-compose.yml` +
  `docker-compose.byoc.yml` as shipped (only the app service active, self-check off, operators empty, read-only root
  filesystem, `cap_drop: [ALL]`, `no-new-privileges`, user `node`), and requires it to migrate and turn healthy;
- signs up, creates a heartbeat monitor and pings it (status `up`), creates a webhook inbox and stores a posted event,
  runs a loopback ping monitor, exports the audit log as CSV, recreates the app container and reads everything back;
- preloads `scripts/byoc-egress-log.cjs` (test-only) into the server process, which records every TCP/TLS connect, UDP
  send and DNS query; the job fails if anything other than the customer database and loopback was attempted, and a
  canary proves the recorder sees `fetch` and resolver calls.

It prints `BYOC_PASS` with these facts. **Documented only, not verified by that job**: the browser-runner's own
behaviour, the end-user-browser requests (it only reports whether the HTML references Google Fonts), the replicas and
browser overlays combined with BYOC, a real managed PostgreSQL service, and every feature that is off in the run
(SMTP, SSO, GitHub, APNs, probes, DNS and domain monitors).

## 10. Not yet provided

- No managed upgrade channel or update service: upgrades are pulled and built by the customer (`/docs/self-host#upgrade`).
- No published or signed container images, SBOM or provenance attestation: the customer builds the image from source.
- No license server or license key: none is needed (section intro).
- No way to self-host the web fonts by configuration: the pages load Google Fonts from the user's browser.
- No `*_FILE` secret variables (Docker secrets must be injected as environment variables by the customer's tooling).
- No time-boxed support membership: invitations expire, memberships must be removed by hand.
- No egress allow-list inside the app beyond the private-address guard: restrict outbound traffic with the customer's
  own firewall or proxy, allowing only the monitor targets and channels the customer uses.
- No high-availability database setup: the customer's PostgreSQL provides it.
