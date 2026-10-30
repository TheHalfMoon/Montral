# Montral release gates

The private repository and donor snapshots do not imply a deployable SaaS.

- [ ] Real Montral-branded API and dashboard builds pass unit, integration and full E2E tests
- [ ] Monitoring scheduler operates once per monitor; probe results correct under retries/timeouts
- [ ] No legacy webhook PHP service exposed to the internet; modern receiver passed security review
- [ ] Cross-tenant isolation, OAuth MCP scopes, replay authorization and token redaction verified
- [ ] SSRF protection, rate limiting, payload size/retention, abuse prevention and input validation verified
- [ ] Plan entitlements and metering validated for each product/API/MCP route
- [ ] Payment lifecycle verified with provider's sandbox webhooks (signature, deduplication, failure, cancellation, refund)
- [ ] Backup, restore, schema migration and rollback drill completed
- [ ] Secrets excluded from git, supply-chain scan and pinned build artifact generation completed
- [ ] Cost load-test confirms resource quotas on free and paid infrastructure
- [ ] License and third-party asset provenance and required notices retained
- [ ] Business, privacy, terms, support, customer onboarding and notification sending verified
- [ ] No public launch or paid infrastructure until explicit release decision
