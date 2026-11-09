# Physical macOS / native Safari qualification preflight — 2026-11-09

**Result: BLOCKED for native Safari UI automation; NOT a Safari product pass.**

This record comes from a read-only investigation of an authorized, online **physical Apple Silicon Mac** (not the GitHub Actions macOS runner). No Montral app was installed or served; no customer data, credentials, browser tabs, or user files were read. System authorization to enable Safari's automation was not supplied; no bypass was attempted.

## Measured environment

| Check | Actual result | Implication |
|---|---|---|
| CPU architecture | `arm64` | Physical Apple Silicon macOS host |
| macOS | `26.6.2` | Different OS from CI's macOS 15 ARM64 runner |
| Native Safari | `26.6.2` (WebDriver build `21624.5.1.11.3`) | Native browser available, but **not exercised against Montral** |
| `/usr/bin/safaridriver --version` | Success | Native WebDriver executable present |
| `safaridriver --port 56321` + `GET /status` | `ready: true` | WebDriver transport works |
| `POST /session`, `browserName: safari` | HTTP 500 `session not created`: **"You must enable 'Allow remote automation' in the Developer section of Safari Settings to control Safari via WebDriver."** | Safari remote-automation permission is disabled |
| `safaridriver --enable` | Attempted without sudo; process remained pending with no output, so it was terminated | No successful authorization/enablement confirmed; don't claim it is on |
| Installed Node | `v26.0.0` | Below Montral's documented Node 26 minimum (`26.12.1`); unsuitable for reproducible app build |
| Installed pnpm | `12.16.1` | Differs from repo's pnpm `10.0.0` |
| `docker info` | Cannot connect to Docker daemon | No local Postgres/Compose run available without starting Docker |
| Free volume space reported by `df -h /` | About `10 GiB` | Avoid a full Montral dependency/Docker installation on this Mac |
| Local Montral workspace | Not found in conventional project paths and Spotlight search | No local app to test |

## Verified and not verified

- **Verified:** the physical Mac is remotely reachable; native Safari and its bundled driver exist; driver starts and responds; real Safari **session creation is blocked by an explicit Apple permission**.
- **Not verified:** Montral rendering or behavior in native Safari, macOS VoiceOver/screen reader support, a native macOS self-host install, real iPhone/iPad Safari, or Windows Docker Desktop.
- **Separate evidence:** `.github/workflows/montral-macos.yml` uses a GitHub-hosted macOS ARM64 runner with PostgreSQL 18 for API/browser/backups. Its successful CI does not replace physical Safari testing. `.github/workflows/montral-browsers.yml` tests Playwright WebKit and emulated iPhones, not Apple's native Safari app.

## Minimal safe next actions

1. An authorized Mac user enables Safari **Settings → Advanced → Show features for web developers**, then **Developer → Allow remote automation** (or approves the native `safaridriver --enable` system flow). Don't work around the permission.
2. Obtain a **disposable** Montral Node server with a synthetic local database, preferably hosted on the Windows build machine or an isolated permitted test machine. Do not expose it publicly or use live payments/secrets. Only bind to a network interface if that is explicitly approved; otherwise use a local temporary build after checking disk/resource requirements.
3. Run **native Safari WebDriver** journeys for landing/login/signup, sign-in, dashboard, monitoring, public/password status pages, webhook capture, and light/dark UI. Separate native Safari results from Playwright WebKit.
4. Run **manual VoiceOver** checks with consent on a limited test identity: reading order, labelled controls, status announcements, focus traps, skip link, dialogs and errors. Automated axe is not a substitute.
5. If an Apple iPhone is physically available and authorized, enable its separate WebDriver permissions and qualify actual iOS Safari; never label emulation as hardware testing.
6. Preserve test output, screenshot references only of synthetic data, revision/OS versions, and a precise pass/fail ledger.

**Do not relax release gates or mark native Safari/VoiceOver done before these checks run.**

This is a physical-environment readiness investigation only; it did **not** modify Montral app code or install dependencies.
