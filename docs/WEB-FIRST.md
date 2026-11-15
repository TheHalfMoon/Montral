# Decision: Montral is web-first (2026-11-15)

**Status:** Adopted for current engineering; **not a production launch approval**.

## Product and delivery surface

Montral is a single open-source operations platform delivered as a **website and responsive web application**, with a browser-installable Progressive Web App (PWA). A separate native Windows/macOS Electron/Tauri binary is **not** on the current roadmap. Reconsider native desktop only after demonstrated user need and an approved maintenance and distribution budget. A PWA is not a native desktop executable.

The existing product surfaces share the **Montral / Threshold** identity:
- Public marketing site and installation documentation.
- Signed-in dashboard for monitoring, incidents, on-call, alerts, webhooks, teams, status pages and account settings.
- Public status pages and embedded status surfaces.
- REST/MCP integrations backed by the same authentication and PostgreSQL state.
- A manifest with `display: "standalone"`, icons and an `/app` entry point so compatible browsers can offer installation.

The current architecture uses Astro/React for the web UI, and the Node/server API and database for state. Cloud/enterprise-specific features require separate qualification; they are not implied by a community build.

## Security and offline boundary

The service worker is deliberately **shell-only**. It can cache the static `/app` shell and its build-hashed `/_astro` assets, not authenticated API responses, user sessions, monitoring results, webhooks, billing data, or other private data. Being installable does **not** mean Montral can monitor targets or show fresh private data offline. Real data always comes from the API; an unavailable server remains unavailable.

Keep token-bearing mobile registration and user-specific state out of cached pages and browser-visible URLs whenever possible. Preserve the separate legacy mobile API until an approved migration exists.

## Visual-design handoff

The Threshold identity, landing, app shell and public status pages were introduced through the project's web design changes (#127–#135). The original editable design source and any pixel-perfect approval must be verified separately; a low-resolution design-board screenshot is a reference, **not** proof of full visual QA. Development should integrate with the existing Astro/React components rather than creating an unrequested second desktop app.

## Acceptance before calling this web release ready

1. Confirm all active application paths work from real session and API keys using synthetic PostgreSQL tests, including relevant authorization negatives.
2. Verify responsive layouts and actual browser journeys across Chromium, Firefox, WebKit and mobile-size viewports; confirm keyboard/focus and WCAG accessibility test results. Physical Safari/VoiceOver remain a separate device gate.
3. Ensure PWA manifest, icon paths, versioned shell caching and updates pass their focused unit and browser tests. Never cache private responses.
4. Verify the entire **combined current main head** (not only individual PR heads) through GitHub's required CI matrix including PostgreSQL versions, builds, browser, Docker/replicas, load, failover and backup/rollback. Do not describe old green runs as current.
5. Keep explicit distinction between an engineering-qualified self-hosted candidate and an **authorized public release**. No tags, images, deployments, paid services or new DNS without the owner's `GREEN LIGHT MONTRAL`. Cloud and enterprise BYOC additionally require live providers, independent penetration testing, legal/privacy review and production operational approval.

See [Release gates](RELEASE-GATES.md), [Task ledger](TASK-LEDGER.md), and [Architecture](ARCHITECTURE.md) for detailed technical and external blockers.
