# Same-site login return paths

The client login return path accepted decoded TAB/LF/CR characters. Browser URL parsing removes them, so `next=/%09/evil.example` became an external network-path navigation after successful login or an existing-session check. Removing a supported locale prefix could independently turn `/ja//evil.example` (also `/es` and `/zh-Hans`) into `//evil.example` on English login.

A shared internal-path guard rejects controls, DEL, backslashes and network-path references while returning legitimate paths unchanged. Locale conversion checks both its input and the path after stripping a prefix. Queries, fragments, Unicode, spaces and literal encoded octets remain supported; recursive decoding is deliberately avoided. The separate OAuth resume and registered external callback flows retain their behavior. API SSO already validates its own return path and joins it to its configured origin.

Six RED regressions reproduced the two bypass classes with native WHATWG URL origin checks. The complete web suite then passed 192 tests with one skip; production Astro build passed on Node 24.22.1. Independent fresh prepatch investigation identified the locale-stripping alias, and one fresh postpatch bypass/regression review found no actionable issue. Its focused suites passed 13 tests, and 34,560 actual-helper normalization combinations retained the trusted origin. Source identity and whitespace checks pass.

The demonstrated impact is an attacker-selected external destination after a victim follows a crafted login link. No automatic credential, session or OAuth-token disclosure is claimed. No external destination was contacted in these tests. Require all 16 latest-head PR checks and 11 integrated-main workflows before qualifying the merged revision.
