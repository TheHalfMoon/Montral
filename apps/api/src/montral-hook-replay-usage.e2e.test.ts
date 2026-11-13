import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { migrateHookReplayUsage, readHookReplayUsage, recordHookReplayAttempt } from "./montral-hook-replay-usage";

const url = process.env.TEST_DATABASE_URL;

/** Database-backed concurrency and tenant-isolation regression.
 * Only synthetic workspaces are used. PostgreSQL global setup handles core
 * migrations; this test does not touch other tenants' rows or live services.
 */
describe.skipIf(!url)("Montral outbound hook replay attempt counters (PostgreSQL)", () => {
  const db = url ? openDatabase(url, { max: 8 }) : null;
  const first = "replay-count-" + randomUUID();
  const second = "replay-count-" + randomUUID();
  beforeAll(async () => {
    await migrateHookReplayUsage(db!);
    for (const org of [first, second])
      await db!.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic replay count',$1,NOW())", [org]);
  });
  afterAll(async () => {
    try {
      for (const org of [first, second])
        await db?.query("DELETE FROM organization WHERE id=$1", [org]);
    } finally {
      await db?.close(5);
    }
  });
  it("counts concurrent admissions atomically, without leaking another workspace", async () => {
    const empty = await readHookReplayUsage(db!, first);
    expect(empty.attempts).toBe("0");
    expect(empty.periodStart).toMatch(/^\d{4}-\d{2}-01$/);
    expect(empty.periodEnd).toMatch(/^\d{4}-\d{2}-01$/);
    expect(empty.periodStart < empty.periodEnd).toBe(true);
    await Promise.all(Array.from({ length: 32 }, () => recordHookReplayAttempt(db!, first)));
    expect((await readHookReplayUsage(db!, first)).attempts).toBe("32");
    expect((await readHookReplayUsage(db!, second)).attempts).toBe("0");
    await recordHookReplayAttempt(db!, second);
    expect((await readHookReplayUsage(db!, second)).attempts).toBe("1");
    expect((await readHookReplayUsage(db!, first)).attempts).toBe("32");
    const rows = await db!.query<{ organization_id: string; attempts: string }>(
      "SELECT organization_id,attempts::text AS attempts FROM montral_hook_replay_usage WHERE organization_id IN ($1,$2) ORDER BY organization_id",
      [first, second],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.attempts).sort()).toEqual(["1", "32"]);
    // DELETE of workspace must cascade; no residual identifiers or counters.
  }, 20_000);
});
