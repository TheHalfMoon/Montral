/** No network beyond loopback PostgreSQL and no automatic deletion.
 * `--execute-disposable` is a controlled experiment ONLY against a synthetic
 * local montraL_test_* database, never customer or hosted data. */
import { createDb } from "@montral/db-pg";
import { inspectFrozenContentRetention, purgeFrozenContentInDisposableTestDb } from "../src/monthly-content-retention";

const url = process.env.TEST_DATABASE_URL;
const [daysText, mode] = process.argv.slice(2);
const days = Number(daysText);
let parsed: URL | null = null;
try { if (url) parsed = new URL(url); } catch { /* redact invalid secret */ }
if (!parsed || !["localhost", "127.0.0.1"].includes(parsed.hostname)
  || !/^\/montral_test_[A-Za-z0-9_]+$/.test(parsed.pathname)
  || !/^[0-9]+$/.test(daysText ?? "") || !Number.isSafeInteger(days)
  || days < 180 || days > 3650 || (mode && mode !== "--execute-disposable")) {
  console.error("Usage: local synthetic TEST_DATABASE_URL, 180..3650 days, optional --execute-disposable");
  process.exitCode = 2;
} else {
  const db = createDb(url!, { max: 2 });
  try {
    const now = new Date();
    const before = await inspectFrozenContentRetention(db, days, now);
    if (mode === "--execute-disposable") {
      const deleted = await purgeFrozenContentInDisposableTestDb(db, days, now);
      const after = await inspectFrozenContentRetention(db, days, now);
      console.log(JSON.stringify({ executedOnDisposableOnly: true, deleted, before, after }, null, 2));
    } else console.log(JSON.stringify(before, null, 2));
  } catch {
    console.error("Content retention rehearsal unavailable; NO_GO");
    process.exitCode = 2;
  } finally { await db.$client.end({ timeout: 3 }); }
}
