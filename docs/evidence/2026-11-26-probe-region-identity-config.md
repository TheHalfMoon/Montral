# Probe region identity configuration validation — 2026-11-26

`JSON.parse` accepts repeated object keys and silently keeps the final value. For `PROBE_REGIONS`, that could make the endpoint associated with an operator's region identity depend on duplicate-key ordering.

The parser now detects duplicate **top-level** keys in the original JSON before using the parsed object. It compares decoded JSON key strings, so escaped spellings of the same identity are duplicates. A duplicate rejects the complete region configuration with a fixed diagnostic; no region is enabled even when a shared signing key is configured. Repeated text inside nested metadata or URL strings does not count as another region.

The change does not add API-based registration, endpoint mutation, credential storage or provisioning, source attestation, or production configuration changes. Configured endpoints and signing keys remain deployment-managed. Existing credential-possession validation and lifecycle controls are unchanged.

Regression coverage includes repeated literal and escaped keys, nested lookalike keys, and fail-closed behavior with a configured shared key. The focused `regions.test.ts` suite passed 19/19; API typecheck passed; `git diff --check` passed. Local Node was v24.19.0, below the repository's declared `^24.22.1` requirement, so hosted exact-head checks are required for the supported runtime qualification.

The local d1 review returned a medium-risk advisory. It is not an independent security approval; the implementation was manually checked for JSON string escaping, nested objects and arrays, top-level delimiters, and the caller's preceding full-document `JSON.parse` validation. No independent human GitHub reviewer was available at the time this evidence was drafted.
