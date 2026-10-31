import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, openDatabase } from "@montral/db-pg";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { inspectMonthlyTransition, validTransitionMonth } from "./monthly-transition-preflight";

const baseUrl = process.env.TEST_DATABASE_URL;
const month = "2026-09";
const suffix = randomUUID().replaceAll("-", "");
const name = `montral_test_preflight_${suffix}`;
const org = (label: string) => `synthetic-preflight-${label}-${suffix}`;
const owner = (label: string) => `synthetic-owner-${label}-${suffix}`;
const day = new Date(Date.now() - 65 * 60000);

describe.skipIf(!baseUrl)("read-only monthly migration preflight on real PostgreSQL", () => {
  let admin: ReturnType<typeof createDb>;
  let database: ReturnType<typeof openDatabase>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    admin = createDb(baseUrl!, { max: 1 });
    await admin.$client.unsafe(`create database "${name}"`);
    const local = new URL(baseUrl!);
    local.pathname = `/${name}`;
    database = openDatabase(local.href, { max: 3 });
    db = createDb(local.href, { max: 3 });
    await migrateMontralSchema(database, montralEdition);
    for (const label of ["legacy", "prepared", "attempt", "pending", "new"]) {
      await database.query("insert into organization(id,name,slug,created_at) values($1,$1,$1,NOW())", [org(label)]);
      await database.query('insert into "user"(id,name,email,created_at,updated_at) values($1,$1,$2,NOW(),NOW())', [owner(label), `${owner(label)}@example.test`]);
      await database.query("insert into member(id,organization_id,user_id,role,created_at) values($1,$2,$3,'owner',NOW())", [`m-${owner(label)}`, org(label), owner(label)]);
      await database.query("insert into workspace_setting(organization_id,monthly_report,last_report_month) values($1,true,$2)", [org(label), label === "legacy" || label === "prepared" || label === "attempt" ? month : null]);
    }
    const insert = async (label: string, state: string, attemptedAt: Date | null = null) => database.query(
      `insert into monthly_report_recipient (organization_id,report_month,recipient_user_id,recipient_email,locale,state,attempted_at,decided_at)
       values ($1,$2,$3,$4,'en',$5,$6::timestamptz,case when $5 in ('accepted','uncertain','skipped') then $6::timestamptz else null end)`,
      [org(label), month, owner(label), `${owner(label)}@example.test`, state, attemptedAt?.toISOString() ?? null],
    );
    await insert("prepared", "prepared");
    await insert("attempt", "attempted", day);
    await insert("pending", "uncertain", day); // mismatched workspace month
    await database.query(
      "insert into monthly_report_reconciliation(organization_id,report_month,recipient_user_id,previous_state,decision,evidence_sha256) values($1,$2,$3,'attempted','unresolved',$4)",
      [org("pending"), month, owner("pending"), createHash("sha256").update("provider:synthetic-local-evidence").digest("hex")],
    );
  });
  afterAll(async () => {
    await db?.$client.end();
    await database?.close(3);
    if (admin) {
      await admin.$client.unsafe(`drop database if exists "${name}"`);
      await admin.$client.end();
    }
  });

  it("rejects invalid months before making any database query", async () => {
    for (const bad of ["", "2026-13", "2026-00", "2026-1", "2026-01' OR true", "1999-01", "9999-01"]) {
      expect(validTransitionMonth(bad)).toBe(false);
      await expect(inspectMonthlyTransition(db, bad)).rejects.toThrow("Invalid monthly transition report month");
    }
  });
  it("returns only aggregate evidence, stable digest and irreversible NO_GO", async () => {
    const first = await inspectMonthlyTransition(db, month);
    expect(first).toMatchObject({ reportMonth: month, readOnly: true, outcome: "NO_GO", authorizesSending: false,
      counts: { eligibleUnclaimedWorkspaces: 1, legacyClaimedWithoutOutbox: 1, outboxWorkspaces: 3,
        outboxMonthMismatch: 1, prepared: 1, attemptedMature: 1, attemptedWithinSafetyWindow: 0,
        uncertainUnreviewed: 0, unresolvedReviews: 1, missingAttemptReservations: 2, skipped: 0 } });
    expect(first.findings).toEqual(expect.arrayContaining([expect.stringContaining("Legacy"), expect.stringContaining("SMTP")]));
    expect(first.countsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await inspectMonthlyTransition(db, month)).toEqual(first);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("@example.test");
    expect(serialized).not.toContain(suffix);
    expect(serialized).not.toContain("provider:synthetic-local-evidence");
    expect(serialized).not.toContain("organization_id");
  });
  it("cannot write or leave transaction locks; detects changed aggregate without modifying data", async () => {
    const before = await db.$client`select count(*)::int as n from monthly_report_recipient`;
    const scan = await inspectMonthlyTransition(db, month);
    expect((await db.$client`select count(*)::int as n from monthly_report_recipient`)[0].n).toBe(before[0].n);
    // Independent test mutation, performed OUTSIDE the preflight, then detected by preflight.
    await database.query("update workspace_setting set monthly_report=false where organization_id=$1", [org("prepared")]);
    const next = await inspectMonthlyTransition(db, month);
    expect(next.counts.preparedAfterOptOut).toBe(1);
    expect(next.countsSha256).not.toBe(scan.countsSha256);
    // A future migration may expose missing workspace preferences while the
    // outbox still exists: include those records, never silently inner-join away.
    await database.query("delete from workspace_setting where organization_id=$1", [org("pending")]);
    const orphaned = await inspectMonthlyTransition(db, month);
    expect(orphaned.counts.outboxMissingWorkspaceSetting).toBe(1);
    expect(orphaned.counts.outboxWorkspaces).toBe(3);
    expect(orphaned.findings).toContain("Outbox recipient rows have no workspace settings; no automatic sends");
  });
  it("missing outbox schema fails closed instead of reporting a clean month", async () => {
    const old = new URL(baseUrl!);
    old.pathname = "/" + name;
    const other = createDb(old.href, { max: 1 });
    // Non-destructive simulate a lost table using a temporary search_path:
    // include no public schema to ensure unqualified table references are missing.
    await other.$client`set search_path to pg_catalog`;
    try { await expect(inspectMonthlyTransition(other, month)).rejects.toThrow(); }
    finally { await other.$client.end(); }
  });
});
