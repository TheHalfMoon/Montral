/** Internal-only, disposable local crash-qualification child.
 * Never register as a daemon, scheduler, API handler or production job. */
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { openDatabase } from "@montral/db-pg";
import type { Repo } from "@montral/repo";
import { configureEmail, setMailTransport } from "../src/email";
import { createMontralEntitlements } from "../src/montral-metering";
import type { Bindings } from "../src/env";
import { runStagedMonthlyOutboxBatch } from "../src/monthly-outbox-dispatcher";

const { MONTRAL_KILL_URL: url, MONTRAL_KILL_ORG: org, MONTRAL_KILL_OWNER: owner,
  MONTRAL_KILL_MONTH: month, MONTRAL_KILL_MODE: mode, MONTRAL_KILL_SINK: sink } = process.env;
if (!url || !org || !owner || !month || !mode || !sink ||
  !/^[a-zA-Z0-9_-]+$/.test(org) || !/^[a-zA-Z0-9_-]+$/.test(owner) ||
  !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) ||
  !["snapshot", "attempt", "dispatch", "accept-hang", "transaction"].includes(mode)) {
  throw new Error("Local crash worker fixture required");
}
const location = new URL(url);
if (!["127.0.0.1", "localhost"].includes(location.hostname)
  || !/^\/montral_kill_[a-z0-9]+$/.test(location.pathname)
  || !/^\/tmp\/montral-kill-sink-[a-zA-Z0-9_-]+$/.test(sink)) {
  throw new Error("Refusing nonlocal or non-disposable crash fixture");
}

const db = openDatabase(url, { max: 3 });
const flags = { MONTRAL_METERING_ENABLED: "true", MONTRAL_BILLING_ENABLED: "false" } as Bindings;
const meter = createMontralEntitlements(db, flags);
const now = new Date();
const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 10));
// Synthetic presentation only, never introspects real monitors or customers.
const repo = { ...db.repo, monthlyReport: async () => [{
  name: "synthetic-local-crash-monitor", uptime: 100, downtimeMinutes: 0, incidents: 0,
}] } as Repo;
configureEmail({ EMAIL_FROM: "montral-kill-fixture@example.test", WEB_ORIGIN: "http://localhost:8787" } as Bindings);
function signal(stage: string) { process.stdout.write(`STAGE:${stage}\n`); }
function hang(): Promise<never> { return new Promise(() => {}); }

try {
  if (mode === "transaction") {
    // Block the *real business transaction* via the disposable DB's trigger.
    // The orchestrator detects PgSleep and sends SIGKILL to the Node process.
    await db.repo.claimMonthlyReportsWithRecipients(month, 1);
    signal("UNEXPECTED_TRANSACTION_COMMIT");
    process.exitCode = 9;
  } else if (mode === "snapshot") {
    const claimed = await db.repo.claimMonthlyReportsWithRecipients(month, 1);
    if (claimed.length !== 1 || claimed[0] !== org) throw new Error("Synthetic snapshot not committed");
    signal("SNAPSHOT_COMMITTED");
    await hang();
  } else if (mode === "attempt") {
    const result = await meter.claimMonthlyOutboxAttempt?.(org, month, owner);
    if (result !== "attempted") throw new Error("Synthetic quota claim not committed");
    signal("ATTEMPT_COMMITTED");
    await hang();
  } else {
    setMailTransport(async (message) => {
      if (message.to !== `${owner}@example.test`) throw new Error("Unexpected synthetic delivery target");
      // fsync gives the parent independent evidence of one accepted message
      // when this process is forcibly killed, without external SMTP/network.
      const fd = openSync(sink, "a", 0o600);
      try { writeSync(fd, "accepted\n"); fsyncSync(fd); } finally { closeSync(fd); }
      if (mode === "accept-hang") {
        signal("TRANSPORT_ACCEPTED");
        await hang();
      }
    });
    const result = await runStagedMonthlyOutboxBatch(repo, meter, first, 1);
    signal(`DISPATCH_RESULT:${JSON.stringify(result)}`);
  }
} finally {
  // SIGKILL intentionally bypasses finally. For successful runs, close cleanly.
  await db.close(2);
}
