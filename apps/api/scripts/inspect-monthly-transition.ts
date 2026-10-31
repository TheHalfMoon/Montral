/** Explicit local read-only transition audit. No external DB or send actions. */
import { createDb } from "@montral/db-pg";
import { inspectMonthlyTransition, validTransitionMonth } from "../src/monthly-transition-preflight";

const url = process.env.TEST_DATABASE_URL;
const reportMonth = process.argv[2];
if (!url || !reportMonth || !validTransitionMonth(reportMonth)) {
  console.error("Usage: with disposable local TEST_DATABASE_URL, pass YYYY-MM report month");
  process.exitCode = 2;
} else {
  // A malformed URL can contain credentials. Never allow Node's parser to
  // print it in an uncaught exception, or attempt a fallback connection.
  let target: URL | null = null;
  try { target = new URL(url); } catch { /* fail closed below */ }
  const dbName = target ? target.pathname.slice(1) : "";
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !/^montral_test_[a-zA-Z0-9_]+$/.test(dbName)) {
    // No connection attempted, and never print the connection string.
    console.error("Transition preflight is restricted to isolated loopback test databases");
    process.exitCode = 2;
  } else {
    const db = createDb(url, { max: 1 });
    try {
      const summary = await inspectMonthlyTransition(db, reportMonth);
      console.log(JSON.stringify(summary, null, 2));
    } catch {
      // A migration/permission/connection failure must never expose credentials
      // or give a false clean audit result.
      console.error("Monthly transition preflight unavailable; NO_GO");
      process.exitCode = 2;
    } finally { await db.$client.end({ timeout: 3 }); }
  }
}
