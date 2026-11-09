# ICMP ping monitor type

## Gap
Montral had no ICMP ping monitor (gap matrix item 1). Hosts that answer ping
but expose no TCP or HTTP service, such as routers, firewalls and bare servers,
could not be watched.

## Change
- New monitor type `ping` (`apps/api/src/ping.ts`), enum value added by
  migration `0050_monitor_ping` (`ALTER TYPE ... ADD VALUE 'ping'`, as for
  `certificate` in 0046). Repo, schema, API, web and docs type lists updated.
- Target: a hostname (LDH labels) or an IP literal (IPv6 optionally in
  brackets, no zone id), parsed by `pingHost` in `netguard.ts`. Scheme, port,
  path, spaces, user info, leading hyphens and numeric IPv4 spellings
  (`2130706433`, `127.1`, `0x7f.1`) are refused with a fixed message.
  `targetProblem` refuses malformed targets always, and private or internal
  targets unless `ALLOW_PRIVATE_TARGETS`, exactly like tcp.
- Execution: `guardedAddress` (new in `netguard.ts`) resolves the name once
  through `guardHosts`, so every resolved address is validated, and returns one
  IP literal (IPv4 preferred). With `ALLOW_PRIVATE_TARGETS` nothing is refused
  but the name is still resolved here, so the binary never receives a name
  (no DNS rebinding between check and ping). The literal is re-checked with
  `net.isIP` before the spawn.
- The process is started with `spawn(file, args, { shell: false })`, stdin
  ignored, `LC_ALL=C`. A hard timeout (remaining check time + 1 s) sends
  SIGKILL; output is read up to 16 KiB and the process is killed beyond that.
- Arguments per platform (`pingCommand`):
  - Linux iputils: `ping [-6] -n -c 1 -W <sec> <ip>`
  - BusyBox (`ping` on the PATH resolving to `busybox`): `ping [-6] -c 1 -W <sec> <ip>`
    (no `-n`: not accepted by every BusyBox build, and an IP needs no lookup)
  - macOS: `ping -n -c 1 -t <sec> <ip>`; IPv6 `ping6 -n -c 1 <ip>` (ping6 has
    no overall timeout flag; the hard timeout ends it)
  - Windows: `ping -n 1 -w <ms> [-6] <ip>`
- Parsing (`parsePingOutput`): a reply needs exit status 0 and a reply line
  (`ttl=` / `TTL=` / macOS `hlim=`, or for Windows IPv6 a `time…ms` line that
  is not a summary). Windows' exit 0 for a router's "Destination host
  unreachable" is therefore not a reply. The time is the first `[=<] <n> ms`
  on the reply line (`time=12.3 ms`, `time<1ms` → 1, `Zeit=15ms`,
  `时间<1ms`, decimal comma). Unreadable times (other units, other scripts)
  and times beyond the check budget fall back to the measured wall time.
- Results: reply → up with the RTT as latency (slow threshold applies as for
  other availability checks). No reply → thrown `No ping reply`; hard timeout
  → thrown `Ping timed out` (both go through `runCheck`'s prober-fault logic
  like tcp). "Network is unreachable" / "Address family not supported" /
  Windows "General failure" → thrown with code `ENETUNREACH`, so a prober
  without the route (e.g. IPv6 in a v4-only container) is inconclusive.
  Missing binary (spawn ENOENT/EACCES) or a permission error from the binary
  → failed check `Ping unavailable on this server`. Stored errors are only
  these fixed strings or the netguard's own messages; command output is never
  stored or logged.
- Workers: the check is inconclusive (`Ping checks need the self-hosted Node
  runtime`), and creating or importing a ping monitor on Workers is refused
  with 400. `node:child_process` is imported dynamically.
- Regions: not in `PROBE_TYPES`, so ping runs from `auto` only; a remote region
  is refused like other non-probe types. Intervals are not bounded beyond the
  usual 60–86400 s. Scheduler semantics are those of tcp (incident title
  "<name> is down").
- Docker: Dockerfile and docker-compose.yml comments, self-host docs
  (`/docs/self-host#ping`, en + zh) and API docs explain that BusyBox ping in
  `node:22-alpine` as `USER node` uses unprivileged ICMP sockets, which need
  `net.ipv4.ping_group_range` to include the process's group (Docker 20.10+
  default `0 2147483647`), with a commented `sysctls` block for older engines.
