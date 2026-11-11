import type { Database } from "@montral/repo";
import type { Bindings } from "./env";
import type { Entitlements, Plan, CreditBalance, Meter } from "./entitlements";
import { unmetered } from "./entitlements";
import { billingGraceDays, billingReady, entitledPlanId, ENV_FALLBACK_PLAN_IDS, envVariantsValid, type SubscriptionEntitlementRow } from "./montral-billing";
import { cachedPlanCatalog, PlanCatalogError, type PlanLimits } from "./plan-catalog";
import { constraintExists } from "./schema-catalog";

export const meteringEnabled = (env: Bindings) => env.MONTRAL_METERING_ENABLED === "true";

/** The ledger kinds: one row per workspace, calendar month and kind. */
export const USAGE_KINDS = ["credits", "emails", "webhook_events", "browser_seconds"] as const;
export type UsageKind = typeof USAGE_KINDS[number];
/** The ledger kind of each resource meter. */
export const METER_KIND: Readonly<Record<Meter, UsageKind>> = Object.freeze({ webhookEvents: "webhook_events", browserSeconds: "browser_seconds" });
/** The plan limit that bounds each ledger kind. */
const KIND_LIMIT: Readonly<Record<UsageKind, keyof PlanLimits>> = Object.freeze({ credits: "credits", emails: "emails", webhook_events: "webhookEvents", browser_seconds: "browserSeconds" });
const KIND_LIST = USAGE_KINDS.map((k) => `'${k}'`).join(",");
const KIND_CHECK = "montral_usage_kind_v2";

/**
 * The CHECK constraints on montral_usage.kind written before the resource meters (an unnamed column check, so its name
 * is whatever PostgreSQL chose): found in pg_constraint by what they say, never by a guessed name.
 */
async function legacyUsageKindChecks(db: Database): Promise<string[]> {
  const rows = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = to_regclass('montral_usage') AND contype = 'c' AND conname <> '${KIND_CHECK}'
        AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) LIKE '%''credits''%'`,
  );
  return rows.map((r) => r.conname);
}
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function migrateMontralMetering(db: Database): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS montral_usage (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    period_start timestamptz NOT NULL, kind text NOT NULL CONSTRAINT ${KIND_CHECK} CHECK (kind IN (${KIND_LIST})),
    used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
    PRIMARY KEY (organization_id,period_start,kind)
  )`);
  // Decided from the catalog (no lock): an up-to-date or freshly created table takes no table-locking DDL on restart.
  if (!await constraintExists(db, "montral_usage", KIND_CHECK)) {
    // A genuine upgrade of a table created with the two original kinds: its kind check is replaced by the wider named
    // one. Previous-release replicas only write 'credits'/'emails', which the new check admits.
    await db.query("LOCK TABLE montral_usage IN ACCESS EXCLUSIVE MODE");
    for (const name of await legacyUsageKindChecks(db)) {
      await db.query(`ALTER TABLE montral_usage DROP CONSTRAINT IF EXISTS ${quoteIdent(name)}`);
    }
    // NOT VALID then VALIDATE: the new check is in force for every write at once, and existing rows are checked in a
    // separate step (all rows hold 'credits' or 'emails', which it admits).
    await db.query(`ALTER TABLE montral_usage ADD CONSTRAINT ${KIND_CHECK} CHECK (kind IN (${KIND_LIST})) NOT VALID`);
    await db.query(`ALTER TABLE montral_usage VALIDATE CONSTRAINT ${KIND_CHECK}`);
  }
  // Rolling upgrades and rollbacks: previous-release replicas keep running (and restarting) while this one migrates,
  // and each restart re-creates their montral_spend_usage. This release therefore leaves that function exactly as the
  // previous release defines it (two kinds) and calls only montral_spend_usage_v2 below. Both take the same advisory
  // lock key per (workspace, period, kind), so old and new replicas spending the same kind serialize with each other.
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
  // The current spend function: every ledger kind, including the resource meters. Same body otherwise.
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_spend_usage_v2(
      p_org text, p_start timestamptz, p_kind text, p_count integer, p_limit integer
    ) RETURNS integer LANGUAGE plpgsql AS $montral$
    DECLARE previous integer := 0; granted integer := 0;
    BEGIN
      IF p_count IS NULL OR p_limit IS NULL OR p_count < 0 OR p_limit < 0 OR p_kind IS NULL OR p_kind NOT IN (${KIND_LIST})
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
  return ["montral_usage_meter_v2", "montral_usage_reservation_v1", "montral_monthly_outbox_quota_claim_v1"];
}

/** The ledger kind of a meter; anything else is refused, so a caller can never write an arbitrary kind. */
function meterKind(meter: Meter): UsageKind {
  if (!Object.hasOwn(METER_KIND, meter)) throw new Error("Unknown usage meter");
  return METER_KIND[meter];
}

/** Seconds until `end` (at least 1): the Retry-After of a refusal that lasts until the next period. */
export const secondsUntil = (end: Date, now: Date = new Date()) => Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));

export function calendarMonthUtc(now: Date = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 1)),
  };
}

