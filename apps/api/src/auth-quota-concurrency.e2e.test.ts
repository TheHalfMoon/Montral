import { openDatabase } from "@montral/db-pg";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "synthetic-concurrent-qualification-secret", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, CRON_SECRET: "cron", TRUST_PROXY: "true" };
const replicas = [createApp(openDatabase), createApp(openDatabase)];

async function bounded<T>(count: number, concurrency: number, run: (n: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < count) { const n = cursor++; results[n] = await run(n); }
  }));
  return results;
}

describe.skipIf(!url)("cross-replica PostgreSQL authentication quota qualification", () => {
  beforeAll(async () => {
    const response = await replicas[0].fetch(new Request(`${origin}/internal/migrate`, { method: "POST", headers: { "x-cron-secret": "cron" } }), env as never);
    expect(response.status).toBe(200);
  });

  it("shares one IPv6 and per-email budget across two API instances during a bounded burst", async () => {
    const email = `burst-${crypto.randomUUID()}@example.test`;
    const suffix = (parseInt(crypto.randomUUID().slice(0, 4), 16) || 1).toString(16);
    const ipv6 = [`2001:db8::${suffix}`, `2001:0DB8:0000:0000:0000:0000:0000:${suffix.toUpperCase().padStart(4, "0")}`];
    const started = Date.now();
    const status = await bounded(24, 6, async n => {
      const response = await replicas[n % 2].fetch(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `untrusted-${n}, ${ipv6[n % 2]}` },
        body: JSON.stringify({ email: n % 2 ? email.toUpperCase() : email, password: "incorrect-test-only-password" }),
      }), env as never);
      return response.status;
    });
    expect(status.filter(s => s === 429)).toHaveLength(9);
    expect(status.filter(s => s !== 429)).toHaveLength(15);
    expect(status.some(s => s >= 500)).toBe(false);
    const db = openDatabase(url!, { max: 1 });
    try {
      const emailKey = `auth:mail:${email}:/api/auth/sign-in/email`;
      const ipKey = `auth:ip:2001:db8::${suffix}:/api/auth/sign-in/email`;
      expect(await db.query<{ key: string; count: number }>("select key,count from rate_limit where key in ($1,$2) order by key", [emailKey, ipKey]))
        .toEqual([{ key: emailKey, count: 24 }, { key: ipKey, count: 24 }].sort((a,b) => a.key.localeCompare(b.key)));
    } finally { await db.close(1); }
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 30_000);
  it("does not share one email's quota with a distinct account under simultaneous load", async () => {
    const accounts = [
      `account-a-${crypto.randomUUID()}@example.test`,
      `account-b-${crypto.randomUUID()}@example.test`,
    ];
    const ipBase = (parseInt(crypto.randomUUID().slice(0, 4), 16) || 1);
    const response = await bounded(36, 6, async n => {
      const index = n % 2;
      const result = await replicas[n % 2].fetch(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `2001:db8::${(ipBase + index).toString(16)}` },
        body: JSON.stringify({ email: accounts[index], password: "incorrect-test-only-password" }),
      }), env as never);
      return { index, status: result.status };
    });
    for (const index of [0, 1]) {
      const group = response.filter(x => x.index === index);
      expect(group.filter(x => x.status === 429)).toHaveLength(3);
      expect(group.filter(x => x.status !== 429)).toHaveLength(15);
      expect(group.some(x => x.status >= 500)).toBe(false);
    }
    const db = openDatabase(url!, { max: 1 });
    try {
      for (const email of accounts) {
        const rows = await db.query<{ count: number }>("select count from rate_limit where key = $1", [`auth:mail:${email}:/api/auth/sign-in/email`]);
        expect(rows).toEqual([{ count: 18 }]);
      }
    } finally { await db.close(1); }
  }, 30_000);

});
