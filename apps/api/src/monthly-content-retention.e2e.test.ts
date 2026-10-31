import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, openDatabase } from "@montral/db-pg";
import { migrateMontralSchema } from "./schema-migrate";
import { montralEdition } from "./montral-edition";
import { inspectFrozenContentRetention, purgeFrozenContentInDisposableTestDb } from "./monthly-content-retention";

const base = process.env.TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const dbName = `montral_test_contentretention_${suffix}`;
const now = new Date("2026-10-31T10:00:00.000Z");
const old = new Date("2026-03-01T10:00:00.000Z").toISOString();
const recent = new Date("2026-08-01T10:00:00.000Z").toISOString();
const id = (kind: string) => `synthetic-retention-${kind}-${suffix}`;

/** Nothing is automatically removed: tests create only a disposable isolated
 * database and explicitly invoke the rehearsal-only method. */
describe.skipIf(!base)("local-only confidential monthly content retention rehearsal", () => {
  let admin: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;
  let database: ReturnType<typeof openDatabase>;
  let uri: string;
  beforeAll(async () => {
    admin = createDb(base!, { max: 1 });
    await admin.$client.unsafe(`create database "${dbName}"`);
    const url = new URL(base!);
    url.pathname = `/${dbName}`;
    uri = url.href;
    db = createDb(uri, { max: 12 });
    database = openDatabase(uri, { max: 6 });
    await migrateMontralSchema(database, montralEdition);
    for (const [kind, state, createdAt] of [
      ["accepted", "accepted", old], ["skipped", "skipped", old],
      ["recent", "accepted", recent], ["prepared", "prepared", old],
      ["attempted", "attempted", old], ["uncertain", "uncertain", old],
      ["orphan", "none", old],
    ] as const) {
      const org = id(kind);
      const user = id(`owner-${kind}`);
      await database.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,NOW())", [org]);
      await database.query('INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES($1,$1,$2,NOW(),NOW())', [user, `${user}@example.test`]);
      await database.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',NOW())", [`member-${user}`, org, user]);
      await database.query("INSERT INTO workspace_setting(organization_id,monthly_report,last_report_month) VALUES($1,true,$2)", [org, "2026-02"]);
      const attempted = ["accepted", "skipped", "attempted", "uncertain"].includes(state);
      const decided = ["accepted", "skipped", "uncertain"].includes(state);
      if (state !== "none") await database.query(
        `INSERT INTO monthly_report_recipient(organization_id,report_month,recipient_user_id,recipient_email,locale,state,attempted_at,decided_at)
         VALUES($1,'2026-02',$2,$3,'en',$4,$5::timestamptz,$6::timestamptz)`,
        [org, user, `${user}@example.test`, state,
          attempted ? "2026-03-01T10:00:00Z" : null, decided ? "2026-03-01T10:01:00Z" : null],
      );
      await database.query(
        `INSERT INTO monthly_report_content(organization_id,report_month,workspace_name,components,created_at)
         VALUES($1,'2026-02',$2,$3::jsonb,$4::timestamptz)`,
        [org, `Sensitive ${kind} workspace`, JSON.stringify([{ name: `Confidential monitor ${kind}`, uptime: 97.5, downtimeMinutes: 10, incidents: 1 }]), createdAt],
      );
    }
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 3 });
    await database?.close(3);
    if (admin) {
      await admin.$client.unsafe(`drop database if exists "${dbName}"`);
      await admin.$client.end({ timeout: 3 });
    }
  });

  it("validates a conservative explicit window; never infers permission from an empty database", async () => {
    for (const days of [0, 1, 30, 179, 3651, 2.5, NaN, Infinity])
      await expect(inspectFrozenContentRetention(db, days, now)).rejects.toThrow("Invalid content retention rehearsal window");
    const result = await inspectFrozenContentRetention(db, 180, now);
    expect(result).toMatchObject({ outcome: "NO_GO", readOnly: true, permitsProductionPurge: false,
      counts: { total: 7, eligibleClosed: 2, heldRecent: 1, heldMissingRecipients: 1, heldUnresolved: 3 } });
    expect(result.countsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await inspectFrozenContentRetention(db, 180, now)).toEqual(result);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Sensitive");
    expect(serialized).not.toContain("Confidential");
    expect(serialized).not.toContain("@example.test");
    expect(serialized).not.toContain(suffix);
  });

  it("rehearsal removes only aged closed content, preserving usage recipients and uncertain cases", async () => {
    const before = await db.$client`select count(*)::integer as n from monthly_report_recipient`;
    expect(await purgeFrozenContentInDisposableTestDb(db, 180, now, 1)).toBe(1);
    expect(await purgeFrozenContentInDisposableTestDb(db, 180, now, 1)).toBe(1);
    expect(await purgeFrozenContentInDisposableTestDb(db, 180, now, 1)).toBe(0);
    const report = await inspectFrozenContentRetention(db, 180, now);
    expect(report.counts).toEqual({ total: 5, eligibleClosed: 0, heldRecent: 1,
      heldMissingRecipients: 1, heldUnresolved: 3 });
    const after = await db.$client`select count(*)::integer as n from monthly_report_recipient`;
    expect(after[0].n).toBe(before[0].n);
    const keep = await db.$client`select organization_id from monthly_report_content order by organization_id`;
    expect(keep.map((r) => r.organization_id)).toEqual(["attempted", "orphan", "prepared", "recent", "uncertain"].map(id).sort());
  });

  it("hard-rejects direct destructive calls against a non-disposable database", async () => {
    const notDisposable = new URL(base!);
    notDisposable.pathname = "/postgres";
    const other = createDb(notDisposable.href, { max: 1 });
    try {
      await expect(purgeFrozenContentInDisposableTestDb(other, 180, now))
        .rejects.toThrow("Disposable localhost database required");
    } finally { await other.$client.end({ timeout: 3 }); }
  });

  it("remains fail-closed for bad batch sizes and a newly accepted but previously attempted row", async () => {
    await expect(purgeFrozenContentInDisposableTestDb(db, 180, now, 0)).rejects.toThrow();
    await expect(purgeFrozenContentInDisposableTestDb(db, 180, now, 101)).rejects.toThrow();
    await db.$client`update monthly_report_recipient set state='accepted', decided_at=now()
      where organization_id=${id("attempted")} and state='attempted'`;
    // Now all recipients are terminal and old content MAY be eligible for
    // deletion by a separate explicit rehearsal, but none deleted automatically.
    const report = await inspectFrozenContentRetention(db, 180, now);
    expect(report.counts.eligibleClosed).toBe(1);
    expect(report.outcome).toBe("NO_GO");
    const concurrent = await Promise.all(Array.from({ length: 8 }, () =>
      purgeFrozenContentInDisposableTestDb(db, 180, now, 1)));
    expect(concurrent.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect((await inspectFrozenContentRetention(db, 180, now)).counts.heldUnresolved).toBe(2);
  });
});
