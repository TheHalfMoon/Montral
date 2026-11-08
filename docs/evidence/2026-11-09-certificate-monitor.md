# TLS certificate monitor type

## Gap
Montral watched domain registration expiry but not the TLS certificate a
host serves: an expiring, expired, untrusted or mismatched certificate was
only noticed when an HTTPS check started failing (and not at all for TLS
services that no HTTP monitor covers).

## Change
- New monitor type `certificate` (`apps/api/src/certificate.ts`). Target is
  `host` or `host:port` (default 443), parsed by `strictHostPort` (no scheme,
  path, user info or spaces). `targetProblem` refuses a malformed target and,
  as for tcp, any private or internal target unless `ALLOW_PRIVATE_TARGETS`.
- The check dials through `dialEach`, so it connects only to addresses the
  guard resolved and validated, then `tls.connect({ host: <address>, port,
  servername: <hostname>, rejectUnauthorized: true, ALPNProtocols:
  ["http/1.1"] })`. SNI is omitted for an IP literal target, whose address is
  then checked against the certificate's IP SANs. `node:tls` is imported
  dynamically, so the Workers bundle still builds (checked with
  `wrangler deploy --dry-run`).
- Verdicts: more than N days left passes; inside the window fails with
  `Certificate for <host> expires in <d> days (<date>, issued by <issuer>)`
  (issuer CN, else O, printable ASCII, at most 64 characters). Verification
  and handshake failures (`CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID`,
  `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`,
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`, other
  `CERT_*` / `UNABLE_TO_*` codes, `ERR_SSL_*`, `EPROTO`) resolve to fixed
  messages; OpenSSL and peer text are never stored. A TLS-level failure is the
  answer of the first address that completes a TCP connection; network
  failures (refused, unreachable, timeout) are thrown, so `runCheck`'s
  `proberFault` logic decides whether they are inconclusive, as for tcp.
- Workers: the check returns `{ ok: false, inconclusive: true, error:
  "Certificate checks need the self-hosted Node runtime" }` (not recorded),
  and `POST /monitors` and import refuse the type with 400.
- Warning window: the existing `domain_expiry_warn_days` column
  (`domainExpiryWarnDays`, 1-365, default 30) now applies to domain and
  certificate monitors. No column change; comments and API descriptions say so.
- Enum: `0045_monitor_certificate.sql` is a single `ALTER TYPE
  "public"."monitor_type" ADD VALUE 'certificate'`, the same shape as
  `0029` (websocket) and `0040` (domain). The migrator runs all pending
  migrations in one transaction; PostgreSQL 12+ allows `ADD VALUE` there as
  long as the new value is not used in that transaction, and no migration
  uses it. `migrations.generated.ts` regenerated.
- Scheduler: certificate monitors share the domain rules through
  `expiryCheck`: failures below `failureThreshold` are `degraded`, latency
  never marks them slow, and a down certificate monitor never suppresses a
  dependent monitor's incident. Incident title is `<name>: certificate
  expires soon` when the failure is the warning-window message, otherwise
  `<name>: certificate invalid` (`certificateIncidentTitle`).
- Intervals are bounded to 3600-86400 s for certificate wherever domain was
  (create, import with a warning, patch). Regions: `auto` only (not a
  `PROBE_TYPES` member).
- UI: "TLS certificate" in the type picker (`CERT` label), target label
  "Host or host:port", placeholder `example.com`, warn-days field for domain
  and certificate, warn days in the detail grid; zh strings added. Errors
  show in the check-results list as for other types.
- Docs: `docs/api.astro` type list, target, `domainExpiryWarnDays`,
  interval bounds and a "TLS certificate" section (en/zh).

## Evidence
- `apps/api/src/certificate.test.ts` (19 tests, all passing locally, none
  skipped; certificates generated per run with the openssl CLI, `openssl ca`
  with explicit `-startdate`/`-enddate`, because `*.pem` and `*.key` are
  gitignored and committed fixtures with relative dates would rot):
  - certificate verdict > passes a certificate with more than the warning window left
  - certificate verdict > fails inside the warning window with the days left, the date and the issuer
  - certificate verdict > fails an expired, not yet valid or undated certificate even when verification let it through
  - certificate verdict > keeps a peer-supplied issuer name printable and short
  - certificate verdict > maps TLS failures to fixed messages and leaves network failures to the caller
  - certificate verdict > names incidents after what the failure was
  - certificate targets > takes host or host:port and refuses anything else
  - certificate targets > refuses private targets unless ALLOW_PRIVATE_TARGETS, like tcp
  - certificate targets > is inconclusive on Cloudflare Workers, which have no node:tls
  - certificate checks over TLS > passes a trusted certificate for the host with time to spare
  - certificate checks over TLS > fails a trusted certificate inside the warning window, naming the days, date and issuer
  - certificate checks over TLS > fails an expired certificate
  - certificate checks over TLS > fails a certificate that is not valid yet
  - certificate checks over TLS > fails a certificate for another hostname
  - certificate checks over TLS > checks an IP literal target against the certificate's IP address, without SNI
  - certificate checks over TLS > fails self-signed and untrusted chains against the runtime's own roots
  - certificate checks over TLS > reports a port that does not speak TLS as a failed handshake
  - certificate checks over TLS > leaves a refused connection to the network-failure logic: a failure, not a certificate verdict
  - certificate checks over TLS > times out a server that never finishes the handshake
- `apps/api/src/scheduler.test.ts`:
  - certificate monitors > marks a failing certificate degraded below the failure threshold, like domain
  - certificate monitors > titles the incident from the failure once the threshold is reached
  - checkOne noise rules > never suppresses a service incident because a certificate monitor is internally down
- `apps/api/src/regions.test.ts`: effectiveRegions > defaults to auto and only applies to http, tcp and websocket (now also asserts domain and certificate stay on `auto`).
- `apps/api/src/certificate.e2e.test.ts`: certificate monitors through the API > validates targets, bounds intervals, keeps one region and refuses Workers deployments. Needs `TEST_DATABASE_URL`; skipped locally (no PostgreSQL), runs in CI.
- `tsc -p apps/api --noEmit` and `astro check` (web): 0 errors.
  `node scripts/gen-migrations.mjs --check`: in sync (46).
  `scripts/verify-active-branding.sh`: pass.

## Limits
- Node runtime only. On Workers existing certificate monitors stay
  inconclusive and nothing is recorded; the API refuses new ones.
- Trust is the runtime's default root store (`NODE_EXTRA_CA_CERTS` extends
  it); there is no per-monitor CA, no revocation (OCSP/CRL) check and no
  STARTTLS: the port must speak TLS from the first byte.
- Only the first address that completes a TCP connection is judged; other
  addresses of the same name may serve a different certificate.
- No certificate state is stored (unlike `domainExpiry`): the public status
  page shows the monitor's ordinary status, so an expiring certificate that
  reached `failureThreshold` reads as down there, and alert headings use the
  generic down/recovered wording.
- The route e2e test was not run locally.
