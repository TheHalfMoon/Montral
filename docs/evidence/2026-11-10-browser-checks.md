# Browser (multi-step) checks

## Gap
Montral had no browser or multi-step checks (task ledger item 16; gap matrix row
"Browser / multi-step"). A sign-in or checkout flow could only be watched one HTTP
request at a time, without cookies, forms or page JavaScript.

## Architecture
- **Monitor type `browser`.** Migration `0054_monitor_browser` adds the enum value,
  the `monitor.browser` and `monitor.browser_secrets` jsonb columns, and the table
  `browser_check_run` (including a `deferred` flag).
- **Declarative journey** (`browser-steps.ts`). Steps are `goto`, `click`, `fill`
  (a literal value or a `secretRef`), `press`, `waitFor`, `assertText`, `assertUrl`
  (`*` glob only, no regular expressions) and `assertStatus`. No step evaluates code.
  Limits:
  - 1 to 20 steps, the first a `goto`, which becomes the target;
  - length caps on selectors, values, texts, URLs and keys;
  - per-step timeout 0.5 to 30 s; journey timeout 5 to 60 s;
  - at most one run every 300 s.
- **Docker: a separate browser-runner service** (`browser-runner.ts`, image target
  `browser-runner`, `docker-compose.browser.yml`). The app sends each run to it over
  an authenticated internal channel (`browser-runner-protocol.ts`). The app keeps
  the default image, which contains no browser.
- **Per-check worker** (`browser-worker.ts`): one short-lived process per check,
  with a forward egress proxy (`browser-egress.ts`) and a fresh Chromium. In Docker
  it runs inside the runner. Without Docker it runs in the app's process tree
  (documented as weaker; the runner is recommended there too).
- **Supervision** (`browser-check.ts`): slots per server and per workspace;
  wall-time, RSS and CPU limits for the whole process tree; orphan clean-up;
  availability probe; mapping of results.
- **Secrets** (`browser-secrets.ts`): AES-256-GCM, bound to workspace, monitor and
  secret name.

## Threat model
The attacker is a workspace member, or anyone who controls a monitored page.
They want to:
1. reach the server's own network: metadata endpoints, the database, the app,
   other containers;
2. read local files or browser internals;
3. read another workspace's data: cookies, secrets, results;
4. read this or another monitor's secrets;
5. exhaust CPU, memory, processes or disk, or starve other tenants;
6. turn a Chromium bug (a renderer or sandbox escape) into access to the app's
   secrets or data;
7. run their own code on the server.

## Controls (and the test that proves each)

