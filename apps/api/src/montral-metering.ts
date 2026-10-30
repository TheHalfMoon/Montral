import type { Database } from "@montral/repo";
import type { Bindings } from "./env";
import type { Entitlements, Plan, CreditBalance } from "./entitlements";
import { unmetered } from "./entitlements";

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
  return ["montral_usage_meter_v1"];
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
    const rows = await database.query<{ plan: string; status: string }>(
      "SELECT plan,status FROM montral_subscription WHERE organization_id=$1", [workspaceId],
    );
    const row = rows[0];
    // In this preview, never consider a provider status paid when billing failed,
    // was paused, expired or entered dunning. An active/trial subscription or
    // cancellation grace period may retain access until the expiration event.
    if (!row || !["active", "on_trial", "cancelled"].includes(row.status)) return "free";
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
    creditBalance: org => balance(org, "credits"),
    spendEmails: (org, count) => spend(org, count, "emails"),
    emailBalance: org => balance(org, "emails"),
    plan,
  };
}