- UI: type card "Ping (ICMP)", label "Hostname or IP address", help text
  saying it needs the self-hosted server and ICMP permission; zh strings.
- Comparison/SEO pages (`apps/web/src/lib/seo-pages.ts`) no longer say Montral
  has no ping monitor; they say ping (like certificate checks) needs the Node
  runtime. Uptime Kuma `type: "ping"` records now import as ping monitors.
  Gap matrix updated.

## Tested (locally, Windows 11, Node 22)
- `npx vitest run src/ping.test.ts src/regions.test.ts src/netguard.test.ts`:
  65 passed, 0 skipped. `ping.test.ts` (35 tests) covers:
  - argument construction for iputils, BusyBox, macOS (incl. ping6) and
    Windows, IPv4 and IPv6, the 1 s minimum, address as last argument;
  - parsing Linux iputils, BusyBox, macOS ping/ping6, Windows (incl.
    `time<1ms`, IPv6 without TTL), German/French/Chinese Windows, decimal
    comma, Cyrillic units (replied, time unreadable), Windows unreachable with
    exit 0, non-zero exits, permission errors (BusyBox, iputils), local
    network errors, garbage input;
  - the real runner: SIGKILL at the hard timeout, output cap with kill,
    stdout+stderr+exit code, ENOENT reported (not thrown), shell
    metacharacters passed as one literal argument;
  - checks with an injected runner: only the validated literal reaches the
    binary, names are resolved to a literal (`localhost`), RTT fallback and
    implausible RTTs, refusal of private/loopback/link-local/ULA/internal
    names by default with nothing spawned (and a failed, not inconclusive,
    `runCheck` result), acceptance with `ALLOW_PRIVATE_TARGETS`, malformed
    targets refused even with private targets allowed, unavailable binary,
    permission denied, no reply without command output, timeout, hard-timeout
    budget, ENETUNREACH classification, Workers inconclusive;
  - `targetProblem("ping", …)` with and without `ALLOW_PRIVATE_TARGETS`;
  - a real ping of 127.0.0.1 with `ALLOW_PRIVATE_TARGETS` (ran and passed on
    Windows here; skips when ping is unavailable, except on Linux CI where an
    unavailable ping fails the test).
- `scheduler.test.ts` (new ping case: refused loopback target opens "API is
  down" without spawning anything), `regions.test.ts`, `certificate.test.ts`,
  `checker.test.ts`, `netguard.test.ts`: passed.
- Web: `apps/web` vitest 26 files / 123 passed.
- `pnpm -r typecheck`: passed.
- `wrangler deploy --dry-run` for apps/api: the Workers bundle builds.
  `build:node` (esbuild server bundle): builds.

## Not tested / limits
- `ping.e2e.test.ts` (API on real PostgreSQL: enum value from 0050 stored,
  target validation, private refusal, region refusal, PATCH, Kuma import
  preview, Workers 400) skips locally (no PostgreSQL); it runs in GitHub CI.
- Not run in the Docker image. That BusyBox ping in `node:22-alpine` as
  `USER node` works through unprivileged ICMP sockets with Docker's default
  `ping_group_range` is based on BusyBox's documented SOCK_DGRAM fallback and
  Docker's 20.10 default, not on a run here (no Docker locally). If it does not
  work, checks report `Ping unavailable on this server`, which is the intended
  fail-safe, but the feature would then need the documented `sysctls` setting.
- Linux iputils, BusyBox and macOS argument sets are covered by unit tests on
  sample output only; only Windows `ping.exe` was executed for real here.
  GitHub's ubuntu runners execute the real-ping test with iputils.
- BusyBox `-W` semantics (wait for the first response) and `-6` support depend
  on the build; Alpine's BusyBox has both, other builds were not checked.
- Locale variants are sample-based; unknown formats fall back to wall time.
- The Workers miniflare tests (`*.workers.test.ts`) time out on this Windows
  machine with or without this change (checked by running one against
  origin/main's `checker.ts`); they were not used as evidence.
