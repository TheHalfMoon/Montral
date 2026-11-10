# Custom-domain withdrawal and failing-streak emails

## Gap
When the scheduled re-check (`recheckCustomDomains`, `apps/api/src/custom-domain.ts`) withdrew a status page's
custom domain, the page silently stopped being served on that host. The reason showed in the editor and in the
workspace audit log, but nobody was told (task ledger item 19).

## Change
- `apps/api/src/domain-notice.ts` queues one email per **owner and admin** of the page's workspace (plain members
  get none):
  - `domain.withdrawn` when the re-check withdraws verification;
  - `domain.failing` when a failing streak reaches its **second** consecutive failed re-check (a single failure is
    usually a DNS blip), at most once per streak. A streak that starts over (record matched again, or the failure
    kind switched between unreachable DNS and a missing record) can warn again.
- Localised through the existing mail i18n (`mail-i18n.ts`, en and zh-CN): the recipient's account language, else the
  workspace owner's, else English. The emails name the domain, the page and the `_montral-challenge.<domain>` record,
  never the TXT value, and link to the page's settings.
- Delivery uses the existing alert delivery log (`alert_delivery`): the same states (pending, sending, sent, failed,
  skipped), the same three-attempt budget with retries after 1 and 5 minutes, and the same stuck-row sweep
  (`sweepDeliveries`). The rows show in the workspace's alert log as "Custom domain withdrawn / failing".
  Incident retries (`claimRetries`) leave these rows to `deliverDomainNotices`, which runs at the end of every
  re-check round (every 5 minutes on the Node server) and so also picks up due retries.
- **Idempotent:** migration `0055` adds `alert_delivery.dedupe_key` with a partial unique index. The key is
  kind + page + streak start + recipient, inserted with `ON CONFLICT DO NOTHING`: one withdrawal (or one streak)
  queues one row per person whatever the retries or racing servers do. The withdrawal itself can only be observed
  once anyway: the `UPDATE` that withdraws requires `custom_domain_verified_at IS NOT NULL`, and a withdrawn domain is
  no longer claimed by later re-checks.
- **Crash-safe, never blocks the withdrawal:** the withdrawing `UPDATE` (or the one recording a streak's second
  failure) also writes the notice into the page's outbox column `status_page.custom_domain_notice`. The withdrawal
  and its notice commit together. The rest happens in one statement at the end of each re-check round
  (`enqueueDomainNotices`): queue one row per owner and admin, then clear the outbox. A crash in between, or a
  failed queue, leaves the outbox set, and the next round (every 5 minutes) queues it. Nothing about the email can
  fail or delay the withdrawal itself. The audit event is unchanged. Provider errors never reach the log or the
  delivery row.
- A notice that no longer applies when it is sent is skipped with a reason: the person is no longer an owner/admin,
  the page or its domain changed, the domain was verified again (withdrawn notice), or the record matched again or the
  domain was withdrawn in the meantime (failing notice).

## Tests (real PostgreSQL in CI, `apps/api/src/domain-notice.e2e.test.ts`)
- A withdrawal emails each owner and admin exactly once (owner + two admins: three emails, one per person) and the
  member none; the zh-CN admin gets the Chinese subject. A re-check of the already-withdrawn domain claims nothing
  and sends nothing; queuing the same withdrawal again inserts nothing.
- The second failed re-check sends one early warning per owner/admin; the first and third send none.
- Three servers re-checking at the same moment withdraw once and email each admin once.
- A refused email is recorded as `failed ... (attempt 1 of 3, trying again in 60 s)` without provider detail, is
  not resent before it is due, and is then delivered by the retry; a recipient demoted in the meantime is skipped.
- A queue failure (INSERT into `alert_delivery` rejected, standing in for a crash between the withdrawal and
  queuing) still withdraws the domain and leaves the notice in the outbox. The next round queues and sends one email
  per owner/admin and clears the outbox.
- `domain-notice.test.ts` (unit): every kind and reason renders in English with domain, page, record and link, and
  in Chinese with no untranslated sentence.

## Limits
- Custom domains exist only on the self-hosted Node server, so the emails need SMTP there; without it they are
  recorded as failed after three attempts.
- Emails are not charged against a workspace email allowance (the self-hosted edition is unmetered).
- An old build started on the upgraded schema treats these rows as orphaned incident retries and marks them skipped
  (see the upgrade and rollback evidence).
