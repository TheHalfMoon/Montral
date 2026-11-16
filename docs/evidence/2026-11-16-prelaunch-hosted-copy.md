# Hosted-service claims and legal-template readiness (2026-11-16)

**Status: candidate engineering correction; no production legal approval, release, or deployment.**

## Finding

The source tree's published marketing text described a Montral Cloud service with current plans and prices, even though only the free Community self-hosted source is currently eligible for engineering qualification. `docs/RELEASE-GATES.md` and `docs/FINAL-REPORT.md` mark Cloud/BYOC **NO-GO** pending external security, provider, infrastructure, commercial and legal readiness. English and Chinese use-case/comparison pages repeated the false plan claims. The terms and privacy static pages represented a hosted service at the placeholder `montral.invalid` as active and contained fictitious `legal@` / `privacy@` email addresses; the intended operator has not approved those legal documents.

This is a source copy/release-gate inconsistency, **not evidence of any real customer accepting terms or of a real hosted service processing data**.

## Source corrections

- `apps/web/src/lib/seo-pages.ts` and `apps/web/src/pages/for/index.astro`: Community self-hosting is described as free software requiring the operator's own infrastructure. A Cloud edition is explicitly **not publicly available or priced**. This applies to pricing FAQs, comparison tables, hosting mode, use-case copy and relevant features. No secret commercial prices or invented subscription terms were added.
- `apps/web/src/pages/terms.astro` and `apps/web/src/pages/privacy.astro`: both static English/Chinese documents carry **unapproved draft / not in force** headings and intros, `noindex,nofollow` metadata, revised dates and no fictitious operational domains or contact mailboxes. Legacy clauses remain in the document as working material *for legal counsel*, not binding terms. A qualified legal reviewer must approve an entirely accurate final policy/terms for the future operator before launch.
- `apps/web/src/pages/docs/self-host.astro`: update both duplicated English and Chinese `LEGAL_LINKS` setup instructions to state that the bundled terms/privacy documents are unapproved drafts and must be replaced by the operator's applicable legally reviewed policies before enabling sign-up consent.
- `apps/web/src/lib/hosted-readiness-copy.test.ts` guards EN/ZH Cloud unavailability, self-host operator warnings, and draft legal/not-indexed status against regressions. Source-level tests do not replace a legal or browser inspection.

## Scope and verification limits

Only public copy and source tests change. No API, database, billing feature flag, billing provider, DNS record, deployment or real customer data is affected. No built-in Cloud payment or merchant account is activated. The legacy copyright and MIT license are unchanged.

Require a supported Node runtime, frozen pnpm install, web typechecks, Astro production builds (including CSP and SEO), locale rendering, accessibility and all 11 workflows / 16 constituent CI jobs **on the final exact head**. Physical Safari and real privacy practices remain external validation requirements. The local Windows Node 24.19.0 is below the repository's supported 24.22.1 floor and cannot qualify this change.

**Final publication HOLD until explicit `GREEN LIGHT MONTRAL`, independent security and legal/privacy approval, and real hosting/provider readiness.** This PR does not approve or publish contractual terms.
