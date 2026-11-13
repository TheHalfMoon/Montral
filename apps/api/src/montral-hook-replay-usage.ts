import type { Database } from "@montral/repo";

/**
 * Replay attempts are an independent operational counter, NOT webhookEvents
 * intake credits and NOT a billable meter. Count the admission to the outbound
 * attempt before the fetch so a slow or ambiguous network response is not
 * silently free. Each accepted POST is a new intentional attempt.
 *
 * PostgreSQL supplies the UTC month boundary on both read and write; different
 * API replica clocks cannot split a month's attempts. Only workspace+month and
 * counts are persisted: never destination URLs, replay payloads, auth or PII.
 */
export async function migrateHookReplayUsage(db: Database): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS montral_hook_replay_usage (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    period_start date NOT NULL,
    attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    PRIMARY KEY (organization_id, period_start)
  )`);
}

export async function recordHookReplayAttempt(db: Database, organizationId: string): Promise<void> {
  // PostgreSQL's UPSERT serializes same-workspace concurrent replays, even
  // across replicas. There is no read/count/write race or double-read counter.
  await db.query(`
    INSERT INTO montral_hook_replay_usage(organization_id,period_start,attempts)
    VALUES($1, date_trunc('month', NOW() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (organization_id,period_start)
    DO UPDATE SET attempts = montral_hook_replay_usage.attempts + 1
  `, [organizationId]);
}

export async function readHookReplayUsage(db: Database, organizationId: string): Promise<{
  attempts: string;
  periodStart: string;
  periodEnd: string;
}> {
  const rows = await db.query<{ attempts: string; period_start: string; period_end: string }>(`
    WITH p AS (
      SELECT date_trunc('month', NOW() AT TIME ZONE 'UTC')::date AS first_day
    ) SELECT COALESCE(u.attempts,0)::text AS attempts,
      to_char(p.first_day,'YYYY-MM-DD') AS period_start,
      to_char((p.first_day + INTERVAL '1 month')::date,'YYYY-MM-DD') AS period_end
    FROM p LEFT JOIN montral_hook_replay_usage u
      ON u.organization_id = $1 AND u.period_start = p.first_day
  `, [organizationId]);
  const row = rows[0];
  if (!row || !/^\d+$/.test(row.attempts)) throw new Error("Invalid replay count");
  return { attempts: row.attempts, periodStart: row.period_start, periodEnd: row.period_end };
}
