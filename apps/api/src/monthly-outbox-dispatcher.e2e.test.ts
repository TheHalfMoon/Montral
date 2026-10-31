import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@montral/db-pg";
import type { Repo } from "@montral/repo";
import { configureEmail, setMailTransport } from "./email";
import { unmetered } from "./entitlements";
import type { Bindings } from "./env";
import { createMontralEntitlements } from "./montral-metering";
import { migrateMontralSchema } from "./schema-migrate";
import { montralEdition } from "./montral-edition";
import { dispatchPreparedMonthlyOutbox } from "./monthly-outbox-dispatcher";

const url = process.env.TEST_DATABASE_URL;
const db = url ? openDatabase(url, { max: 12 }) : null;
const flags = { MONTRAL_METERING_ENABLED: "true", MONTRAL_BILLING_ENABLED: "false" } as Bindings;
const entitlements = db ? createMontralEntitlements(db, flags) : null;
const month = "2026-09";
const when = new Date("2026-10-01T12:00:00.000Z");
const orgs: { org: string; users: string[] }[] = [];
const delivered: string[] = [];

async function makeReport(n = 2) {
  const org = `synthetic-dispatch-${crypto.randomUUID()}`;
  const users = Array.from({ length: n }, () => `synthetic-owner-${crypto.randomUUID()}`);
  await db!.query("INSERT INTO organization (id,name,slug,created_at) VALUES ($1,'Synthetic report',$1,NOW())", [org]);
  orgs.push({ org, users });
  for (const id of users) {
    await db!.query("INSERT INTO \"user\" (id,name,email,created_at,updated_at) VALUES ($1,'Test owner',$2,NOW(),NOW())", [id, `${id}@example.test`]);
    await db!.query("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ($1,$2,$3,'owner',NOW())", [`membership-${id}`, org, id]);
  }
  await db!.query("INSERT INTO workspace_setting(organization_id,monthly_report,last_report_month) VALUES($1,true,$2)", [org, month]);
  expect(await db!.repo.reserveMonthlyReportRecipients(org, month, users.map((userId) => ({ userId, email: `${userId}@example.test`, locale: "en" })))).toBe(n);
  const repo = { ...db!.repo, monthlyReport: async () => [{ name: "Synthetic uptime monitor", uptime: 99.8, downtimeMinutes: 3, incidents: 1 }] } as Repo;
  return { org, users, repo };
}

const counts = (org: string) => db!.repo.monthlyReportRecipientCounts(org, month);
const balance = (org: string) => entitlements!.emailBalance(org);

