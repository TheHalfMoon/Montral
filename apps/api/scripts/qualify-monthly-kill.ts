/** REAL OS PROCESS-KILL QUALIFICATION — NOT A PRODUCTION SCHEDULER.
 * Usage: with an already disposable local montraL_test_* PG database:
 *   pnpm --filter @montral/api exec tsx scripts/qualify-monthly-kill.ts
 * Every case operates on a new locally-created montraL_kill_* database, which
 * is dropped at the end. No real SMTP, hosted DB, or merchant activity. */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { openDatabase } from "@montral/db-pg";
import { migrateMontralSchema } from "../src/schema-migrate";
import { montralEdition } from "../src/montral-edition";

const original = process.env.TEST_DATABASE_URL;
if (!original) throw new Error("Required disposable TEST_DATABASE_URL");
const adminUrl = new URL(original);
if (!["localhost", "127.0.0.1"].includes(adminUrl.hostname) || !/^\/montral_test_[A-Za-z0-9_]+$/.test(adminUrl.pathname))
  throw new Error("SIGKILL test refuses remote or non-disposable PostgreSQL");
const suffix = randomBytes(7).toString("hex");
const name = `montral_kill_${suffix}`;
const sink = `/tmp/montral-kill-sink-${suffix}`;
const monthDate = new Date();
const month = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
const url = new URL(original);
url.pathname = `/${name}`;
const dbUrl = url.href;
const admin = openDatabase(original, { max: 1 });
let db: ReturnType<typeof openDatabase> | null = null;
let created = false;
const workers = new Set<ChildProcess>();
const workerFile = resolve("scripts/monthly-kill-worker.ts");
const flags = { MONTRAL_KILL_URL: dbUrl, MONTRAL_KILL_MONTH: month, MONTRAL_KILL_SINK: sink };
const orgs = new Map<string, { org: string; owner: string }>();

