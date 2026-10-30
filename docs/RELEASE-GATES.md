# Montral production release gates — ALL must pass before public deployment

- [x] Exact copies of three donors pinned, license notices preserved, source integrity verified locally
- [x] Montral active core compiled and API/frontend/probe unit suites passed locally
- [x] Webhook API / UI / four additional MCP tools implemented
- [x] Optional on-demand Cloudflare probe source added; no duplicate scheduler by design
- [ ] PostgreSQL end-to-end tenant isolation, auth, migrations and webhook capture tested
- [ ] Browser end-to-end workflow: login, add monitor, create inbox, capture request, inspect event, MCP read/write scoped tokens
- [ ] Edge probe tested on Cloudflare Workers and verified quotas, secrets, private network restrictions
- [ ] Actual 7-day retention even when no new events arrive
- [ ] Atomic concurrent creation quota and full commercial entitlement checks
- [ ] Stored webhook data sensitive-field redaction/retention/privacy, encryption and abuse response
- [ ] Resource limits, load tests, monitoring reliability and disaster recovery
- [ ] Customer plans, billing webhooks and payment-provider settlement tested in sandbox
- [ ] Production domain, email/SMS alert deliverability, privacy/terms, business and tax requirements
- [ ] Complete identity/content and non-attribution legal compliance audit
- [ ] User-controlled final GO for public release. No live launch until then.