| Threat | Control | Evidence |
|---|---|---|
| 6 Sandbox escape | In Docker, Chromium never runs in the app's container. The runner holds only `BROWSER_RUNNER_TOKEN` and its limits: no `DATABASE_URL`, `BETTER_AUTH_SECRET` or app settings. It sits on an `internal` network shared with the app plus its own egress network, never on the database network. It runs as `node` with `cap_drop: [ALL]`, `no-new-privileges`, a read-only root, size-limited `/tmp` and `/dev/shm`, `pids_limit`, `mem_limit` and `cpus`, and a seccomp profile equal to Docker's default plus exactly `clone`, `unshare`, `setns`, `chroot` (not `unconfined`). Chromium's own sandbox stays on; `BROWSER_CHECK_SANDBOX=off` is honoured only with `NODE_ENV` set to `development` and makes checks unavailable otherwise | `scripts/qualify-browser-runner.sh` in CI: the runner's container env and `/proc/1/environ` hold no app secrets; CapEff 0; NoNewPrivs 1; read-only root; seccomp set and not unconfined; PostgreSQL unreachable by name and by IP from the runner while the same probe connects from the app; the default image contains no browser; a journey created through the API runs in the runner and the monitor goes up. `guards/browser-runtime.test.ts` (compose, Dockerfile and profile shape); `browser-check.test.ts` (sandbox-off refused) |
| 6 Channel | HMAC-SHA256 over method, path, timestamp, nonce and body hash, using a token of at least 32 characters. Clock skew must be within 60 s and each nonce is single-use (bounded cache), checked in constant time. Request bodies are capped at 512 KiB. Responses are signed over the request's nonce, status and body hash, and capped at 2 MiB. Each job carries one run's journey and only the secrets that run needs, already decrypted | `browser-runner.test.ts`: unsigned, wrong token, stale, replayed, tampered body, wrong path and oversized requests are refused; unsigned answers are refused by the app; the busy answer works; a short token is refused at start |
| 7 Own code | Fixed step vocabulary with strict schemas (unknown keys and actions refused) and no `evaluate`. The selector denylist (`internal:`, `_react=`, `_vue=`) keeps journeys on stable engines and is **not** a security control | `browser-steps.test.ts`; e2e `evaluate` journey gets 400 |
| 1 Internal network | Chromium's only way out is the worker's proxy: loopback not bypassed, Chromium's resolver mapped to NOTFOUND, `disable_non_proxied_udp` for WebRTC, QUIC off. Each destination is resolved once per check, every address must be acceptable, and the proxy dials the validated IP itself. Private addresses need `BROWSER_CHECK_ALLOW_PRIVATE_TARGETS`, a separate opt-in from `ALLOW_PRIVATE_TARGETS`. Loopback, link-local, metadata (`169.254/16`, `0/8`, `100.100.100.200`, `fd00:ec2::254`, `fe80::/10`, in IPv4-mapped, compatible, NAT64 and 6to4 forms), `localhost` names and a deny list are always refused. The deny list holds the server's own interface addresses, plus the app's address (the request's peer) on the runner. The runner drops any test allowance from jobs | `browser-egress.test.ts`: every spelling, mixed DNS answers, IDN, rebinding (one lookup, every dial to the validated IP), deny list in any spelling, loopback with the opt-in. Integration tests: redirect to metadata, private iframe, fetch/XHR/WebSocket/beacon/img to private addresses in every spelling (canary sees 0), WebRTC STUN/TURN (UDP and TCP), ICE host candidates to IP literals and WebTransport (UDP and TCP canaries see 0), and through the runner the loopback site is refused despite the app's allowance. e2e: loopback, `[::1]`, mapped loopback, localhost and metadata journeys refused at creation with both opt-ins on. Runner qualification: metadata, loopback, localhost, `browser-runner` and `montral` journeys refused |
| 2 Local files, internals | Playwright routing aborts every scheme except http(s), ws(s), small `data:`, `blob:` and `about:blank`. Downloads and service workers are blocked, popups closed, dialogs dismissed | integration "file:// / chrome://", "popups" |
| 3 Cross-tenant | Per-check process and temp/home directory, deleted afterwards; fresh Chromium and context. Runs and screenshots are read through the workspace and project scope | integration "shares nothing between checks"; unit "deletes the per-check temporary directory"; e2e stranger gets 404 |
| 4 Secrets | Encrypted, with the key from HKDF over `BETTER_AUTH_SECRET` and AAD = workspace + **monitor id** + name (the id is chosen before insert). Write-only for every role; never exported; the audit log records only the field name. Changing the journey while keeping stored secrets needs an owner or admin. Secrets are masked in results, and screenshots mask secret-filled and password fields. **Screenshots of runs that used secrets are for owners and admins only, decided by the run's own `used_secrets` flag**, never by the monitor's current settings; changing a monitor's secrets deletes those screenshots. Secrets travel to the runner encrypted with a key derived from the runner token | `browser-secrets.test.ts` (ciphertext from another monitor refused); e2e: a ciphertext copied onto another monitor gives "secret is not set"; a member gets `hasScreenshot: false` and `403 screenshot_managers_only`, still after the owner changes the journey to use no secret, and after the member strips the secrets the screenshot is gone for everyone (404); a run without secrets stays visible to members; `browser-runner.test.ts` (sealed secrets); secrets never returned |
| Blind monitors | A check that did not happen is recorded as a run: `deferred` (capacity) or `error` (runner unreachable, refusing, unsigned or malformed answer, Chromium not starting, no report, browser checks disabled), with a fixed message, never a verdict. After 3 in a row the monitor gets `unchecked_since` (shown as "Unchecked", not its last status) and its owners and admins get one e-mail per streak, logged as `monitor.unchecked` in the alert log; the next real run clears it. `GET /api/monitors/browser-runtime` shows every member the runtime's state and latest problem | `browser-unchecked.test.ts` (runs recorded, unchecked after 3, one notice per streak, cleared by a real run, a later streak notifies again, skipped notice logged without addresses); `browser-runner.test.ts` (unreachable runner -> error run + runtime health; malformed answer -> fixed error run); e2e: 4 checks against an unreachable runner -> 4 error runs, `uncheckedSince` set, status unchanged, one `monitor.unchecked` delivery, runtime endpoint shows the problem, a real run clears it |
| Untrusted reports | Every worker or runner report is validated against a strict schema before use: types and ranges, step actions from the vocabulary, errors only from the fixed set (anything else, such as page text, makes the whole run a fixed `error` run), screenshot base64 only; unknown fields are dropped | `browser-check.test.ts` (wrong types, page text in an error, a non-base64 screenshot -> "Browser worker report was malformed"; extra fields dropped); `browser-runner.test.ts` (malformed runner answer) |
| 5 Exhaustion and fairness | `MAX_BROWSER_CHECKS` per server plus **one per workspace**, with a bounded wait of 15 s; then the check is **deferred**. Minimum interval 300 s. The runner has its own slots and answers busy when full. Wall limit, RSS of the whole tree (`BROWSER_CHECK_MAX_RSS_MB`), 30 CPU-s, renderer and worker heap caps. Transfer caps of 10 MB per connection and 25 MB per check, at most 256 connections. A crashed worker leaves nothing behind: every process whose command line names the check's profile directory is killed, with its descendants. Runner container limits: 1024 pids, 2 GB, 2 CPUs, and Docker's init as PID 1 (`init: true`) so orphans are reaped | Unit: per-workspace fairness, bounded waits. Integration: huge page, infinite loop, memory bomb, cap 2 with 3 checks, and "a worker that crashes mid-check leaves no Chromium behind" (`process.abort()` while Chromium runs; Chromium seen during the run, none left after). Runner qualification: PID 1 is `docker-init`; a worker killed with SIGKILL mid-journey inside the runner leaves no zombie and no Chromium. e2e: interval raised to 300 |

