import type { Repo } from "@montral/repo";
import type { Entitlements } from "./entitlements";
import { emailEnabled, sendEmail } from "./email";
import { previousMonth, renderMonthlyReportMessage, REPORT_DAYS } from "./reports";

/**
 * STAGED INTERNAL WORKER. Not connected to cron, queue routes, HTTP handlers or
 * the existing monthly report sender. Synthetic local E2E evidence only.
 *
 * An `attempted` result represents a durable *right to try once*, not a
 * provider-accepted message. A timeout might occur AFTER provider acceptance;
 * it is never safe to retry automatically. `attempted` left by a crashed
 * worker must be reviewed as ambiguous, never resent.
 */
export async function dispatchPreparedMonthlyOutbox(
  repo: Repo, entitlements: Entitlements, orgId: string, now = new Date(),
) {
  const result = { claimed: 0, accepted: 0, uncertain: 0, quotaDenied: 0 };
  // Email provider and idempotent metering are mandatory. In particular, the
  // unmetered open-source edition must never fall through to legacy spendEmails.
  if (!entitlements.claimMonthlyOutboxAttempt || !emailEnabled() || now.getUTCDate() > REPORT_DAYS || !orgId)
    return result;
  const month = previousMonth(now);
  const [year, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(year, m - 1, 1));
  const to = new Date(Date.UTC(year, m, 1));
  let source: Awaited<ReturnType<Repo["preparedMonthlyReportRecipients"]>>;
  let workspace: Awaited<ReturnType<Repo["organization"]>>;
  let components: Awaited<ReturnType<Repo["monthlyReport"]>>;
  try {
    [source, workspace, components] = await Promise.all([
      repo.preparedMonthlyReportRecipients(orgId, month),
      repo.organization(orgId),
      repo.monthlyReport(orgId, from, to),
    ]);
  } catch {
    console.error("monthly outbox preparation unavailable");
    return result;
  }
  if (!workspace || !source.length || !components.length) return result;

  for (const recipient of source) {
    // Render the entire message before reserving quota or moving an outbox row
    // to attempted; a bad row must not consume an allowance or silence peers.
    let message: ReturnType<typeof renderMonthlyReportMessage>;
    try {
      message = renderMonthlyReportMessage({
        workspace: workspace.name, month, comps: components, owner: recipient,
      });
    } catch {
      console.error("monthly outbox message preparation unavailable");
      continue;
    }

    let claim: Awaited<ReturnType<NonNullable<Entitlements["claimMonthlyOutboxAttempt"]>>>;
    try {
      claim = await entitlements.claimMonthlyOutboxAttempt(orgId, month, recipient.userId);
    } catch {
      console.error("monthly outbox atomic claim unavailable");
      continue;
    }
    if (claim === "quota_denied") { result.quotaDenied++; continue; }
    if (claim !== "attempted") continue;
    result.claimed++;

    let outcome: "accepted" | "uncertain" = "uncertain";
    try {
      await sendEmail(message, true);
      outcome = "accepted";
    } catch {
      console.error("monthly outbox provider acceptance uncertain");
    }
    // Persistence failures cannot undo SMTP acceptance. They leave a durable
    // `attempted` record; no automatic replay is permitted by the SQL claim.
    try {
      if (await repo.finishMonthlyReportRecipient(orgId, month, recipient.userId, outcome)) {
        if (outcome === "accepted") result.accepted++;
        else result.uncertain++;
      } else {
        console.error("monthly outbox result persistence unavailable");
      }
    } catch {
      console.error("monthly outbox result persistence unavailable");
    }
  }
  return result;
}

/**
 * STAGED batch orchestrator, deliberately NOT wired to cron or HTTP routes.
 * Commit the workspace-month claim together with all recipient snapshots;
 * then rediscover previously committed `prepared` recipients on every call.
 * A crash before commit leaves no claim, and a crash after commit can recover
 * unattempted recipients. Attempted/uncertain/accepted mail is never replayed.
 */
export async function runStagedMonthlyOutboxBatch(
  repo: Repo, entitlements: Entitlements, now = new Date(), limit = 20,
) {
  const result = { workspaces: 0, claimed: 0, accepted: 0, uncertain: 0, quotaDenied: 0 };
  if (!entitlements.claimMonthlyOutboxAttempt || !emailEnabled() || now.getUTCDate() > REPORT_DAYS)
    return result;
  const month = previousMonth(now);
  try {
    await repo.claimMonthlyReportsWithRecipients(month, limit);
  } catch {
    // All new claims/snapshots rolled back. Previously committed prepared work
    // could still be safe to recover; do not return early after this failure.
    console.error("monthly outbox atomic owner snapshot unavailable");
  }
  let pending: string[];
  try {
    pending = await repo.recoverPreparedMonthlyReportWorkspaces(month, limit);
  } catch {
    console.error("monthly outbox recovery query unavailable");
    return result;
  }
  for (const orgId of pending) {
    result.workspaces++;
    try {
      const sent = await dispatchPreparedMonthlyOutbox(repo, entitlements, orgId, now);
      result.claimed += sent.claimed;
      result.accepted += sent.accepted;
      result.uncertain += sent.uncertain;
      result.quotaDenied += sent.quotaDenied;
    } catch {
      // One workspace's render/query failure must not starve another.
      console.error("monthly outbox workspace dispatch unavailable");
    }
  }
  return result;
}
