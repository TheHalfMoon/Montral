import type { Database } from "@montral/repo";
import type { Bindings } from "./env";
import type { Entitlements, Plan, CreditBalance } from "./entitlements";
import { unmetered } from "./entitlements";
import { billingReady } from "./montral-billing";

export type MontralTier = "free" | "pro" | "business";
const TABLE: Record<MontralTier, {
  name: string; monitors: number; interval: number; regions: number; credits: number; emails: number;
}> = {
  free: { name: "Free", monitors: 1, interval: 600, regions: 1, credits: 4500, emails: 20 },
  pro: { name: "Pro", monitors: 5, interval: 300, regions: 2, credits: 50000, emails: 200 },
  business: { name: "Business", monitors: 20, interval: 60, regions: 3, credits: 250000, emails: 1000 },
};

export const meteringEnabled = (env: Bindings) => env.MONTRAL_METERING_ENABLED === "true";

export async function migrateMontralMetering(db: Database): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS montral_usage (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    period_start timestamptz NOT NULL, kind text NOT NULL CHECK (kind IN ('credits', 'emails')),
    used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
    PRIMARY KEY (organization_id,period_start,kind)
  )`);
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_spend_usage(
      p_org text, p_start timestamptz, p_kind text, p_count integer, p_limit integer
    ) RETURNS integer LANGUAGE plpgsql AS $montral$
    DECLARE previous integer := 0; granted integer := 0;
    BEGIN
      IF p_count < 0 OR p_limit < 0 OR p_kind NOT IN ('credits','emails')
        THEN RAISE EXCEPTION 'invalid usage request';
      END IF;
      IF p_count = 0 THEN RETURN 0; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':' || p_kind,0));
      SELECT used INTO previous FROM montral_usage
        WHERE organization_id=p_org AND period_start=p_start AND kind=p_kind FOR UPDATE;
      granted := GREATEST(0,LEAST(p_count,p_limit-COALESCE(previous,0)));
      IF granted > 0 THEN
        INSERT INTO montral_usage(organization_id,period_start,kind,used)
          VALUES(p_org,p_start,p_kind,granted)
        ON CONFLICT (organization_id,period_start,kind)
          DO UPDATE SET used=montral_usage.used + EXCLUDED.used;
      END IF;
      RETURN granted;
    END;
    $montral$
  `);
  // A separately persisted, idempotent single-recipient email quota reservation.
  // This is a staged primitive: the monthly report sender is deliberately not
  // switched over until durable outbox phase transitions share an atomic boundary.
  await db.query(`CREATE TABLE IF NOT EXISTS montral_usage_reservation (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    period_start timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind = 'emails'),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    requested integer NOT NULL DEFAULT 1 CHECK (requested = 1),
    granted integer NOT NULL CHECK (granted IN (0,1)),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id,period_start,kind,idempotency_key)
  )`);
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_spend_usage_once(
      p_org text, p_start timestamptz, p_kind text, p_key text, p_limit integer
    ) RETURNS TABLE (granted integer, is_new boolean) LANGUAGE plpgsql AS $montral$
    DECLARE previous_grant integer; reserved_grant integer;
    BEGIN
      IF p_org IS NULL OR p_start IS NULL OR p_kind IS DISTINCT FROM 'emails'
        OR p_key IS NULL OR char_length(p_key) NOT BETWEEN 1 AND 200
        OR p_limit IS NULL OR p_limit < 0
        OR p_start <> (date_trunc('month', p_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
        RAISE EXCEPTION 'invalid idempotent email reservation';
      END IF;
      -- Share the *same* serialisation key with existing spend usage operations.
      -- A process crash rolls the quota debit and reservation row back together.
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':' || p_kind, 0));
      SELECT r.granted INTO previous_grant FROM montral_usage_reservation r
        WHERE r.organization_id = p_org AND r.period_start = p_start
        AND r.kind = p_kind AND r.idempotency_key = p_key;
      IF FOUND THEN
        -- Replay returns the original grant, but is_new=false tells callers
        -- that there is no new entitlement to send an extra email.
        RETURN QUERY SELECT previous_grant, false;
        RETURN;
      END IF;
      SELECT montral_spend_usage(p_org, p_start, p_kind, 1, p_limit) INTO reserved_grant;
      INSERT INTO montral_usage_reservation
        (organization_id, period_start, kind, idempotency_key, requested, granted)
        VALUES (p_org, p_start, p_kind, p_key, 1, reserved_grant);
      -- Store exhausted/denied reservations too. A plan upgrade after denial
      -- must not silently replay the same logical dispatch in the same period.
      RETURN QUERY SELECT reserved_grant, true;
    END;
    $montral$
  `);
  // STAGED ONLY. Move exactly one prepared monthly recipient to its first
  // attempt, coupled with its quota decision in a *single* PostgreSQL transaction.
  // Never call SMTP from this function: the caller must commit `attempted` first.
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_claim_monthly_report_send(
      p_org text, p_report_month text, p_user text,
      p_period timestamptz, p_limit integer
    ) RETURNS text LANGUAGE plpgsql AS $montral$
    DECLARE previous_state text; recipient_address text;
            reservation record; quota_key text;
    BEGIN
      IF p_org IS NULL OR p_user IS NULL OR p_report_month IS NULL
         OR p_report_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
         OR p_period IS NULL OR p_limit IS NULL OR p_limit < 0
         OR p_period <> (date_trunc('month', p_period AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
         OR to_char((p_period AT TIME ZONE 'UTC') - interval '1 month','YYYY-MM') <> p_report_month
      THEN
        RAISE EXCEPTION 'invalid monthly outbox claim';
      END IF;
      -- Lock the outbox row before the metering advisory lock. Concurrent
      -- attempts on the same recipient cannot each reserve a separate debit.
      SELECT r.state, r.recipient_email INTO previous_state, recipient_address
        FROM monthly_report_recipient r
        WHERE r.organization_id=p_org AND r.report_month=p_report_month
        AND r.recipient_user_id=p_user FOR UPDATE;
      IF NOT FOUND THEN RETURN 'not_eligible'; END IF;
      IF previous_state <> 'prepared' THEN RETURN 'already_claimed'; END IF;
      -- Prevent sends after report opt-out, claim rollover, owner removal, or
      -- email changes since the original immutable recipient snapshot.
      IF NOT EXISTS (
        SELECT 1 FROM workspace_setting w
        JOIN member m ON m.organization_id=w.organization_id
        JOIN "user" u ON u.id=m.user_id
        WHERE w.organization_id=p_org AND w.monthly_report=true
          AND w.last_report_month=p_report_month
          AND m.user_id=p_user AND m.role='owner'
          AND u.email=recipient_address
      ) THEN RETURN 'not_eligible'; END IF;
      quota_key := 'monthly:' || p_report_month || ':' || p_user;
      SELECT q.granted, q.is_new INTO reservation FROM montral_spend_usage_once(
        p_org,p_period,'emails',quota_key,p_limit) q;
      IF reservation.granted=0 THEN
        -- Terminal denial: the schema's attempted_at is the durable decision
        -- timestamp for skipped records (no SMTP request occurred).
        UPDATE monthly_report_recipient SET state='skipped',
          attempted_at=NOW(), decided_at=NOW()
          WHERE organization_id=p_org AND report_month=p_report_month AND recipient_user_id=p_user;
        RETURN 'quota_denied';
      END IF;
      IF reservation.is_new IS DISTINCT FROM true THEN
        -- A prior reservation might have preceded provider acceptance. Treat
        -- this as uncertain rather than minting another send authorization.
        UPDATE monthly_report_recipient SET state='uncertain',
          attempted_at=NOW(), decided_at=NOW()
          WHERE organization_id=p_org AND report_month=p_report_month AND recipient_user_id=p_user;
        RETURN 'prior_reservation_uncertain';
      END IF;
      UPDATE monthly_report_recipient SET state='attempted', attempted_at=NOW()
        WHERE organization_id=p_org AND report_month=p_report_month AND recipient_user_id=p_user;
      RETURN 'attempted';
    END;
    $montral$
  `);
  return ["montral_usage_meter_v1", "montral_usage_reservation_v1", "montral_monthly_outbox_quota_claim_v1"];
}

