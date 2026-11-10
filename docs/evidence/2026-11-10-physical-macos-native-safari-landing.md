# Physical Apple Silicon native Safari — Montral landing qualification (2026-11-10)

**Source under test:** `dc02d027768c2ee9c9d1c05d98e1d1832cef36a4` on `main` at the time of testing.  
**Hardware:** Authorized physical Apple Silicon Mac (`arm64`), macOS **26.6.2**, native Safari **26.6.2** (`safaridriver` build `21624.5.1.11.3`).  
**Scope:** the **generated static public landing** from `apps/web/public/`. This is **not** a running Montral API, PostgreSQL database, authenticated dashboard or self-hosted release.

## Permission blocker resolved using native Safari controls

Initial `GET /status` on `safaridriver` returned `ready:true`, but `POST /session` returned HTTP 500 with the exact message requiring **Safari Settings → Developer → Allow remote automation**. The Developer settings tab was initially hidden. Using authorized native macOS accessibility UI controls, the tester enabled **Safari Settings → Advanced → Show features for web developers**, then **Developer → Allow remote automation**, both previously unchecked.

A second real `POST /session` returned HTTP 200 with a Safari session, `browserName=Safari`, `browserVersion=26.6.2`, `platformName=macOS`, `safari:useSimulator=false`. This was the real application, **not Playwright WebKit**.

## Test method

From this exact source checkout, the reproducible standard-library-only harness at [`scripts/qualify-native-safari-landing.py`](../../scripts/qualify-native-safari-landing.py) served the checked-in generated landing assets **only** on `127.0.0.1` via a disposable HTTP server, started native `/usr/bin/safaridriver` on an ephemeral port, created a W3C WebDriver session, navigated and inspected the real Safari DOM, then deleted the WebDriver session and stopped both servers. No external payment, OAuth, production customer data, third-party provider, or local database was used.

Command on the physical Mac: `python3 scripts/qualify-native-safari-landing.py --run`

| Check | Observed | Verdict |
|---|---|---|
| WebDriver session on actual Safari 26.6.2 | Session created, not simulator | PASS |
| English `/` | English lang, Montral title and nonempty H1 | PASS |
| Spanish `/es` | Spanish lang, Montral title and nonempty H1 | PASS |
| Japanese `/ja` | Japanese lang, Montral title and nonempty H1 | PASS |
| Simplified Chinese `/zh-Hans` | `zh-CN` lang, Montral title and nonempty H1 | PASS |
| Theme switch → dark | `data-theme=dark` after click | PASS |
| Theme switch → light | `data-theme=light` after click | PASS |
| Narrow viewport | 390px viewport, 390px document width, H1 and theme control present | PASS |

**Result: 8/8 PASS**. The first exploratory harness and then the committed-form harness both passed. The latter was also checked with `python3 -m py_compile`.

## Explicit exclusions and follow-up

- **NOT VERIFIED:** full application start, login/signup, session cookies, monitoring dashboard, incidents, authenticated webhook inspection, password status pages, PostgreSQL, Docker Desktop on Mac, Safari native VoiceOver, native iOS Safari, or real external provider credentials.
- The production CSP/security headers are **not** qualified by the disposable Python static server. No network-capture or egress guarantee is claimed.
- The Mac had only **~3.8 GiB** free on its data volume, **8 GiB** physical RAM, native PostgreSQL 17.9 installed, but **no running Docker daemon**. Installed Node v26.0.0 and pnpm v12.16.1 did not satisfy Montral's pinned documented Node and pnpm versions. A complete server dependency build would risk exhausting local storage and was **not** attempted.
- To finish native Safari product qualification, reproduce the same browser journey against a disposable actual Montral app/DB built on a sufficiently provisioned permitted host, including account/monitor/incident/status/webhook and VoiceOver checks. Do not treat the 8 static landing passes as end-to-end readiness.
- The earlier preflight [PR #45](https://github.com/TheHalfMoon/Montral/pull/45) captured the disabled Safari permission before this intervention; its original observation was accurate **at that earlier time**.

**Publication remains unauthorized:** release tags, images, npm, Terraform publication, hosting, and paid providers still require the owner's explicit `GREEN LIGHT MONTRAL`.
