import type { Database } from "@montral/repo";
import type { Bindings } from "./env";
import type { Entitlements, Plan, CreditBalance, Meter, RegionUsageOperation, RegionUsageReservation, RegionUsageResult, RegionUsageSummary } from "./entitlements";
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
// Only resource meters have strictly numeric allowances. Optional statusPages
// is a structural plan cap, not a monthly meter, and must never be a meter key.
const KIND_LIMIT: Readonly<Record<UsageKind, "credits" | "emails" | "webhookEvents" | "browserSeconds">> = Object.freeze({ credits: "credits", emails: "emails", webhook_events: "webhookEvents", browser_seconds: "browserSeconds" });
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
  await db.query(`CREATE TABLE IF NOT EXISTS montral_email_refund (
    organization_id text NOT NULL,
    period_start timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind = 'emails'),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id,period_start,kind,idempotency_key),
    FOREIGN KEY (organization_id,period_start,kind,idempotency_key)
      REFERENCES montral_usage_reservation(organization_id,period_start,kind,idempotency_key) ON DELETE CASCADE
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS montral_credit_refund (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    period_start timestamptz NOT NULL,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    credits integer NOT NULL CHECK (credits > 0),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id,period_start,idempotency_key)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS montral_region_usage_operation (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    period_start timestamptz NOT NULL,
    operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 200),
    monitor_id text NOT NULL,
    requested_regions text[] NOT NULL CHECK (cardinality(requested_regions) BETWEEN 1 AND 32),
    state text NOT NULL CHECK (state IN ('reserved','settled')),
    settlement jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    settled_at timestamptz,
    PRIMARY KEY (organization_id,period_start,operation_key),
    CHECK ((state='reserved' AND settlement IS NULL AND settled_at IS NULL) OR
           (state='settled' AND settlement IS NOT NULL AND settled_at IS NOT NULL))
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS montral_region_usage (
    organization_id text NOT NULL,
    period_start timestamptz NOT NULL,
    operation_key text NOT NULL,
    region text NOT NULL CHECK (region='auto' OR region ~ '^[a-z0-9][a-z0-9-]{1,23}$'),
    state text NOT NULL CHECK (state IN ('reserved','completed','unavailable')),
    credit_state text NOT NULL CHECK (credit_state IN ('reserved','charged','refunded')),
    result_ok boolean,
    status_code integer,
    latency_ms integer,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    settled_at timestamptz,
    PRIMARY KEY (organization_id,period_start,operation_key,region),
    FOREIGN KEY (organization_id,period_start,operation_key)
      REFERENCES montral_region_usage_operation(organization_id,period_start,operation_key) ON DELETE CASCADE,
    CHECK ((state='reserved' AND credit_state='reserved' AND result_ok IS NULL AND settled_at IS NULL) OR
           (state='completed' AND credit_state='charged' AND result_ok IS NOT NULL AND settled_at IS NOT NULL) OR
           (state='unavailable' AND credit_state='refunded' AND result_ok IS NULL AND settled_at IS NOT NULL)),
    CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
    CHECK (latency_ms IS NULL OR latency_ms >= 0)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS montral_region_usage_period_region
    ON montral_region_usage(organization_id,period_start,region,state,created_at)`);
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_refund_credits_once(
      p_org text, p_start timestamptz, p_key text, p_credits integer
    ) RETURNS boolean LANGUAGE plpgsql AS $montral$
    DECLARE previous integer;
    BEGIN
      IF p_org IS NULL OR p_start IS NULL OR p_key IS NULL
        OR char_length(p_key) NOT BETWEEN 1 AND 200 OR p_credits IS NULL OR p_credits <= 0
        OR p_start <> (date_trunc('month', p_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
        RAISE EXCEPTION 'invalid idempotent credit refund';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':refund:' || p_key,0));
      SELECT credits INTO previous FROM montral_credit_refund
        WHERE organization_id=p_org AND period_start=p_start AND idempotency_key=p_key;
      IF FOUND THEN
        IF previous <> p_credits THEN RAISE EXCEPTION 'credit refund key reused with a different amount'; END IF;
        RETURN false;
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':credits',0));
      UPDATE montral_usage SET used=GREATEST(0,used-p_credits)
        WHERE organization_id=p_org AND period_start=p_start AND kind='credits';
      INSERT INTO montral_credit_refund(organization_id,period_start,idempotency_key,credits)
        VALUES(p_org,p_start,p_key,p_credits);
      RETURN true;
    END;
    $montral$
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_reserve_region_usage(
      p_org text, p_start timestamptz, p_limit integer, p_operations jsonb
    ) RETURNS TABLE (operation_key text, granted boolean, state text)
    LANGUAGE plpgsql AS $montral$
    DECLARE op jsonb; requested_regions text[]; existing_operation montral_region_usage_operation%ROWTYPE;
      used_now integer; op_key text; monitor_key text;
    BEGIN
      IF p_org IS NULL OR p_start IS NULL OR p_limit IS NULL OR p_limit < 0
        OR p_operations IS NULL OR jsonb_typeof(p_operations) IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_operations) > 10000
        OR p_start <> (date_trunc('month', p_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
        RAISE EXCEPTION 'invalid region usage reservation batch';
      END IF;
      IF EXISTS (
        SELECT value->>'operationKey' FROM jsonb_array_elements(p_operations)
        GROUP BY value->>'operationKey' HAVING count(*) > 1
      ) THEN RAISE EXCEPTION 'duplicate region usage operation key'; END IF;
      -- Acquire operation locks in a stable order, then the same monthly lock
      -- used by ordinary credit spending. Replays and spends cannot race a debit.
      FOR op_key IN SELECT value->>'operationKey' FROM jsonb_array_elements(p_operations) ORDER BY 1 LOOP
        IF op_key IS NULL OR char_length(op_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid region usage operation key'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':region:' || op_key,0));
      END LOOP;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':credits',0));
      SELECT used INTO used_now FROM montral_usage
        WHERE organization_id=p_org AND period_start=p_start AND kind='credits' FOR UPDATE;
      used_now := COALESCE(used_now,0);
      FOR op IN SELECT value FROM jsonb_array_elements(p_operations) LOOP
        op_key := op->>'operationKey';
        monitor_key := op->>'monitorId';
        IF monitor_key IS NULL OR char_length(monitor_key) NOT BETWEEN 1 AND 200
          OR jsonb_typeof(op->'regions') IS DISTINCT FROM 'array'
          OR jsonb_array_length(op->'regions') NOT BETWEEN 1 AND 32 THEN
          RAISE EXCEPTION 'invalid region usage operation';
        END IF;
        SELECT array_agg(region ORDER BY ordinal) INTO requested_regions
          FROM (SELECT value #>> '{}' AS region, ordinality AS ordinal
                FROM jsonb_array_elements(op->'regions') WITH ORDINALITY) r;
        IF EXISTS (SELECT 1 FROM unnest(requested_regions) r WHERE r IS NULL OR NOT (r='auto' OR r ~ '^[a-z0-9][a-z0-9-]{1,23}$'))
          OR cardinality(requested_regions) <> (SELECT count(DISTINCT r) FROM unnest(requested_regions) r) THEN
          RAISE EXCEPTION 'invalid or duplicate region id';
        END IF;
        SELECT * INTO existing_operation FROM montral_region_usage_operation o
          WHERE o.organization_id=p_org AND o.period_start=p_start AND o.operation_key=op_key;
        IF FOUND THEN
          IF existing_operation.monitor_id <> monitor_key OR existing_operation.requested_regions <> requested_regions THEN
            RAISE EXCEPTION 'region usage operation key reused with different input';
          END IF;
          operation_key := op_key; granted := true; state := existing_operation.state; RETURN NEXT;
          CONTINUE;
        END IF;
        operation_key := op_key;
        IF used_now + cardinality(requested_regions) > p_limit THEN
          granted := false; state := 'denied'; RETURN NEXT;
          CONTINUE;
        END IF;
        INSERT INTO montral_region_usage_operation
          (organization_id,period_start,operation_key,monitor_id,requested_regions,state)
          VALUES(p_org,p_start,op_key,monitor_key,requested_regions,'reserved');
        INSERT INTO montral_region_usage
          (organization_id,period_start,operation_key,region,state,credit_state)
          SELECT p_org,p_start,op_key,r,'reserved','reserved' FROM unnest(requested_regions) r;
        INSERT INTO montral_usage(organization_id,period_start,kind,used)
          VALUES(p_org,p_start,'credits',cardinality(requested_regions))
        ON CONFLICT (organization_id,period_start,kind)
          DO UPDATE SET used=montral_usage.used + EXCLUDED.used;
        used_now := used_now + cardinality(requested_regions);
        granted := true; state := 'reserved'; RETURN NEXT;
      END LOOP;
    END;
    $montral$
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_settle_region_usage(
      p_org text,p_start timestamptz,p_operation_key text,p_results jsonb
    ) RETURNS boolean LANGUAGE plpgsql AS $montral$
    DECLARE operation montral_region_usage_operation%ROWTYPE; requested_refund integer; saved jsonb; used_now integer; changed_rows integer;
    BEGIN
      IF p_org IS NULL OR p_start IS NULL OR p_operation_key IS NULL
        OR char_length(p_operation_key) NOT BETWEEN 1 AND 200
        OR p_results IS NULL OR jsonb_typeof(p_results) IS DISTINCT FROM 'array'
        OR p_start <> (date_trunc('month', p_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
        RAISE EXCEPTION 'invalid region usage settlement';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':region:' || p_operation_key,0));
      SELECT * INTO operation FROM montral_region_usage_operation o
        WHERE o.organization_id=p_org AND o.period_start=p_start AND o.operation_key=p_operation_key FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'unknown region usage reservation'; END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_results) r
        WHERE jsonb_typeof(r) IS DISTINCT FROM 'object'
          OR r->>'region' IS NULL OR jsonb_typeof(r->'ok') IS DISTINCT FROM 'boolean'
          OR (r->'statusCode' IS NOT NULL AND r->'statusCode' <> 'null'::jsonb
              AND (jsonb_typeof(r->'statusCode') IS DISTINCT FROM 'number' OR (r->>'statusCode')::integer NOT BETWEEN 100 AND 599))
          OR (r->'latencyMs' IS NOT NULL AND r->'latencyMs' <> 'null'::jsonb
              AND (jsonb_typeof(r->'latencyMs') IS DISTINCT FROM 'number' OR (r->>'latencyMs')::integer < 0))
      ) OR (SELECT count(*) FROM jsonb_array_elements(p_results)) <>
           (SELECT count(DISTINCT r->>'region') FROM jsonb_array_elements(p_results) r)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) r
                   WHERE NOT (operation.requested_regions @> ARRAY[r->>'region'])) THEN
        RAISE EXCEPTION 'region usage result does not match reservation';
      END IF;
      SELECT COALESCE(jsonb_object_agg(r->>'region',jsonb_build_object(
        'ok',(r->>'ok')::boolean,
        'statusCode',CASE WHEN r->'statusCode' IS NULL OR r->'statusCode'='null'::jsonb THEN NULL ELSE (r->>'statusCode')::integer END,
        'latencyMs',CASE WHEN r->'latencyMs' IS NULL OR r->'latencyMs'='null'::jsonb THEN NULL ELSE (r->>'latencyMs')::integer END
      )), '{}'::jsonb) INTO saved FROM jsonb_array_elements(p_results) r;
      IF operation.state='settled' THEN
        IF operation.settlement <> saved THEN RAISE EXCEPTION 'region usage operation settled with different results'; END IF;
        RETURN false;
      END IF;
      requested_refund := cardinality(operation.requested_regions) - jsonb_array_length(p_results);
      -- The aggregate row is part of the reservation's debit evidence. Keep an
      -- incomplete/corrupt ledger reservation unverified instead of recording a
      -- completed charge (or a refund) without its matching monthly usage row.
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':credits',0));
      SELECT used INTO used_now FROM montral_usage
        WHERE organization_id=p_org AND period_start=p_start AND kind='credits' FOR UPDATE;
      IF NOT FOUND OR used_now < requested_refund THEN
        RAISE EXCEPTION 'region usage reservation has no matching aggregate credit balance';
      END IF;
      IF requested_refund > 0 THEN
        UPDATE montral_usage SET used=used-requested_refund
          WHERE organization_id=p_org AND period_start=p_start AND kind='credits' AND used >= requested_refund;
        IF NOT FOUND THEN RAISE EXCEPTION 'region usage reservation has no matching aggregate credit balance'; END IF;
      END IF;
      UPDATE montral_region_usage u SET
        state=CASE WHEN saved ? u.region THEN 'completed' ELSE 'unavailable' END,
        credit_state=CASE WHEN saved ? u.region THEN 'charged' ELSE 'refunded' END,
        result_ok=CASE WHEN saved ? u.region THEN (saved->u.region->>'ok')::boolean ELSE NULL END,
        status_code=CASE WHEN saved ? u.region THEN NULLIF(saved->u.region->>'statusCode','')::integer ELSE NULL END,
        latency_ms=CASE WHEN saved ? u.region THEN NULLIF(saved->u.region->>'latencyMs','')::integer ELSE NULL END,
        settled_at=NOW()
        WHERE u.organization_id=p_org AND u.period_start=p_start AND u.operation_key=p_operation_key AND u.state='reserved';
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
      IF changed_rows <> cardinality(operation.requested_regions) THEN
        RAISE EXCEPTION 'region usage reservation records are incomplete';
      END IF;
      UPDATE montral_region_usage_operation SET state='settled',settlement=saved,settled_at=NOW()
        WHERE organization_id=p_org AND period_start=p_start AND operation_key=p_operation_key;
      RETURN true;
    END;
    $montral$
  `);
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
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_refund_alert_email_once(p_org text, p_delivery uuid, p_key text)
    RETURNS boolean LANGUAGE plpgsql AS $montral$
    DECLARE p_start timestamptz; reserved integer; delivery_status text; quota_attempted boolean;
    BEGIN
      IF p_org IS NULL OR p_delivery IS NULL OR p_key IS DISTINCT FROM ('alert:' || p_delivery::text)
        OR char_length(p_key) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'invalid alert email refund';
      END IF;
      SELECT period_start,granted INTO p_start,reserved FROM montral_usage_reservation
        WHERE organization_id=p_org AND kind='emails' AND idempotency_key=p_key
        ORDER BY period_start DESC LIMIT 1;
      -- Legacy spendEmails debits have no per-delivery attribution and cannot be refunded safely.
      IF NOT FOUND OR reserved <> 1 THEN RETURN false; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':emails',0));
      IF EXISTS (SELECT 1 FROM montral_email_refund WHERE organization_id=p_org AND period_start=p_start AND kind='emails' AND idempotency_key=p_key) THEN
        RETURN false;
      END IF;
      SELECT status,email_quota_attempted INTO delivery_status,quota_attempted
        FROM alert_delivery WHERE id=p_delivery AND organization_id=p_org FOR UPDATE;
      IF NOT FOUND OR delivery_status <> 'sending' OR quota_attempted IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'alert delivery is not eligible for quota settlement';
      END IF;
      SELECT granted INTO reserved FROM montral_usage_reservation
        WHERE organization_id=p_org AND period_start=p_start AND kind='emails' AND idempotency_key=p_key FOR UPDATE;
      IF reserved <> 1 THEN RETURN false; END IF;
      UPDATE montral_usage SET used=used-1
        WHERE organization_id=p_org AND period_start=p_start AND kind='emails' AND used >= 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'email reservation has no matching aggregate usage'; END IF;
      INSERT INTO montral_email_refund(organization_id,period_start,kind,idempotency_key)
        VALUES(p_org,p_start,'emails',p_key);
      -- Commit the refund and terminal skip together. A crash cannot leave a refunded delivery claimable.
      UPDATE alert_delivery SET status='skipped',ok=false,
        error='skipped: workspace suspended before alert delivery',
        status_message='skipped: workspace suspended before alert delivery',claimed_at=NULL,next_attempt_at=NULL
        WHERE id=p_delivery AND organization_id=p_org AND status='sending';
      RETURN true;
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
  return ["montral_usage_meter_v2", "montral_usage_reservation_v1", "montral_credit_refund_once_v1", "montral_email_refund_once_v1", "montral_region_usage_v1", "montral_monthly_outbox_quota_claim_v1"];
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
  const refundCreditsOnce = async (org: string, count: number, spentAt: Date, key: string) => {
    if (!Number.isSafeInteger(count) || count <= 0 || typeof key !== "string" || key.length < 1 || key.length > 200)
      throw new Error("Invalid idempotent credit refund");
    const { start } = calendarMonthUtc(validAt(spentAt));
    const rows = await database.query<{ applied: boolean }>(
      "SELECT montral_refund_credits_once($1::text,$2::timestamptz,$3::text,$4::integer) AS applied",
      [org, start.toISOString(), key, count],
    );
    if (typeof rows[0]?.applied !== "boolean") throw new Error("Invalid idempotent credit refund result");
  };
  const reserveRegionUsage = async (org: string, operations: RegionUsageOperation[], at: Date): Promise<RegionUsageReservation[]> => {
    if (!(at instanceof Date) || Number.isNaN(at.getTime()) || !Array.isArray(operations) || operations.length > 10_000)
      throw new Error("Invalid region usage reservation batch");
    const keys = new Set<string>();
    for (const op of operations) {
      if (!op || typeof op.operationKey !== "string" || op.operationKey.length < 1 || op.operationKey.length > 200
        || typeof op.monitorId !== "string" || op.monitorId.length < 1 || op.monitorId.length > 200
        || !Array.isArray(op.regions) || op.regions.length < 1 || op.regions.length > 32
        || op.regions.some((r) => typeof r !== "string" || !(r === "auto" || /^[a-z0-9][a-z0-9-]{1,23}$/.test(r)))
        || new Set(op.regions).size !== op.regions.length || keys.has(op.operationKey))
        throw new Error("Invalid region usage operation");
      keys.add(op.operationKey);
    }
    const { start } = calendarMonthUtc(at);
    const { limits } = await effective(org);
    const rows = await database.query<{ operation_key: string; granted: boolean; state: string }>(
      "SELECT operation_key,granted,state FROM montral_reserve_region_usage($1::text,$2::timestamptz,$3::integer,$4::jsonb)",
      [org, start.toISOString(), limits.credits, JSON.stringify(operations.map((op) => ({ operationKey: op.operationKey, monitorId: op.monitorId, regions: op.regions })))],
    );
    if (rows.length !== operations.length || rows.some((r) => typeof r.operation_key !== "string" || typeof r.granted !== "boolean"
      || !["denied", "reserved", "settled"].includes(r.state))) throw new Error("Invalid region usage reservation result");
    return rows.map((r) => ({ operationKey: r.operation_key, granted: r.granted, state: r.state as RegionUsageReservation["state"] }));
  };
  const settleRegionUsage = async (org: string, key: string, results: RegionUsageResult[], at: Date) => {
    if (typeof key !== "string" || key.length < 1 || key.length > 200 || !Array.isArray(results)
      || !(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("Invalid region usage settlement");
    const seen = new Set<string>();
    for (const result of results) {
      if (!result || typeof result.region !== "string" || !(result.region === "auto" || /^[a-z0-9][a-z0-9-]{1,23}$/.test(result.region))
        || typeof result.ok !== "boolean" || (result.statusCode != null && (!Number.isSafeInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599))
        || (result.latencyMs != null && (!Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0)) || seen.has(result.region))
        throw new Error("Invalid region usage result");
      seen.add(result.region);
    }
    const { start } = calendarMonthUtc(at);
    const rows = await database.query<{ settled: boolean }>(
      "SELECT montral_settle_region_usage($1::text,$2::timestamptz,$3::text,$4::jsonb) AS settled",
      [org, start.toISOString(), key, JSON.stringify(results.map((r) => ({ region: r.region, ok: r.ok, statusCode: r.statusCode ?? null, latencyMs: r.latencyMs ?? null })))],
    );
    if (typeof rows[0]?.settled !== "boolean") throw new Error("Invalid region usage settlement result");
  };
  const regionUsageSummary = async (org: string): Promise<RegionUsageSummary> => {
    const { start, end } = calendarMonthUtc();
    const rows = await database.query<{
      region: string; planned: string; completed: string; failed_results: string; unavailable: string;
      reserved: string; unverified: string; credits_charged: string; credits_refunded: string;
    }>(`SELECT region,COUNT(*)::text AS planned,
        COUNT(*) FILTER (WHERE state='completed')::text AS completed,
        COUNT(*) FILTER (WHERE state='completed' AND result_ok=false)::text AS failed_results,
        COUNT(*) FILTER (WHERE state='unavailable')::text AS unavailable,
        COUNT(*) FILTER (WHERE state='reserved' AND created_at >= NOW()-INTERVAL '5 minutes')::text AS reserved,
        COUNT(*) FILTER (WHERE state='reserved' AND created_at < NOW()-INTERVAL '5 minutes')::text AS unverified,
        COUNT(*) FILTER (WHERE credit_state='charged')::text AS credits_charged,
        COUNT(*) FILTER (WHERE credit_state='refunded')::text AS credits_refunded
      FROM montral_region_usage WHERE organization_id=$1 AND period_start=$2::timestamptz
      GROUP BY region ORDER BY region`, [org, start.toISOString()]);
    const n = (v: string) => Number(v);
    return { periodStart: start, periodEnd: end, regions: rows.map((r) => ({
      region: r.region, planned: n(r.planned), completed: n(r.completed), failedResults: n(r.failed_results),
      unavailable: n(r.unavailable), reserved: n(r.reserved), unverified: n(r.unverified),
      creditsCharged: n(r.credits_charged), creditsRefunded: n(r.credits_refunded),
    })) };
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
  const refundEmailQuotaOnce = async (org: string, key: string): Promise<boolean> => {
    if (typeof key !== "string" || key.length < 1 || key.length > 200) throw new Error("Invalid alert email refund key");
    const delivery = key.startsWith("alert:") ? key.slice(6) : "";
    if (!/^[0-9a-f-]{36}$/i.test(delivery)) throw new Error("Invalid alert email refund key");
    const rows = await database.query<{ refunded: boolean }>(
      "SELECT montral_refund_alert_email_once($1::text,$2::uuid,$3::text) AS refunded",
      [org, delivery, key],
    );
    if (typeof rows[0]?.refunded !== "boolean") throw new Error("Invalid alert email refund result");
    return rows[0].refunded;
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
      maxStatusPages: limits.statusPages ?? null,
      maxWebhookInboxes: limits.webhookInboxes ?? null,
      hideBranding: p.features.includes("hideBranding"),
      upgradeUrl: "/app/billing",
    };
  };
  return {
    ...unmetered,
    failClosed: true,
    spendCredits: (org, count, at) => spend(org, count, "credits", at),
    refundCredits: (org, count, spentAt) => refund(org, count, "credits", spentAt),
    refundCreditsOnce,
    reserveRegionUsage,
    settleRegionUsage,
    regionUsageSummary,
    creditBalance: org => balance(org, "credits"),
    spendEmails: (org, count) => spend(org, count, "emails"),
    reserveEmailQuotaOnce,
    refundEmailQuotaOnce,
    claimMonthlyOutboxAttempt,
    emailBalance: org => balance(org, "emails"),
    spendMeter: (org, meter, count, at) => spend(org, count, meterKind(meter), at),
    refundMeter: (org, meter, count, spentAt) => refund(org, count, meterKind(meter), spentAt),
    meterBalance: (org, meter) => balance(org, meterKind(meter)),
    plan,
  };
}