export function calendarMonthUtc(now: Date = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 1)),
  };
}

export function createMontralEntitlements(database: Database, env: Bindings): Entitlements {
  if (!meteringEnabled(env)) return unmetered;

  async function tier(workspaceId: string): Promise<MontralTier> {
    if (!billingReady(env)) return "free";
    const rows = await database.query<{ plan: string; status: string; test_mode: boolean; ends_at: Date | null }>(
      "SELECT plan,status,test_mode,ends_at FROM montral_subscription WHERE organization_id=$1", [workspaceId],
    );
    const row = rows[0];
    // Fail closed without the test-mode merchant, a test-mode subscription,
    // or a bounded end date on cancellation. Never grant lifetime paid access
    // just because the cancellation/expiration webhook is delayed or lost.
    if (!row || row.test_mode !== true) return "free";
    if (row.status === "cancelled") {
      if (!row.ends_at || new Date(row.ends_at).getTime() <= Date.now()) return "free";
    } else if (!["active", "on_trial"].includes(row.status)) {
      return "free";
    }
    if (row.plan === "pro" || row.plan === "business") return row.plan;
    return "free";
  }
  const spend = async (org: string, count: number, kind: "credits" | "emails") => {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid usage amount");
    if (count === 0) return 0;
    const [limits, { start }] = [TABLE[await tier(org)], calendarMonthUtc()];
    const rows = await database.query<{ granted: number }>(
      "SELECT montral_spend_usage($1::text,$2::timestamptz,$3::text,$4::integer,$5::integer) AS granted",
      [org, start.toISOString(), kind, count, limits[kind]],
    );
    return Math.max(0, Math.min(count, Number(rows[0]?.granted ?? 0)));
  };
  /** Credits given back for work that did not happen, in the period they were taken in (never below zero). */
  const refund = async (org: string, count: number, spentAt?: Date) => {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    const { start } = calendarMonthUtc(spentAt && !Number.isNaN(spentAt.getTime()) ? spentAt : new Date());
    await database.query(
      "UPDATE montral_usage SET used = GREATEST(0, used - $3::integer) WHERE organization_id = $1::text AND period_start = $2::timestamptz AND kind = 'credits'",
      [org, start.toISOString(), count],
    );
  };
  const reserveEmailQuotaOnce = async (org: string, key: string): Promise<{ granted: boolean; newlyReserved: boolean }> => {
    if (typeof key !== "string" || key.length < 1 || key.length > 200) throw new Error("Invalid email quota reservation key");
    const [limits, { start }] = [TABLE[await tier(org)], calendarMonthUtc()];
    const rows = await database.query<{ granted: number; is_new: boolean }>(
      "SELECT granted,is_new FROM montral_spend_usage_once($1::text,$2::timestamptz,'emails',$3::text,$4::integer)",
      [org, start.toISOString(), key, limits.emails],
    );
    const record = rows[0];
    if (!record || (Number(record.granted) !== 0 && Number(record.granted) !== 1) || typeof record.is_new !== "boolean")
      throw new Error("Invalid email reservation result");
    return { granted: Number(record.granted) === 1, newlyReserved: record.is_new };
  };
  const claimMonthlyOutboxAttempt = async (
    org: string, reportMonth: string, userId: string,
  ): Promise<"attempted" | "quota_denied" | "already_claimed" | "not_eligible" | "prior_reservation_uncertain"> => {
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(reportMonth) || !org || !userId)
      throw new Error("Invalid monthly outbox claim");
    const { start } = calendarMonthUtc();
    const limits = TABLE[await tier(org)];
    const rows = await database.query<{ result: string }>(
      "SELECT montral_claim_monthly_report_send($1::text,$2::text,$3::text,$4::timestamptz,$5::integer) AS result",
      [org, reportMonth, userId, start.toISOString(), limits.emails],
    );
    const status = rows[0]?.result;
    if (status !== "attempted" && status !== "quota_denied" && status !== "already_claimed"
      && status !== "not_eligible" && status !== "prior_reservation_uncertain")
      throw new Error("Invalid monthly outbox claim result");
    return status;
  };
  const balance = async (org: string, kind: "credits" | "emails"): Promise<CreditBalance> => {
    const limits = TABLE[await tier(org)];
    const { start, end } = calendarMonthUtc();
    const rows = await database.query<{ used: number }>(
      "SELECT used FROM montral_usage WHERE organization_id=$1 AND period_start=$2::timestamptz AND kind=$3",
      [org, start.toISOString(), kind],
    );
    return { limit: limits[kind], used: Number(rows[0]?.used ?? 0), periodStart: start, periodEnd: end };
  };
  const plan = async (org: string): Promise<Plan> => {
    const id = await tier(org);
    const limits = TABLE[id];
    return {
      id, name: limits.name, maxActiveMonitors: limits.monitors,
      minIntervalSec: limits.interval, maxRegions: limits.regions,
      hideBranding: id === "business",
      upgradeUrl: "/app/billing",
    };
  };
  return {
    ...unmetered,
    spendCredits: (org, count) => spend(org, count, "credits"),
    refundCredits: (org, count, spentAt) => refund(org, count, spentAt),
    creditBalance: org => balance(org, "credits"),
    spendEmails: (org, count) => spend(org, count, "emails"),
    reserveEmailQuotaOnce,
    claimMonthlyOutboxAttempt,
    emailBalance: org => balance(org, "emails"),
    plan,
  };
}