Results never contain page content. A run records, per step, `{action, ms, ok}`;
the failing step index and a fixed message; the main-frame status; the number of
blocked requests and popups closed; and the measured RSS and CPU.

## Measured limits
CI, `montral-browser-checks.yml` on ubuntu-latest with the Playwright 1.64.1
headless shell and the sandbox on (first head of #52; the limits are unchanged
since):

| Case | Linux (CI) |
|---|---|
| Login journey, 8 steps | journey 323 ms; peak RSS of the whole tree 609 MiB; CPU 1.1 s |
| Huge page (40 MB) cut at the transfer cap | 0.85 s |
| Slow page (8 s) with 2 s step timeout | 2.9 s |
| Infinite loop, 10 s journey | 4.8 s |
| Memory bomb, RSS limit 700 MiB (test setting) | killed by the RSS limit after 1.05 s, peak 762 MiB |
| 3 concurrent checks, cap 2 | 2 ran, 1 deferred |

After the security review (same CI job, head with the runner): login journey 356 ms, peak RSS
622 MiB, CPU 0.95 s; memory bomb killed by the RSS limit after 1.05 s (peak 752 MiB). Through the
hardened browser-runner stack (`scripts/qualify-browser-runner.sh`), a public journey (goto,
assertText, assertUrl, assertStatus) took 166 ms of journey time, peak RSS 377 MiB, CPU 0.93 s, with
the custom seccomp profile and the sandbox on. From the runner, `postgres` did not resolve and
PostgreSQL's address (172.19.0.2:5432) timed out, while the same probe connected from the app.

Images (CI, `docker image ls`): the default `montral` image is 252 MB with no browser (unchanged; CI
checks there is no Chromium, playwright-core or worker in it); `montral-browser-runner` is 1.21 GB.

Sizing follows from these numbers. A simple journey peaks at about 600 MiB for the
whole tree (worker, Chromium browser, renderer, GPU and utility processes). Hence
the 1024 MiB default per check, and the runner's 2 GB / 2 CPUs for the default of
2 concurrent checks.

## Response to the security review of #52 (head a138a29)
1. **(HIGH) Browser in the app's container with seccomp unconfined.** Fixed by the
   separate browser-runner service described above, with its own image, no app
   secrets, no database network, the signed channel and the hardened compose
   settings. The seccomp profile is a custom one (Docker default plus four
   syscalls), qualified on GitHub's ubuntu runners. The plain-Node mode remains,
   and the docs state its risk and recommend the runner.
