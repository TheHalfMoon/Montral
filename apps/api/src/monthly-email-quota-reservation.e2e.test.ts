import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createMontralEntitlements, calendarMonthUtc } from "./montral-metering";
import { migrateMontralSchema } from "./schema-migrate";
import { montralEdition } from "./montral-edition";
import type { Bindings } from "./env";

const url = process.env.TEST_DATABASE_URL;
const db = url ? openDatabase(url, { max: 12 }) : null;
const env = { MONTRAL_METERING_ENABLED: "true", MONTRAL_BILLING_ENABLED: "false" } as Bindings;
const orgs: string[] = [];
const quota = db ? createMontralEntitlements(db, env) : null;

async function ownerOrg() {
  const id = `synthetic-quota-${crypto.randomUUID()}`;
  await db!.query("INSERT INTO organization (id,name,slug,created_at) VALUES ($1,'Synthetic quota owner',$1,NOW())", [id]);
  orgs.push(id);
  return id;
}

// These are SQL integration tests with synthetic tenant ids; no SMTP or real merchant is invoked.
describe.skipIf(!url)("idempotent monthly email quota primitive (staged; no sender)", () => {
  beforeAll(async () => { await migrateMontralSchema(db!, montralEdition); });
  afterAll(async () => {
    for (const id of orgs) await db!.query("DELETE FROM organization WHERE id=$1", [id]);
    await db?.close(1);
  });

  it("allows only one newly created grant for concurrent callers sharing a key", async () => {
    const org = await ownerOrg();
    const attempts = await Promise.all(Array.from({ length: 20 }, () => quota!.reserveEmailQuotaOnce!(org, "monthly:2026-09:user-1")));
    expect(attempts.filter(r => r.newlyReserved)).toEqual([{ granted: true, newlyReserved: true }]);
    expect(attempts.filter(r => r.granted)).toHaveLength(20);
    expect(await quota!.emailBalance(org)).toMatchObject({ used: 1, limit: 20 });
    expect(await quota!.reserveEmailQuotaOnce!(org, "monthly:2026-09:user-1")).toEqual({ granted: true, newlyReserved: false });
    expect((await db!.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM montral_usage_reservation WHERE organization_id=$1", [org]))[0].n).toBe(1);
  });

  it("atomically respects the same budget as ordinary senders under concurrent keys", async () => {
    const org = await ownerOrg();
    const [ordinary, ...reservations] = await Promise.all([
      quota!.spendEmails(org, 8),
      ...Array.from({ length: 30 }, (_, i) => quota!.reserveEmailQuotaOnce!(org, `monthly:2026-09:user-${i}`)),
    ]);
    expect(ordinary).toBe(8);
    expect(reservations.filter(r => r.granted && r.newlyReserved)).toHaveLength(12);
    expect(reservations.filter(r => !r.granted && r.newlyReserved)).toHaveLength(18);
    expect(await quota!.emailBalance(org)).toMatchObject({ used: 20, limit: 20 });
    const deniedIdx = reservations.findIndex(r => !r.granted);
    expect(await quota!.reserveEmailQuotaOnce!(org, `monthly:2026-09:user-${deniedIdx}`)).toEqual({ granted: false, newlyReserved: false });
    expect((await db!.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM montral_usage_reservation WHERE organization_id=$1", [org]))[0].n).toBe(30);
  });

  it("does not charge on crash/replay or retry a denied key after a limit increase", async () => {
    const org = await ownerOrg();
    const { start } = calendarMonthUtc();
    const query = "SELECT granted,is_new FROM montral_spend_usage_once($1::text,$2::timestamptz,'emails',$3::text,$4::integer)";
    const args = [org, start.toISOString(), "synthetic-monthly:user-id", 0];
    expect((await db!.query(query, args))[0]).toMatchObject({ granted: 0, is_new: true });
    // A later plan upgrade must not authorize a resend of an earlier denied logical email.
    expect((await db!.query(query, [org, start.toISOString(), "synthetic-monthly:user-id", 20]))[0]).toMatchObject({ granted: 0, is_new: false });
    expect(await quota!.emailBalance(org)).toMatchObject({ used: 0 });
    expect((await db!.query(query, [org, start.toISOString(), "synthetic-monthly:other-owner", 20]))[0]).toMatchObject({ granted: 1, is_new: true });
    expect((await db!.query(query, [org, start.toISOString(), "synthetic-monthly:other-owner", 20]))[0]).toMatchObject({ granted: 1, is_new: false });
    expect(await quota!.emailBalance(org)).toMatchObject({ used: 1 });
  });

  it("rolls back the quota charge and reservation together when the transaction aborts", async () => {
    const org = await ownerOrg();
    const { start } = calendarMonthUtc();
    await expect(db!.migrateEdition!(async tx => {
      await tx.query("SELECT * FROM montral_spend_usage_once($1::text,$2::timestamptz,'emails',$3::text,$4::integer)",
        [org, start.toISOString(), "synthetic-crash-before-commit", 20]);
      throw new Error("synthetic worker aborted transaction before commit");
    })).rejects.toThrow("synthetic worker aborted");
    expect(await quota!.emailBalance(org)).toMatchObject({ used: 0 });
    expect(await quota!.reserveEmailQuotaOnce!(org, "synthetic-crash-before-commit")).toEqual({ granted: true, newlyReserved: true });
    expect(await quota!.emailBalance(org)).toMatchObject({ used: 1 });
  });

  it("isolates tenant and usage month even with the same dispatch key", async () => {
    const org = await ownerOrg();
    const other = await ownerOrg();
    const key = "synthetic-identical-logical-id";
    expect(await quota!.reserveEmailQuotaOnce!(org, key)).toEqual({ granted: true, newlyReserved: true });
    expect(await quota!.reserveEmailQuotaOnce!(other, key)).toEqual({ granted: true, newlyReserved: true });
    const query = "SELECT granted,is_new FROM montral_spend_usage_once($1::text,$2::timestamptz,'emails',$3::text,$4::integer)";
    expect((await db!.query(query, [org, "2026-08-01T00:00:00Z", key, 20]))[0]).toMatchObject({ granted: 1, is_new: true });
    expect((await db!.query(query, [org, "2026-09-01T00:00:00Z", key, 20]))[0]).toMatchObject({ granted: 1, is_new: true });
    expect((await db!.query(query, [org, "2026-08-01T00:00:00Z", key, 20]))[0]).toMatchObject({ granted: 1, is_new: false });
    expect(await quota!.emailBalance(other)).toMatchObject({ used: 1 });
  });

  it("rejects malformed keys and non-email kinds without consuming allowance", async () => {
    const org = await ownerOrg();
    await expect(quota!.reserveEmailQuotaOnce!(org, "")).rejects.toThrow("Invalid email quota reservation key");
    await expect(quota!.reserveEmailQuotaOnce!(org, "x".repeat(201))).rejects.toThrow("Invalid email quota reservation key");
    const { start } = calendarMonthUtc();
    await expect(db!.query("SELECT * FROM montral_spend_usage_once($1::text,$2::timestamptz,'emails',$3::text,$4::integer)",
      [org, "2026-10-11T17:00:00Z", "off-cycle-key", 20])).rejects.toThrow();
    for (const kind of ["credits", "invalid"]) {
      await expect(db!.query("SELECT * FROM montral_spend_usage_once($1::text,$2::timestamptz,$3::text,$4::text,$5::integer)",
        [org, start.toISOString(), kind, "synthetic-key", 20])).rejects.toThrow();
    }
    expect(await quota!.emailBalance(org)).toMatchObject({ used: 0 });
  });

  it("is absent when metering is disabled, so staged callers must fail closed", () => {
    expect(createMontralEntitlements(db!, { MONTRAL_METERING_ENABLED: "false" } as Bindings).reserveEmailQuotaOnce).toBeUndefined();
  });
});