function assert(ok: unknown, description: string): asserts ok {
  if (!ok) throw new Error(`CRASH_QUALIFICATION_FAILED: ${description}`);
};
/** Cancellable timer: no lingering promises keep a successful drill alive. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    timer.unref();
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
async function eventually(fn: () => Promise<boolean> | boolean, what: string, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(75);
  }
  throw new Error(`Timed out on ${what}`);
}
function killGroup(child: ChildProcess) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function start(mode: string, fixture: { org: string; owner: string }) {
  const child = spawn(process.execPath, ["--import", "tsx", workerFile], {
    // Own process group: when tsx uses a loader subprocess, killing only the
    // parent would leave the real database client alive to COMMIT later.
    detached: true, cwd: process.cwd(), env: {
      // Never inherit parent tokens or billing/provider credentials.
      PATH: process.env.PATH, NODE_ENV: "test", TZ: "UTC", ...flags,
      MONTRAL_KILL_MODE: mode,
      MONTRAL_KILL_ORG: fixture.org, MONTRAL_KILL_OWNER: fixture.owner,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  workers.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (part: string) => { stdout = (stdout + part).slice(-2000); });
  child.stderr?.on("data", (part: string) => { stderr = (stderr + part).slice(-1000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("exit", (code, signal) => { workers.delete(child); done({ code, signal }); });
    child.once("error", () => { workers.delete(child); done({ code: -1, signal: null }); });
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}
async function killAfterStage(mode: string, fixture: { org: string; owner: string }, stage: string) {
  const job = start(mode, fixture);
  try {
    await eventually(async () => {
      if (job.child.exitCode !== null) throw new Error(`${mode} worker exited early: ${job.stderr()}`);
      return job.stdout().includes(`STAGE:${stage}\n`);
    }, `${mode}: ${stage}`, 20000);
    killGroup(job.child);
    const exited = await within(job.exited, 5000, `${mode} process exit`);
    assert(exited.signal === "SIGKILL", `${mode} was not SIGKILL terminated`);
  } finally {
    if (job.child.exitCode === null) killGroup(job.child);
  }
}
async function completed(mode: string, fixture: { org: string; owner: string }) {
  const job = start(mode, fixture);
  const ended = await within(job.exited, 20000, `${mode} process completion`);
  assert(ended.code === 0, `${mode} exited ${ended.code}: ${job.stderr()}`);
  const line = job.stdout().split("\n").find((x) => x.startsWith("STAGE:DISPATCH_RESULT:"));
  assert(line, `${mode} did not report result`);
  return JSON.parse(line.slice("STAGE:DISPATCH_RESULT:".length)) as { workspaces: number; claimed: number; accepted: number; uncertain: number; quotaDenied: number };
}
async function makeFixture(kind: string, legacy = false) {
  const org = `synthetic_kill_${kind}_${suffix}`;
  const owner = `synthetic_owner_${kind}_${suffix}`;
  await db!.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,NOW())", [org]);
  await db!.query('INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES($1,$1,$2,NOW(),NOW())', [owner, `${owner}@example.test`]);
  await db!.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',NOW())", [`m_${owner}`, org, owner]);
  await db!.query("INSERT INTO workspace_setting(organization_id,monthly_report,last_report_month) VALUES($1,true,$2)", [org, legacy ? month : null]);
  const fixture = { org, owner };
  orgs.set(kind, fixture);
  return fixture;
}
async function status(fixture: { org: string; owner: string }) {
  const [workspace] = await db!.query<{ last_report_month: string | null }>(
    "SELECT last_report_month FROM workspace_setting WHERE organization_id=$1", [fixture.org],
  );
  const [recipient] = await db!.query<{ state: string; attempted_at: Date | null }>(
    "SELECT state, attempted_at FROM monthly_report_recipient WHERE organization_id=$1 AND report_month=$2 AND recipient_user_id=$3",
    [fixture.org, month, fixture.owner],
  );
  const usage = await db!.query<{ used: number }>(
    "SELECT used FROM montral_usage WHERE organization_id=$1 AND kind='emails'", [fixture.org],
  );
  const reservations = await db!.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM montral_usage_reservation WHERE organization_id=$1", [fixture.org],
  );
  const [snapshot] = await db!.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM monthly_report_content WHERE organization_id=$1 AND report_month=$2", [fixture.org, month],
  );
  return { claimedMonth: workspace?.last_report_month ?? null, state: recipient?.state ?? null,
    attemptedAt: recipient?.attempted_at ?? null, debited: usage.reduce((total, v) => total + Number(v.used), 0),
    reservations: Number(reservations[0]?.n ?? 0), frozen: Number(snapshot?.n ?? 0) };
}
function sinkCount() {
  const content = readFileSync(sink, "utf8");
  if (content && !/^(accepted\n)+$/.test(content)) throw new Error("Malformed synthetic sink data");
  return content ? content.trimEnd().split("\n").length : 0;
}

try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  db = openDatabase(dbUrl, { max: 8 });
  await migrateMontralSchema(db, montralEdition);
  writeFileSync(sink, "", { flag: "wx", mode: 0o600 });

  // Case 1: SIGKILL during the real atomic owner snapshot transaction.
  // This temporary trigger sleeps *after recipient INSERT*, before month claim
  // is updated/transaction committed, rather than faking an API error.
  const transaction = await makeFixture("transaction");
  await db.query(`CREATE FUNCTION synthetic_kill_wait() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.organization_id = '${transaction.org}' THEN PERFORM pg_sleep(7); END IF;
      RETURN NEW; END; $$`);
  await db.query(`CREATE TRIGGER synthetic_kill_wait_trigger AFTER INSERT ON monthly_report_recipient
    FOR EACH ROW EXECUTE FUNCTION synthetic_kill_wait()`);
  const waiting = start("transaction", transaction);
  try {
    await eventually(async () => {
      const rows = await db!.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event='PgSleep'", [name],
      );
      return Number(rows[0]?.n ?? 0) > 0;
    }, "real transaction entered PostgreSQL pg_sleep", 20000);
    killGroup(waiting.child);
    const killed = await within(waiting.exited, 5000, "transaction process exit");
    assert(killed.signal === "SIGKILL", "transaction worker not forcibly killed");
  } finally {
    if (waiting.child.exitCode === null) killGroup(waiting.child);
    await eventually(async () => {
      const rows = await db!.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event='PgSleep'", [name],
      );
      return Number(rows[0]?.n ?? 0) === 0;
    }, "PostgreSQL transaction process disconnected");
    await db.query("DROP TRIGGER IF EXISTS synthetic_kill_wait_trigger ON monthly_report_recipient");
    await db.query("DROP FUNCTION IF EXISTS synthetic_kill_wait()");
  }
  let check = await status(transaction);
  assert(check.claimedMonth === null && check.state === null && check.debited === 0 && check.reservations === 0 && check.frozen === 0,
    "SIGKILL before commit left an orphaned month, recipient or debit");
  console.log("KILL_PRECOMMIT_ROLLBACK_PASS");

  // Case 2: a committed snapshot is recoverable after killing its process.
  await killAfterStage("snapshot", transaction, "SNAPSHOT_COMMITTED");
  check = await status(transaction);
  assert(check.claimedMonth === month && check.state === "prepared" && check.debited === 0 && check.frozen === 0,
    "committed recipient snapshot was not prepared after SIGKILL");
  let dispatched = await completed("dispatch", transaction);
  assert(dispatched.accepted === 1 && dispatched.claimed === 1, "committed pre-SMTP snapshot did not recover");
  check = await status(transaction);
  assert(check.state === "accepted" && check.debited === 1 && check.reservations === 1 && check.frozen === 1 && sinkCount() === 1,
    "recovered snapshot sent, debited or reserved more than once");
  dispatched = await completed("dispatch", transaction);
  assert(dispatched.accepted === 0 && sinkCount() === 1, "recovered accepted delivery replayed");
  console.log("KILL_COMMITTED_SNAPSHOT_RECOVERY_PASS");

  // Case 3: durable attempted + quota, then process death *before SMTP*.
  const preSmtp = await makeFixture("presmtp");
  await killAfterStage("snapshot", preSmtp, "SNAPSHOT_COMMITTED");
  await killAfterStage("attempt", preSmtp, "ATTEMPT_COMMITTED");
  check = await status(preSmtp);
  assert(check.state === "attempted" && check.debited === 1 && check.reservations === 1 && check.frozen === 0,
    "post-attempt SIGKILL did not leave one durable attempt and quota");
  dispatched = await completed("dispatch", preSmtp);
  assert(dispatched.accepted === 0 && (await status(preSmtp)).state === "attempted" && sinkCount() === 1,
    "post-attempt SIGKILL allowed a second provider attempt");
  console.log("KILL_ATTEMPT_BEFORE_SMTP_NO_REPLAY_PASS");

  // Case 4: local provider already accepted and fsync'd, but the worker is
  // killed while awaiting an unresolved provider promise, before result save.
  const afterAccept = await makeFixture("accepted");
  await killAfterStage("snapshot", afterAccept, "SNAPSHOT_COMMITTED");
  await killAfterStage("accept-hang", afterAccept, "TRANSPORT_ACCEPTED");
  check = await status(afterAccept);
  assert(check.state === "attempted" && check.debited === 1 && check.reservations === 1 && check.frozen === 1 && sinkCount() === 2,
    "provider-accepted kill did not persist one claimed attempt and one sink acceptance");
  dispatched = await completed("dispatch", afterAccept);
  assert(dispatched.accepted === 0 && (await status(afterAccept)).state === "attempted" && sinkCount() === 2,
    "ambiguous provider acceptance replayed after SIGKILL");
  console.log("KILL_AFTER_PROVIDER_ACCEPTANCE_NO_REPLAY_PASS");

  // Case 5: a historical org-only claim with no outbox has UNKNOWN history.
  const legacy = await makeFixture("legacy", true);
  dispatched = await completed("dispatch", legacy);
  check = await status(legacy);
  assert(dispatched.accepted === 0 && check.state === null && check.debited === 0 && check.frozen === 0 && sinkCount() === 2,
    "legacy org-only claim got resurrected without recipient evidence");
  console.log("KILL_LEGACY_CLAIM_NO_RESURRECTION_PASS");
  console.log("MONTHLY_REAL_SIGKILL_DRILL_PASS: five synthetic crash boundaries, durable local sink, one-time quota, no replay");
} finally {
  for (const child of workers) if (child.exitCode === null) killGroup(child);
  if (workers.size) await pause(500);
  if (db) await db.close(3);
  if (created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close(3);
  rmSync(sink, { force: true });
}