describe.skipIf(!url)("staged monthly outbox dispatcher with real PostgreSQL and loopback-only mail", () => {
  beforeAll(async () => { await migrateMontralSchema(db!, montralEdition); });
  beforeEach(() => {
    delivered.length = 0;
    configureEmail({ EMAIL_FROM: "montral-synthetic@example.test", WEB_ORIGIN: "http://localhost:3000" } as Bindings);
    setMailTransport(async (mail) => { delivered.push(mail.to); });
  });
  afterEach(() => { setMailTransport(undefined); vi.restoreAllMocks(); });
  afterAll(async () => {
    for (const { org, users } of orgs) {
      await db!.query("DELETE FROM organization WHERE id=$1", [org]);
      for (const id of users) await db!.query("DELETE FROM \"user\" WHERE id=$1", [id]);
    }
    await db?.close(1);
  });

  it("delivers every prepared owner exactly once and persists accepted states", async () => {
    const { org, users, repo } = await makeReport();
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toEqual({ claimed: 2, accepted: 2, uncertain: 0, quotaDenied: 0 });
    expect(delivered.slice().sort()).toEqual(users.map(u => `${u}@example.test`).sort());
    expect(await counts(org)).toMatchObject({ prepared: 0, accepted: 2, attempted: 0, uncertain: 0 });
    expect(await balance(org)).toMatchObject({ used: 2 });
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toEqual({ claimed: 0, accepted: 0, uncertain: 0, quotaDenied: 0 });
    expect(delivered).toHaveLength(2);
    expect(await balance(org)).toMatchObject({ used: 2 });
  });

  it("records uncertain after provider accepted then timed out, and keeps healthy peers moving", async () => {
    const { org, users, repo } = await makeReport();
    setMailTransport(async (mail) => {
      delivered.push(mail.to); // simulates a provider accepting before throwing
      if (mail.to === `${users[0]}@example.test`) throw new Error("synthetic SMTP private credential, acceptance unknown");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when);
    expect(result).toEqual({ claimed: 2, accepted: 1, uncertain: 1, quotaDenied: 0 });
    expect(delivered).toHaveLength(2);
    expect(await counts(org)).toMatchObject({ accepted: 1, uncertain: 1, prepared: 0 });
    expect(await balance(org)).toMatchObject({ used: 2 });
    await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when);
    expect(delivered).toHaveLength(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic SMTP private credential");
    expect(log).toHaveBeenCalledWith("monthly outbox provider acceptance uncertain");
  });

  it("never replays accepted SMTP after DB result persistence fails", async () => {
    const { org, users, repo } = await makeReport();
    const finish = repo.finishMonthlyReportRecipient.bind(repo);
    const broken = { ...repo, finishMonthlyReportRecipient: async (organization: string, reportMonth: string, userId: string, outcome: "accepted" | "uncertain") => {
      if (userId === users[0]) throw new Error("synthetic database private password after acceptance");
      return finish(organization, reportMonth, userId, outcome);
    } } as Repo;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPreparedMonthlyOutbox(broken, entitlements!, org, when)).toEqual({ claimed: 2, accepted: 1, uncertain: 0, quotaDenied: 0 });
    expect(delivered).toHaveLength(2);
    expect(await counts(org)).toMatchObject({ attempted: 1, accepted: 1, prepared: 0 });
    await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when);
    expect(delivered).toHaveLength(2);
    expect(await balance(org)).toMatchObject({ used: 2 });
    expect(log).toHaveBeenCalledWith("monthly outbox result persistence unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic database private password");
  });

  it("does not charge for malformed recipient and still sends another valid owner", async () => {
    const { org, users, repo } = await makeReport();
    const original = repo.preparedMonthlyReportRecipients.bind(repo);
    const broken = { ...repo, preparedMonthlyReportRecipients: async (organization: string, reportMonth: string) => {
      const rows = await original(organization, reportMonth);
      return rows.map((r) => r.userId === users[0] ? { ...r, email: "" } : r);
    } } as Repo;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPreparedMonthlyOutbox(broken, entitlements!, org, when)).toEqual({ claimed: 1, accepted: 1, uncertain: 0, quotaDenied: 0 });
    expect(delivered).toEqual([`${users[1]}@example.test`]);
    expect(await counts(org)).toMatchObject({ prepared: 1, accepted: 1 });
    expect(await balance(org)).toMatchObject({ used: 1 });
    expect(log).toHaveBeenCalledWith("monthly outbox message preparation unavailable");
  });

  it("refuses to charge or send when there is no configured provider", async () => {
    const { org, repo } = await makeReport();
    setMailTransport(undefined);
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toMatchObject({ claimed: 0, accepted: 0 });
    expect(await counts(org)).toMatchObject({ prepared: 2 });
    expect(await balance(org)).toMatchObject({ used: 0 });
  });

  it("does not consume quota or send when the workspace report is disabled", async () => {
    const { org, repo } = await makeReport();
    await db!.query("UPDATE workspace_setting SET monthly_report=false WHERE organization_id=$1", [org]);
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toMatchObject({ claimed: 0, accepted: 0 });
    expect(delivered).toHaveLength(0);
    expect(await counts(org)).toMatchObject({ prepared: 2 });
    expect(await balance(org)).toMatchObject({ used: 0 });
  });

  it("does not resend after a worker crashed immediately after committed claim but before SMTP", async () => {
    const { org, users, repo } = await makeReport(1);
    expect(await entitlements!.claimMonthlyOutboxAttempt!(org, month, users[0])).toBe("attempted");
    expect(await counts(org)).toMatchObject({ attempted: 1 });
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toMatchObject({ claimed: 0 });
    expect(delivered).toHaveLength(0);
    expect(await balance(org)).toMatchObject({ used: 1 });
  });

  it("lets three concurrent dispatcher workers jointly send each prepared owner once", async () => {
    const { org, users, repo } = await makeReport(3);
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)));
    expect(outcomes.reduce((n, r) => n + r.claimed, 0)).toBe(3);
    expect(outcomes.reduce((n, r) => n + r.accepted, 0)).toBe(3);
    expect(delivered.slice().sort()).toEqual(users.map((u) => `${u}@example.test`).sort());
    expect(await counts(org)).toMatchObject({ prepared: 0, attempted: 0, accepted: 3 });
    expect(await balance(org)).toMatchObject({ used: 3 });
  });

  it("fails closed without charging if the prepared-recipient query fails", async () => {
    const { org, repo } = await makeReport();
    const unavailable = { ...repo, preparedMonthlyReportRecipients: async () => {
      throw new Error("private database connection string");
    } } as Repo;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPreparedMonthlyOutbox(unavailable, entitlements!, org, when)).toMatchObject({ claimed: 0, accepted: 0 });
    expect(delivered).toHaveLength(0);
    expect(await balance(org)).toMatchObject({ used: 0 });
    expect(await counts(org)).toMatchObject({ prepared: 2 });
    expect(log).toHaveBeenCalledWith("monthly outbox preparation unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private database connection string");
  });

  it("enforces reporting window and refuses unmetered entitlement bypass", async () => {
    const { org, repo } = await makeReport();
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, new Date("2026-10-04T00:00:00Z"))).toMatchObject({ claimed: 0 });
    expect(await dispatchPreparedMonthlyOutbox(repo, unmetered, org, when)).toMatchObject({ claimed: 0 });
    expect(delivered).toHaveLength(0);
    expect(await counts(org)).toMatchObject({ prepared: 2 });
  });
});
