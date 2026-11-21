# CodeQL alert validation checkpoint — 2026-11-21

Repository: `TheHalfMoon/Montral`  
Reviewed default-branch revision: `main@50ebcd65f5b34bef07b03126f60f71ea647c8e16`  
CodeQL run: [44895490015](https://github.com/TheHalfMoon/Montral/actions/runs/44895490015)  
Source workflow: `.github/workflows/codeql.yml` (advanced configuration retained)

## Scan and alert visibility

The exact-main CodeQL workflow completed successfully at the reviewed SHA. GitHub's alert API was readable during this review and returned **25 open CodeQL alerts: 19 high and 6 medium by scanner severity**. The current open Dependabot and secret-scanning alert APIs returned empty lists. Dependabot alerts and security updates, secret scanning, and push protection were rechecked enabled; non-provider secret patterns remain disabled. An empty alert list and a successful scan are observations, not proof that the code is secure.

The user selected a SARIF export while alert APIs were inaccessible. Direct read-only access to alert records and instances became available before this validation, so source locations and messages were reviewed from GitHub's CodeQL alert API. No SARIF attachment was received. Findings below refer to alert numbers in the repository's current CodeQL alert list. No finding is dismissed by this evidence note alone.

## Individual validation and disposition

| Alert | Rule / location | Validation result | Patch or evidence |
|---:|---|---|---|
| 1 | `js/redos`, `apps/api/src/guards/byoc-overlay.test.ts:15` | Confirmed test/CI denial-of-service risk: an ambiguous multiline regex processes a repository-controlled Compose fixture and can backtrack on malformed input. This is not a deployed request-path vulnerability. | Replaced the regex with a bounded line scan; regression supplies 50,000 blank lines and expects a prompt validation error. |
| 2–3 | `js/bad-code-sanitization`, `apps/web/src/pages/ou-analytics.js.ts:26` | False positive. The script URL comes only from operator deployment configuration, is parsed as a URL and restricted to HTTP(S), then encoded with `JSON.stringify` into a separate JavaScript response. The domain value is restricted to an explicit character set. No request value reaches this code-generation path. | No finding dismissal until the evidence is recorded with the alert; operator configuration remains a trusted boundary. |
| 4–7 | `js/clear-text-logging`, `scripts/qualify-upgrade.mjs:69,680,682` | False positive. The snapshot projects only API-key `id`, `name`, `start`, and `prefix`; it never stores the one-time raw key. The summary written and printed contains the API-key count, not the key collection. Failure diagnostics can compare projected metadata, but no bearer credential reaches the log. | Snapshot projection and summary construction inspected at the reviewed revision. |
| 8 | `js/stack-trace-exposure`, `apps/probe/src/handler.ts:13` | False positive. The JSON helper serializes plain response objects. Probe failures pass through `describe`, which returns a timeout label or error code/message and never the `Error.stack`; invalid requests receive fixed validation messages. POST probes also require a valid signature. | `apps/api/src/checker.ts:322-327`; `apps/probe/src/handler.ts:66-83`. |
| 9–11 | `js/client-side-unvalidated-url-redirection`, `apps/web/src/components/AuthForm.tsx:60,133,149` | False positive. All three navigation sites use `nextPath()`, which reads the query value through `URLSearchParams` and `internalPath`; it accepts only a same-site path beginning with one slash and rejects protocol-relative paths, backslashes, and control characters. The OAuth resume target is a fixed same-origin endpoint and is signature-checked server-side. | `apps/web/src/lib/next-path.ts:1-25`; `apps/web/src/components/AuthForm.tsx:10-15`. |
| 12 | `js/xss-through-dom`, `apps/web/public/landing.js:227` | The dynamic `innerHTML` construction was unnecessarily dependent on sample and translation values. Although the current values are checked-in demo data, it created an avoidable DOM-XSS sink. | Replaced string-built markup with DOM nodes, `textContent`, and a fragment-based bar renderer. Added an E2E regression that injects markup into sample copy and verifies it remains text. |
| 13 | `js/reflected-xss`, `apps/api/src/pinnedfetch.test.ts:51` | False positive. This is a loopback-only test server that returns a JSON-serialized object to a test client, which parses it with `res.json()`. The response is not rendered as HTML in a browser and the source is a test request header. | Test-only fixture reviewed; no application HTML sink. |
| 14 | `js/incomplete-url-substring-sanitization`, `apps/web/src/inline/doc-shell.js:32` | False positive. The code walks text nodes and updates `nodeValue`; it does not parse replacement text as HTML, assign a URL, or navigate. The literal domain is a documentation example. | `NodeFilter.SHOW_TEXT` walker and `nodeValue` replacement reviewed. |
| 15 | `js/bad-tag-filter`, `apps/api/src/browser-check.test.ts:204` | Test assertion was case-sensitive and could miss an uppercase script tag in a worker-report fixture. This weakens a test assertion, not the report validator itself. | Expanded the assertion to a case-insensitive script-tag pattern. |
| 16 | `js/bad-tag-filter`, `apps/web/src/lib/hosted-readiness-copy.test.ts:64` | Test-only HTML visibility filter did not accept whitespace and attributes before a closing tag. | Replaced the regex filter with a bounded string scanner and regression coverage for uppercase tags and end-tag attributes. |
| 17–18 | `js/bad-tag-filter`, `scripts/landing-csp.mjs:37,48` | Confirmed correctness weakness in the static landing CSP maintenance check: its parser missed HTML's case-insensitive tag spelling. It is a repository check, not a runtime injection path. | Shared HTML script-tag scanner now recognizes case-insensitive tags and end-tag attributes without regex filtering; regression covers these forms. |
| 19 | `js/bad-tag-filter`, `scripts/verify-csp-hashes.mjs:33` | Confirmed correctness weakness in the built-page CSP hash check for the same HTML parsing reason; the browser still enforces CSP, but the validator could miss a changed script spelling. | Reuses the case-insensitive parser with regression coverage. |
| 20–21 | `js/incomplete-sanitization`, `e2e/tests/cloud-usage.spec.ts:233`, `e2e/tests/journey.spec.ts:331` | Test-only regex filters construct a pattern from the Playwright test server host. The previous code escaped periods but not every regex metacharacter. No application request or user-controlled navigation is affected. | Host escaping now covers all regular-expression metacharacters; end-to-end workflow will qualify the change. |
| 22–23 | `js/incomplete-multi-character-sanitization`, `apps/web/src/lib/hosted-readiness-copy.test.ts:64` | Test-only visibility filter over built legal pages; hidden script/style content is not sent to a browser by this test helper. | The bounded string scanner and regression fix in alert 16. |
| 24–25 | `js/incomplete-multi-character-sanitization`, `apps/web/src/lib/seo-i18n.ts:45,47` | False positive for the current call path. The route fetches built static assets; the localization marker is emitted from checked-in SEO data through `scriptJson`, which escapes `<`. JSON is parsed as data, title/description values are escaped for their HTML contexts, and structured data is re-serialized with `<` escaped. The output is not built from request-provided HTML. | `SeoShell.astro`, `seo-i18n.ts`, and the `/[locale]/[...rest]` static-asset route reviewed. Existing `seo-i18n.test.ts` exercises marker removal and localized output. |

## Verification and limits

Local checks on the remediation working tree:

- API `byoc-overlay` and browser-report tests: **31/31 passed**.
- After the production build, web hosted-readiness and SEO localization tests: **14/14 passed**.
- HTML script-tag regression: **1/1 passed**.
- `pnpm --filter @montral/web build`: passed.
- `node scripts/verify-csp-hashes.mjs apps/web/dist/client`: **75 inline scripts across 35 built pages passed**; no `unsafe-inline` fallback.
- `node scripts/landing-csp.mjs --check`: passed all four landing pages.
- Monorepo typecheck passed for all seven selected workspace projects (web: 0 errors; 6 hints). The root command used pnpm 10.0.0, while recursive scripts reported pnpm 9.12.0 in this shell.
- `node --check apps/web/public/landing.js` and `git diff --check`: passed.
- The local runtime is Node 24.19.0, below the repository's declared Node 24.22.1 minimum; package commands emitted the engine warning. Hosted PR CI remains the authoritative qualification.
- The E2E DOM-XSS regression has not been run locally because the repository test server is not configured in this worktree; it must pass in PR CI.

The local D1 review returned `medium` and `needs_review`; it is advisory, and the tool explicitly warns that its small model can miss severe security bugs. Codex Security diff-scan setup validated the worktree, but its scan launcher refused the same non-bare worktree with “requires a non-bare Git worktree with a resolvable HEAD.” No independent Codex Security scan result is claimed. No external reviewer was available in this session.

At this pre-merge checkpoint, the 14 false-positive records were documented for later evidence-backed GitHub dismissal, and the confirmed CI/parser and DOM-rendering findings remained open while the PR and main analyses were pending. #169 also remained blocked by 65 historical secret-pattern matches and an archived vendor example whose provider/owner validity could not be established from source. Do not treat a zero alert count, this triage, or passing CI as an exhaustive audit or release clearance.

Community publication remains **HOLD**. Cloud and BYOC remain **NO-GO**. No release, publication, deployment, billing, or production credential change was made.

## Post-merge disposition — `main@98239eafb6ba29e7ed73e224e4e5dc281e2c16d2`

PR [#186](https://github.com/TheHalfMoon/Montral/pull/186) merged after all 23 checks passed on its corrected head `268356d8c1014d249545fd17fec5c37247b0d827`. The advanced CodeQL workflow remained unchanged. Exact-main CodeQL workflow [44899983350](https://github.com/TheHalfMoon/Montral/actions/runs/44899983350) completed successfully on the merge SHA.

SARIF was exported directly from the four exact-SHA GitHub analyses: JavaScript/TypeScript `2220619218`, Actions `2220615884`, Go `2220616536`, and Python `2220616974`. The merged SARIF contains 14 JavaScript/TypeScript results and zero results in each other language. Its `versionControlProvenance` in all four runs identifies `98239eafb6ba29e7ed73e224e4e5dc281e2c16d2`. On the resulting main analysis, alerts #1, #12, and #15–#23 are fixed (11); alerts #2–#11, #13–#14, and #24–#25 were dismissed as false positives with an individual evidence-based GitHub dismissal comment (14). The CodeQL open-alert API returned zero after these dispositions. This is alert disposition, not a conclusion that the repository is secure.

The four-run SARIF export assembled from those analysis IDs is available as a task artifact; the repository records the analysis IDs, result counts, and alert dispositions. At the time this checkpoint was drafted, exact-main qualification was still running; final 12-workflow status and run IDs are recorded in `docs/RELEASE-GATES.md` after completion.

Dependabot vulnerability alerts and secret-scanning alert APIs also returned zero open alerts at the recheck, and Dependabot alerts/updates, secret scanning, and push protection remained enabled. The historical 65 Gitleaks matches and archived vendor example remain unresolved under #169. No independent external technical reviewer was available for #186: the Qodo review integration was billing-blocked, the Codex Security scan launcher did not produce a result, and local D1 returned an advisory `medium / needs_review` assessment. Hosted PR gates and manual source review were used; no independent security audit is claimed.