2. **(medium) Chromium outliving a crashed worker.** Fixed: processes are found by
   the per-check profile directory in their command line (plus descendants) and
   killed after every run and on every exit path. Proven by the abort test on
   Linux.
3. **(medium) Fairness.** Fixed with one check per workspace at a time, a 300 s
   minimum interval, deferred runs recorded, and an alert after 3 deferrals in a
   row.
4. **(medium) WebRTC / WebTransport.** Covered by negative integration tests (UDP
   and TCP canaries). The existing flags were enough
   (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, `--disable-quic`,
   proxy only).
5. **(medium) Private targets.** Fixed with the separate opt-in
   `BROWSER_CHECK_ALLOW_PRIVATE_TARGETS`. Loopback, the server's own addresses and
   the app's address are always refused, at creation and at run time.
6. **(low) Screenshots and secrets.** Fixed: managers only when the journey uses
   secrets.
7. **(low) AAD.** Fixed: workspace + monitor id + name.
8. **(low) Selector denylist.** Kept, and documented as not a security control.

## Response to the re-review of #52 (head b0fc4f2)
1. **(medium) Screenshot authorization used the monitor's current secrets.** Fixed: each run stores `used_secrets`, and authorization reads it from the run. Changing a monitor's secrets deletes the screenshots of runs that used them. The e2e covers both bypass paths (journey changed by the owner, secrets stripped by a member).
2. **(medium) Blind monitors.** Fixed: error and deferred runs are recorded and visible. Monitors are marked unchecked after 3 in a row, owners and admins are notified once per streak through e-mail and the alert log, and there is a runtime-health endpoint and UI line.
3. **(low) Zombies.** `init: true` on the runner and on the app in the browser compose file. CI asserts that PID 1 is `docker-init` and that no zombie or Chromium remains after a worker is killed inside the runner.
4. **(low) Report validation.** Strict zod schemas for reports and runner answers; anything unexpected becomes a fixed error run.
5. **(low) Non-loopback canary.** The WebRTC/WebTransport test also targets UDP and TCP canaries on the machine's non-loopback interface address (required in CI); both see nothing.
6. **(info)** The runner's 401 answer is the same for every reason. Secrets are sealed (AES-256-GCM with a key derived from the token); the rest of a job is signed but not encrypted, on an internal-only network.

## What is NOT covered
- **Scripting.** No user JavaScript, conditionals, loops, file uploads,
  multi-tab flows (popups are closed) or MFA/TOTP generation.
- **Workers.** Cloudflare Workers cannot run browsers: there, creation is refused
  and checks are inconclusive. Only the `auto` region is supported.
- **Resource limits off Linux.** RSS, CPU and orphan scanning use `/proc` and work
  only on Linux. On macOS and Windows (development) only wall-time limits and heap
  caps apply, and a crashed worker's Chromium is reached through the worker's tree
  only.
- **The runner and the internet.** The runner can reach the internet by design.
  Anything a page makes Chromium send goes out through the policy-enforcing proxy,
  but an attacker who escaped both Chromium's sandbox and the container would hold
  the runner's token. They could read the secrets of jobs the runner is
  running at that moment and submit jobs with its token, but would still have no database
  access or app secrets.
- **gVisor** is offered as an option, not set up or tested.
- **Same-host processes.** Inside the runner, the per-check proxy listens on
  loopback without authentication while a check runs. It reaches only
  policy-allowed destinations.
- **Inspection.** WebSocket and TLS content are not inspected (tunnels are
  byte-metered only). `data:` URLs inside a page are limited only by Chromium and
  the renderer heap.
- **Page-displayed secrets.** A page may render a typed secret back as text
  outside the filled field. Screenshots of runs that used secrets are visible to
  managers only and deleted when the secrets change; screenshots are off by
  default.
- **Unchecked notices** go to owners' and admins' e-mail only (not to alert
  channels), once per streak; without a mail provider the notice is logged as
  failed in the alert log and the monitor still shows as unchecked.
- **Job confidentiality.** Apart from the sealed secrets, a job (journey, limits)
  crosses the internal jobs network signed but in clear text.
- **Key rotation.** Rotating `BETTER_AUTH_SECRET` makes stored secrets
  undecryptable; they must be entered again.
- **Import.** Browser monitors cannot be imported. Exports include the journey but
  never secrets.