export function createMontralEntitlements(database: Database, env: Bindings): Entitlements {
  if (!meteringEnabled(env)) return unmetered;

  // The plan catalog is operator configuration (plan-catalog.ts); an invalid one makes every metered call fail
  // (fail closed) rather than fall back to a guess.
  const catalog = () => cachedPlanCatalog(env);
  let unknownPlanLogged = false;

  /** The plan id of the workspace's valid subscription, or null (then the catalog's default plan applies). */
  async function subscribedPlan(workspaceId: string): Promise<string | null> {
    if (!billingReady(env)) return null;
    const rows = await database.query<SubscriptionEntitlementRow>(
      `SELECT plan,status,test_mode,ends_at,provider_updated_at,payment_state,payment_updated_at,past_due_since
         FROM montral_subscription WHERE organization_id=$1`, [workspaceId],
    );
    // Fail closed without the test-mode merchant, a test-mode subscription,
    // or a bounded end date on cancellation; past due keeps the plan only for
    // the grace period; a refund falls back at once (entitledPlanId). Never
    // grant lifetime paid access because a provider webhook is delayed or lost.
    return entitledPlanId(rows[0], Date.now(), billingGraceDays(env));
  }
  /** The workspace's effective plan and limits, read at the moment of use: a plan change or a reduced allowance applies at once. */
  async function effective(workspaceId: string) {
    const c = await catalog();
    // With catalog-driven billing (plans list providerVariants) a subscription names a catalog plan by construction.
    // The environment fallback stores the fixed ids "pro"/"business"; a catalog without them would quietly put every
    // paying workspace on the default plan, so it is refused instead (fail closed, with the reason).
    if (billingReady(env) && !c.hasProviderVariants && envVariantsValid(env)) {
      const missing = ENV_FALLBACK_PLAN_IDS.filter((id) => !c.plans.has(id));
      if (missing.length) throw new PlanCatalogError([`plans: billing uses the environment variants, so the catalog must define the plan ids ${ENV_FALLBACK_PLAN_IDS.join(", ")} (or list providerVariants)`]);
    }
    const r = c.resolve(workspaceId, await subscribedPlan(workspaceId));
    if (r.unknownPlan && !unknownPlanLogged) {
      unknownPlanLogged = true;
      console.warn("metering: a subscription names a plan that is not in the plan catalog; the default plan applies");
    }
    return r;
  }
  const limitOf = (limits: PlanLimits, kind: UsageKind) => limits[KIND_LIMIT[kind]];
  const validAt = (at?: Date) => (at && !Number.isNaN(at.getTime()) ? at : new Date());
  const spend = async (org: string, count: number, kind: UsageKind, at?: Date) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid usage amount");
    if (count === 0) return 0;
    // the period is fixed before the plan lookup, so a refund naming the same instant hits the same month
    const { start } = calendarMonthUtc(validAt(at));
    const { limits } = await effective(org);
    const rows = await database.query<{ granted: number }>(
      "SELECT montral_spend_usage_v2($1::text,$2::timestamptz,$3::text,$4::integer,$5::integer) AS granted",
      [org, start.toISOString(), kind, count, limitOf(limits, kind)],
    );
    return Math.max(0, Math.min(count, Number(rows[0]?.granted ?? 0)));
  };
  /** Units given back for work that did not happen (or used less), in the period they were taken in (never below zero). */
  const refund = async (org: string, count: number, kind: UsageKind, spentAt?: Date) => {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    const { start } = calendarMonthUtc(validAt(spentAt));
    await database.query(
      "UPDATE montral_usage SET used = GREATEST(0, used - $3::integer) WHERE organization_id = $1::text AND period_start = $2::timestamptz AND kind = $4::text",
      [org, start.toISOString(), count, kind],
    );
  };
  const reserveEmailQuotaOnce = async (org: string, key: string): Promise<{ granted: boolean; newlyReserved: boolean }> => {
    if (typeof key !== "string" || key.length < 1 || key.length > 200) throw new Error("Invalid email quota reservation key");
    const { start } = calendarMonthUtc();
    const { limits } = await effective(org);
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
    const { limits } = await effective(org);
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
  const balance = async (org: string, kind: UsageKind): Promise<CreditBalance> => {
    const { limits } = await effective(org);
    const { start, end } = calendarMonthUtc();
    const rows = await database.query<{ used: number }>(
      "SELECT used FROM montral_usage WHERE organization_id=$1 AND period_start=$2::timestamptz AND kind=$3",
      [org, start.toISOString(), kind],
    );
    return { limit: limitOf(limits, kind), used: Number(rows[0]?.used ?? 0), periodStart: start, periodEnd: end };
  };
  const plan = async (org: string): Promise<Plan> => {
    const { plan: p, limits } = await effective(org);
    return {
      id: p.id, name: p.name, maxActiveMonitors: limits.activeMonitors,
      minIntervalSec: limits.minIntervalSec, maxRegions: limits.regions,
      hideBranding: p.features.includes("hideBranding"),
      upgradeUrl: "/app/billing",
    };
  };
  return {
    ...unmetered,
    failClosed: true,
    spendCredits: (org, count, at) => spend(org, count, "credits", at),
    refundCredits: (org, count, spentAt) => refund(org, count, "credits", spentAt),
    creditBalance: org => balance(org, "credits"),
    spendEmails: (org, count) => spend(org, count, "emails"),
    reserveEmailQuotaOnce,
    claimMonthlyOutboxAttempt,
    emailBalance: org => balance(org, "emails"),
    spendMeter: (org, meter, count, at) => spend(org, count, meterKind(meter), at),
    refundMeter: (org, meter, count, spentAt) => refund(org, count, meterKind(meter), spentAt),
    meterBalance: (org, meter) => balance(org, meterKind(meter)),
    plan,
  };
}
