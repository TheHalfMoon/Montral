import { openDatabase } from "@montral/db-pg";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { Edition } from "./edition";
import { unmetered } from "./entitlements";
import { availableRegions, configureProbes, probeConfigurationFingerprint, resetProbeRegionCache } from "./probes";
import { PROBE_VALIDATION_TYPE, probeCredentialProofBody, signProbe, verifyProbe } from "./probe-protocol";
import { createManagedProbeEnrollmentGrant, consumeManagedProbeEnrollmentGrant } from "./managed-probe-enrollment";
import { generateAndPrepareManagedProbeCredential } from "./managed-probe-credential-prepare";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests). Region ids are unique
// to this file: the probe region table is platform-wide and other suites write to it too.
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const PASSWORD = "correct horse battery staple";
const PROBES = {
  "e2e-north": "https://probe.test/api/probe/e2e-north",
  "e2e-south": "https://probe.test/api/probe/e2e-south",
  "e2e-west": "https://probe.test/api/probe/e2e-west",
  // used only by the operator write-route negative tests: never checked, so no health write can touch their rows
  "e2e-east": "https://probe.test/api/probe/e2e-east",
  "e2e-central": "https://probe.test/api/probe/e2e-central",
};
const baseEnv = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "probe-regions-e2e-only-secret-not-for-production", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron",
  PROBE_SECRET: "probe-regions-e2e-secret", PROBE_REGIONS: JSON.stringify(PROBES),
  PROBE_SECRETS: JSON.stringify({ "e2e-north": "probe-regions-e2e-north-dedicated-secret" }),
  // the monitored target is a local server, so this location's own check can confirm or refute the probes
  ALLOW_PRIVATE_TARGETS: "true",
};
const enrollmentSigningKey = generateKeyPairSync("ed25519").privateKey;

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from the base32 secret of an otpauth:// URI. */
function totp(uri: string, at = Date.now()): string {
  const secret = new URL(uri).searchParams.get("secret")!.replace(/=+$/, "").toUpperCase();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const cookiesOf = (r: Response, current = "") => {
  const map = new Map(current.split("; ").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)] as const));
  for (const c of r.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    const value = kv.slice(kv.indexOf("=") + 1);
    if (!value || /max-age=0/i.test(c)) map.delete(kv.slice(0, kv.indexOf("=")));
    else map.set(kv.slice(0, kv.indexOf("=")), value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
};

/** A plan whose region cap the tests change, as a downgrade would. */
const plan = { maxRegions: 3 as number | null };
/** Credits taken, per workspace (the allowance itself is unlimited here). */
const spent: Record<string, number> = {};
const refunded: Record<string, number> = {};
const edition: Edition = {
  entitlements: () => ({
    ...unmetered,
    spendCredits: async (workspace: string, credits: number) => { spent[workspace] = (spent[workspace] ?? 0) + credits; return credits; },
    refundCredits: async (workspace: string, credits: number) => { refunded[workspace] = (refunded[workspace] ?? 0) + credits; },
    plan: async () => ({ id: "test", name: "Test", maxActiveMonitors: 50, minIntervalSec: 60, maxRegions: plan.maxRegions }),
  }),
};

describe.skipIf(!url)("probe regions: confirmation, drain, health and the plan cap (PostgreSQL)", () => {
  const db = url ? openDatabase(url, { max: 2 }) : null;
  const app = createApp(openDatabase, { edition });
  const monitorIds: string[] = [];
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  /** What each probe answers; a probe not listed is down. */
  const answers: Record<string, { ok: boolean; statusCode?: number; latencyMs?: number; error?: string }> = {};
  /** A custom proof answer exercises region mismatch, wrong-key and unavailable responses. */
  const proofAnswers: Record<string, { region?: string; challenge?: string; signingSecret?: string; capabilities?: string[] } | Error> = {};
  const validationRequests: Array<{ id: string; body: Record<string, unknown> }> = [];
  /** The local target: what this location's own check sees. */
  let targetStatus = 200;
  let server: Server;
  let target = "";

  beforeAll(async () => {
    server = createServer((_req, res) => { res.statusCode = targetStatus; res.end("ok"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (!u.startsWith("https://probe.test/")) return realFetch(input, init);
      const id = u.split("/").pop()!;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "POST") {
        const bodyText = String(init?.body ?? "");
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        if (body.type === PROBE_VALIDATION_TYPE) {
          validationRequests.push({ id, body });
          const headers = new Headers(init?.headers);
          const timestamp = headers.get("x-montral-timestamp");
          const key = id === "e2e-north" ? "probe-regions-e2e-north-dedicated-secret" : baseEnv.PROBE_SECRET;
          if (typeof body.challenge !== "string"
            || !await verifyProbe(key, { timestamp, signature: headers.get("x-montral-signature"), body: bodyText })) {
            return new Response(JSON.stringify({ error: "invalid synthetic validation request" }), { status: 401 });
          }
          const answer = proofAnswers[id];
          if (answer instanceof Error) throw answer;
          const region = answer?.region ?? id;
          const challenge = answer?.challenge ?? body.challenge;
          const capabilities = answer?.capabilities ?? ["http-request-body-v1", "http-json-assertion-v1"];
          const responseKey = answer?.signingSecret ?? key;
          return new Response(JSON.stringify({
            ok: true, region, challenge, capabilities,
            signature: await signProbe(responseKey, Number(timestamp), probeCredentialProofBody(region, String(challenge), capabilities)),
          }), { headers: { "content-type": "application/json" } });
        }
      }
      asked.push(id);
      const a = answers[id];
      if (!a) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify(a), { headers: { "content-type": "application/json" } });
    });
    await app.fetch(new Request(`${ORIGIN}/internal/migrate`, { method: "POST", headers: { "x-cron-secret": "cron" } }), baseEnv as never);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    configureProbes({});
    if (monitorIds.length) await db!.query(`UPDATE monitor SET paused = true, next_check_at = now() + interval '30 days' WHERE id = ANY(string_to_array($1::text, ',')::uuid[])`, [monitorIds.join(",")]);
    await db!.query(`DELETE FROM probe_region_state WHERE region = ANY(string_to_array($1::text, ','))`, [[...Object.keys(PROBES), "e2e-flip"].join(",")]);
    await db!.query(`DELETE FROM probe_region_drain_event WHERE region = ANY(string_to_array($1::text, ','))`, [[...Object.keys(PROBES), "e2e-flip"].join(",")]);
    await db?.close(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function account(extraEnv: Record<string, string> = {}) {
    const env = { ...baseEnv, ...extraEnv };
    const send = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
    const email = `regions-${crypto.randomUUID()}@example.com`;
    const su = await send("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, password: PASSWORD, name: "Ada" }) });
    const userId = ((await su.json()) as { user: { id: string } }).user.id;
    let cookie = cookiesOf(su);
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await send(`/api${path}`, { method, headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const next = cookiesOf(r, cookie);
      return { status: r.status, body: (await r.json().catch(() => null)) as any, next };
    };
    return { email, userId, call, send, setCookie: (c: string) => { cookie = c; }, get cookie() { return cookie; } };
  }

  async function monitor(call: Awaited<ReturnType<typeof account>>["call"], regions: string[]) {
    const r = await call("POST", "/monitors", { name: `Regions ${regions.join("+")}`, type: "http", target, intervalSec: 60, regions, failureThreshold: 1 });
    expect(r.status).toBe(201);
    monitorIds.push(r.body.id);
    return r.body as { id: string };
  }
  const reset = () => {
    for (const k of Object.keys(answers)) delete answers[k];
    for (const k of Object.keys(proofAnswers)) delete proofAnswers[k];
    asked.length = 0;
    validationRequests.length = 0;
  };

  /**
   * An operator listed in MONTRAL_OPERATOR_USER_IDS, as in the operator control-plane e2e: `verifiedCookie` comes from a
   * password + backup-code sign-in (recorded in operator_mfa_session); `unverifiedCookie` is the session that enabled
   * two-factor, which never passed a second factor at sign-in, and `signUpCookie` the original sign-up session.
   */
  async function operatorSessions() {
    const operator = await account();
    const ops = { MONTRAL_OPERATOR_USER_IDS: operator.userId };
    const send = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), { ...baseEnv, ...ops } as never);
    const auth = (cookie: string, path: string, body: unknown) => send(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const signUpCookie = operator.cookie;
    const enabled = await auth(signUpCookie, "/two-factor/enable", { password: PASSWORD });
    const enrolment = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
    const confirmed = await auth(cookiesOf(enabled, signUpCookie), "/two-factor/verify-totp", { code: totp(enrolment.totpURI) });
    expect(confirmed.status).toBe(200);
    const unverifiedCookie = cookiesOf(confirmed, cookiesOf(enabled, signUpCookie));
    const plain = await auth("", "/sign-in/email", { email: operator.email, password: PASSWORD });
    const verified = await auth(cookiesOf(plain), "/two-factor/verify-backup-code", { code: enrolment.backupCodes[0] });
    expect(verified.status).toBe(200);
    const verifiedCookie = cookiesOf(verified);
    const recorded = await db!.query<{ session_id: string }>(`SELECT m.session_id FROM operator_mfa_session m JOIN session s ON s.id = m.session_id WHERE s.user_id = $1`, [operator.userId]);
    expect(recorded).toHaveLength(1);
    return { operator, send, signUpCookie, unverifiedCookie, verifiedCookie };
  }

  it("does not open an incident on one region's failure while the others are down, unless this location agrees", async () => {
    const { call } = await account();
    const m = await monitor(call, ["e2e-north", "e2e-south", "e2e-west"]);
    reset();
    answers["e2e-north"] = { ok: false, statusCode: 503, latencyMs: 50, error: "Expected 200, got 503" };
    targetStatus = 200;
    expect((await call("POST", `/monitors/${m.id}/check`)).body).toEqual({ ok: true });
    let detail = (await call("GET", `/monitors/${m.id}`)).body;
    expect(detail.status).not.toBe("down");
    const incidents = () => db!.query<{ evaluation_note: string }>(`SELECT evaluation_note FROM incident WHERE monitor_id = $1::uuid AND auto = true`, [m.id]);
    expect(await incidents()).toHaveLength(0);
    // the failing region and this location's passing check are both on record
    expect(detail.results.map((r: { region: string; ok: boolean }) => [r.region, r.ok]).sort()).toEqual([["auto", true], ["e2e-north", false]]);

    // this location sees the outage too: the incident opens, with the vote in its evaluation note
    targetStatus = 503;
    expect((await call("POST", `/monitors/${m.id}/check`)).body).toEqual({ ok: true });
    detail = (await call("GET", `/monitors/${m.id}`)).body;
    expect(detail.status).toBe("down");
    const [incident] = await incidents();
    expect(incident.evaluation_note).toContain("1 of 1 regions failed, 2 unavailable; confirmed from this location");
    targetStatus = 200;
  });

  it("refunds unreturned manual-check regions and spot checks at their original reservation", async () => {
    const { call } = await account();
    const m = await monitor(call, ["e2e-north", "e2e-south", "e2e-west"]);
    const [{ organization_id: workspace }] = await db!.query<{ organization_id: string }>(
      `SELECT organization_id FROM monitor WHERE id=$1::uuid`, [m.id],
    );
    const net = () => (spent[workspace] ?? 0) - (refunded[workspace] ?? 0);
    reset();
    targetStatus = 200;
    answers["e2e-north"] = { ok: true, statusCode: 200 };
    const before = net();
    expect((await call("POST", `/monitors/${m.id}/check`)).status).toBe(200);
    expect(net() - before).toBe(1); // one region returned; two did not
    const beforeSpot = net();
    const failedSpot = await call("POST", `/monitors/${m.id}/check`, { region: "e2e-west" });
    expect(failedSpot.status).toBe(502);
    expect(failedSpot.body).toMatchObject({ code: "probe_unreachable", region: "e2e-west" });
    expect(net()).toBe(beforeSpot); // no result, so one-credit spot reservation is refunded
    reset();
    answers["e2e-north"] = { ok: true, statusCode: 200 };
    answers["e2e-south"] = { ok: true, statusCode: 200 };
    answers["e2e-west"] = { ok: true, statusCode: 200 };
    const beforeAll = net();
    expect((await call("POST", `/monitors/${m.id}/check`)).status).toBe(200);
    expect(net() - beforeAll).toBe(3); // three real results, no refund
  });

  it("records last-seen health per probe region, without probe error details", async () => {
    resetProbeRegionCache();
    const { call } = await account();
    const m = await monitor(call, ["e2e-north", "e2e-south"]);
    reset();
    answers["e2e-north"] = { ok: true, statusCode: 200, latencyMs: 20 };
    await call("POST", `/monitors/${m.id}/check`);
    // health writes are not awaited by the check: wait for them (bounded)
    type Row = { region: string; last_answer_at: Date | null; unreachable_since: Date | null; last_unreachable_reason: string | null };
    let by: Record<string, Row> = {};
    for (let i = 0; i < 50; i++) {
      const rows = await db!.query<Row>(`SELECT region, last_answer_at, unreachable_since, last_unreachable_reason FROM probe_region_state WHERE region IN ('e2e-north', 'e2e-south') ORDER BY region`);
      by = Object.fromEntries(rows.map((r) => [r.region, r]));
      if (by["e2e-north"]?.last_answer_at && by["e2e-south"]?.unreachable_since) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(by["e2e-north"].last_answer_at).not.toBeNull();
    expect(by["e2e-north"].unreachable_since).toBeNull();
    expect(by["e2e-south"].unreachable_since).not.toBeNull();
    expect(by["e2e-south"].last_unreachable_reason).toBe("Probe unreachable");
  });

  it("throttles health writes in the database: a minute per state, 10 seconds per flip", async () => {
    const repo = db!.repo;
    const read = async () => (await db!.query<{ unreachable_since: Date | null; last_answer_at: Date | null }>(`SELECT unreachable_since, last_answer_at FROM probe_region_state WHERE region = 'e2e-flip'`))[0];
    await db!.query(`DELETE FROM probe_region_state WHERE region = 'e2e-flip'`);
    await repo.noteProbeHealth!("e2e-flip", true);
    const first = await read();
    expect(first.last_answer_at).not.toBeNull();
    // the same state again within a minute: no write
    await repo.noteProbeHealth!("e2e-flip", true);
    expect((await read()).last_answer_at).toEqual(first.last_answer_at);
    // a flip within 10 seconds: no write
    await repo.noteProbeHealth!("e2e-flip", false, "Probe unreachable");
    expect((await read()).unreachable_since).toBeNull();
    // 11 seconds later the flip is written
    await db!.query(`UPDATE probe_region_state SET last_answer_at = now() - interval '11 seconds' WHERE region = 'e2e-flip'`);
    await repo.noteProbeHealth!("e2e-flip", false, "Probe unreachable");
    expect((await read()).unreachable_since).not.toBeNull();
    await db!.query(`DELETE FROM probe_region_state WHERE region = 'e2e-flip'`);
  });

  it("checks a downgraded monitor from the regions its plan allows only", async () => {
    const { call } = await account();
    plan.maxRegions = 3;
    const m = await monitor(call, ["e2e-north", "e2e-south", "e2e-west"]);
    plan.maxRegions = 1;
    try {
      reset();
      answers["e2e-north"] = { ok: true, statusCode: 200 };
      answers["e2e-south"] = { ok: true, statusCode: 200 };
      answers["e2e-west"] = { ok: true, statusCode: 200 };
      expect((await call("POST", `/monitors/${m.id}/check`)).body).toEqual({ ok: true });
      expect(asked).toEqual(["e2e-north"]);
      // the stored selection is kept, so upgrading again restores it
      expect((await call("GET", `/monitors/${m.id}`)).body.regions).toEqual(["e2e-north", "e2e-south", "e2e-west"]);
    } finally {
      plan.maxRegions = 3;
    }
  });

  it("lets an operator with a second factor see probe health and drain a region, which the scheduler then skips", async () => {
    const { operator, send: opSend, verifiedCookie: opCookie } = await operatorSessions();
    // a customer (not an operator) is refused like everyone else
    const customer = await account();
    expect((await opSend("/api/operator/probes", { headers: { cookie: customer.cookie, origin: ORIGIN } })).status).toBe(403);
    expect((await opSend("/api/operator/probes/e2e-west/audit", { headers: { cookie: customer.cookie, origin: ORIGIN } })).status).toBe(403);
    const requestsBeforeDeniedValidation = validationRequests.length;
    expect((await opSend("/api/operator/probes/e2e-west/validate", { method: "POST", headers: { cookie: customer.cookie, origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect(validationRequests).toHaveLength(requestsBeforeDeniedValidation);
    const authHeaders: Record<string, string>[] = [{ authorization: "Bearer synthetic-only" }, { "x-api-key": "synthetic-only" }];
    for (const authHeader of authHeaders) {
      const denied = await opSend("/api/operator/probes/e2e-west/validate", {
        method: "POST", headers: { cookie: opCookie, origin: ORIGIN, "content-type": "application/json", ...authHeader }, body: "{}",
      });
      expect(denied.status).toBe(403);
      expect(validationRequests).toHaveLength(requestsBeforeDeniedValidation);
    }
    const op = async (method: string, path: string, body?: unknown) => {
      const r = await opSend(`/api/operator${path}`, { method, headers: { cookie: opCookie, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    const validationIdsBefore = new Set<number>((await op("GET", "/probes/e2e-west/audit")).body.validationEvents.map((event: { id: number }) => event.id));

    const listed = await op("GET", "/probes");
    expect(listed.status).toBe(200);
    expect(listed.body.regions.find((r: { id: string }) => r.id === "e2e-north").credentialMode).toBe("dedicated");
    expect(listed.body.regions.find((r: { id: string }) => r.id === "e2e-south").credentialMode).toBe("shared");
    expect(JSON.stringify(listed.body)).not.toContain("probe-regions-e2e-north-dedicated-secret");
    expect(JSON.stringify(listed.body)).not.toContain("probe-regions-e2e-secret");
    const dedicated = await op("POST", "/probes/e2e-north/validate", {});
    expect(dedicated.body).toMatchObject({ id: "e2e-north", validated: true, credentialProof: "matched", sourceAttestation: false });
    proofAnswers["e2e-north"] = { signingSecret: baseEnv.PROBE_SECRET };
    expect((await op("POST", "/probes/e2e-north/validate", {})).body).toMatchObject({ id: "e2e-north", validated: false, code: "probe_credential_mismatch" });
    delete proofAnswers["e2e-north"];
    proofAnswers["e2e-west"] = { capabilities: ["http-request-body-v1", "unknown-capability", "http-request-body-v1"] };
    const validated = await op("POST", "/probes/e2e-west/validate", {});
    expect(validated.status).toBe(200);
    expect(validated.body).toEqual({ id: "e2e-west", validated: true, identity: "reported_match", credentialProof: "matched", sourceAttestation: false, capabilities: ["http-request-body-v1"] });
    expect(JSON.stringify(validated.body)).not.toContain("https://probe.test");
    expect(JSON.stringify(validated.body)).not.toContain("probe-regions-e2e-west");
    expect(validationRequests.at(-1)).toMatchObject({ id: "e2e-west", body: { type: PROBE_VALIDATION_TYPE } });
    expect(Object.keys(validationRequests.at(-1)!.body).sort()).toEqual(["challenge", "type"]);
    expect(String(validationRequests.at(-1)!.body.challenge)).toMatch(/^[0-9a-f]{64}$/);
    const requestsBeforeInvalidBody = validationRequests.length;
    expect((await op("POST", "/probes/e2e-west/validate", { target: "http://127.0.0.1/" })).status).toBe(400);
    expect(validationRequests).toHaveLength(requestsBeforeInvalidBody);
    proofAnswers["e2e-west"] = { region: "e2e-north" };
    expect((await op("POST", "/probes/e2e-west/validate", {})).body).toMatchObject({ id: "e2e-west", validated: false, code: "probe_identity_mismatch" });
    proofAnswers["e2e-west"] = { signingSecret: "not-the-configured-key" };
    expect((await op("POST", "/probes/e2e-west/validate", {})).body).toMatchObject({ id: "e2e-west", validated: false, code: "probe_credential_mismatch" });
    proofAnswers["e2e-west"] = { challenge: "0".repeat(64) };
    expect((await op("POST", "/probes/e2e-west/validate", {})).body).toMatchObject({ id: "e2e-west", validated: false, code: "probe_credential_mismatch" });
    proofAnswers["e2e-west"] = new Error("synthetic malformed endpoint");
    expect((await op("POST", "/probes/e2e-west/validate", {})).body).toMatchObject({ id: "e2e-west", validated: false, code: "probe_validation_unavailable" });
    proofAnswers["e2e-west"] = new Error("synthetic unreachable probe");
    expect((await op("POST", "/probes/e2e-west/validate", {})).body).toMatchObject({ id: "e2e-west", validated: false, code: "probe_validation_unavailable" });
    const validationAudit = await op("GET", "/probes/e2e-west/audit?limit=20");
    const recorded = validationAudit.body.validationEvents.filter((event: { id: number }) => !validationIdsBefore.has(event.id));
    expect(recorded.map((event: { outcome: string }) => event.outcome)).toEqual([
      "unavailable", "unavailable", "credential_mismatch", "credential_mismatch", "identity_mismatch", "validated",
    ]);
    expect(JSON.stringify(recorded)).not.toMatch(/probe\.test|probe-regions-e2e-(?:secret|north-dedicated-secret)|challenge|signature|capabilities/i);
    await expect(db!.query(`UPDATE probe_region_validation_event SET outcome='validated' WHERE id=$1`, [recorded[0].id])).rejects.toThrow();
    await expect(db!.query(`DELETE FROM probe_region_validation_event WHERE id=$1`, [recorded[0].id])).rejects.toThrow();
    expect((await opSend("/api/operator/probes/e2e-west/audit", { headers: { cookie: customer.cookie, origin: ORIGIN } })).status).toBe(403);
    const idsBeforeFailedAudit = new Set<number>(validationAudit.body.validationEvents.map((event: { id: number }) => event.id));
    await db!.query(`CREATE FUNCTION public.test_fail_probe_validation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit write failure'; END $$`);
    await db!.query(`CREATE TRIGGER test_fail_probe_validation_audit BEFORE INSERT ON public.probe_region_validation_event FOR EACH ROW EXECUTE FUNCTION public.test_fail_probe_validation_audit()`);
    try {
      proofAnswers["e2e-west"] = {};
      const unrecorded = await op("POST", "/probes/e2e-west/validate", {});
      expect(unrecorded.status).toBe(503);
      expect(unrecorded.body).toEqual({ error: "Probe validation result could not be recorded" });
      const afterFailedAudit = await op("GET", "/probes/e2e-west/audit?limit=20");
      expect(afterFailedAudit.body.validationEvents.every((event: { id: number }) => idsBeforeFailedAudit.has(event.id))).toBe(true);
    } finally {
      await db!.query("DROP TRIGGER test_fail_probe_validation_audit ON public.probe_region_validation_event");
      await db!.query("DROP FUNCTION public.test_fail_probe_validation_audit()");
    }
    delete proofAnswers["e2e-west"];
    const ids = listed.body.regions.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining(Object.keys(PROBES)));
    expect(listed.body.regions.find((r: { id: string }) => r.id === "e2e-west")).toMatchObject({ configured: true, drained: false });

    expect((await op("GET", "/probes/auto/audit")).status).toBe(404);
    expect((await op("GET", "/probes/e2e-west/audit?limit=101")).status).toBe(400);
    expect((await op("POST", "/probes/auto/drain", {})).status).toBe(404);
    expect((await op("POST", "/probes/nowhere-else/drain", {})).status).toBe(404);
    expect((await op("POST", "/probes/e2e-west/drain", { note: "x".repeat(201) })).status).toBe(400);
    expect((await op("POST", "/probes/e2e-west/drain", { note: "Synthetic maintenance window" })).body).toEqual({ id: "e2e-west", drained: true });
    const drained = (await op("GET", "/probes")).body.regions.find((r: { id: string }) => r.id === "e2e-west");
    expect(drained).toMatchObject({ status: "drained", drained: true, drainNote: "Synthetic maintenance window", drainedBy: operator.userId });
    const afterDrain = await op("GET", "/probes/e2e-west/audit?limit=1");
    expect(afterDrain.status).toBe(200);
    expect(afterDrain.body.region).toBe("e2e-west");
    expect(afterDrain.body.events).toHaveLength(1);
    expect(afterDrain.body.events[0]).toMatchObject({ region: "e2e-west", action: "drain", operatorId: operator.userId, note: "Synthetic maintenance window", createdAt: expect.any(String) });

    // the scheduler no longer asks the drained region
    const { call } = await account();
    const m = await monitor(call, ["e2e-north", "e2e-west"]);
    reset();
    answers["e2e-north"] = { ok: true, statusCode: 200 };
    answers["e2e-west"] = { ok: true, statusCode: 200 };
    await call("POST", `/monitors/${m.id}/check`);
    expect(asked).toEqual(["e2e-north"]);
    // nor does a spot check from it, which takes no credit
    const [{ organization_id: workspace }] = await db!.query<{ organization_id: string }>(`SELECT organization_id FROM monitor WHERE id = $1::uuid`, [m.id]);
    const before = spent[workspace] ?? 0;
    const spot = await call("POST", `/monitors/${m.id}/check`, { region: "e2e-west" });
    expect(spot.status).toBe(502);
    expect(spot.body).toMatchObject({ code: "probe_unreachable", region: "e2e-west", error: "Region is drained by the operator" });
    expect(spent[workspace] ?? 0).toBe(before);

    expect((await op("POST", "/probes/e2e-west/undrain")).body).toEqual({ id: "e2e-west", drained: false });
    const undrained = (await op("GET", "/probes")).body.regions.find((r: { id: string }) => r.id === "e2e-west");
    expect(undrained).toMatchObject({ drained: false, drainedBy: null, lastUndrainedBy: operator.userId, lastUndrainedAt: expect.any(String) });
    const history = await op("GET", "/probes/e2e-west/audit");
    expect(history.status).toBe(200);
    expect(history.body.events.slice(0, 2).map((e: { action: string }) => e.action)).toEqual(["undrain", "drain"]);
    expect(history.body.events[0]).toMatchObject({ operatorId: operator.userId, note: null });
    expect((await op("GET", "/probes/e2e-west/audit?limit=1")).body.events).toHaveLength(1);
    reset();
    answers["e2e-north"] = { ok: true, statusCode: 200 };
    answers["e2e-west"] = { ok: true, statusCode: 200 };
    await call("POST", `/monitors/${m.id}/check`);
    expect(asked.sort()).toEqual(["e2e-north", "e2e-west"]);
  });

  it("requires recent credential proof to reactivate a probe and commits lifecycle audit with concurrent-safe state changes", async () => {
    const { operator, send, verifiedCookie } = await operatorSessions();
    const op = async (method: string, path: string, body?: unknown) => {
      const r = await send(`/api/operator${path}`, { method, headers: { cookie: verifiedCookie, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let responseBody: unknown = null;
      try { responseBody = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, body: responseBody as any, text };
    };
    const region = "e2e-central";
    const repo = db!.repo;
    await db!.query("UPDATE probe_region_state SET enabled=true WHERE region=$1", [region]);
    // A failed proof after an earlier successful one must prevent activation.
    await repo.recordProbeRegionValidation!(region, "unavailable", operator.userId, null);
    const [baseline] = await db!.query<{ id: number }>("SELECT coalesce(max(id),0)::int AS id FROM probe_region_lifecycle_event WHERE region=$1", [region]);
    const deniedCustomer = await account();
    const denied = await send(`/api/operator/probes/${region}/deactivate`, { method: "POST", headers: { cookie: deniedCustomer.cookie, origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(403);

    const deactivated = await op("POST", `/probes/${region}/deactivate`, {});
    expect(deactivated).toMatchObject({ status: 200, body: { id: region, enabled: false, changed: true } });
    expect((await op("POST", `/probes/${region}/activate`, {})).body).toMatchObject({ code: "probe_activation_requires_recent_validation" });
    // Historical successful rows have no configuration binding and must not authorize reactivation.
    await repo.recordProbeRegionValidation!(region, "validated", operator.userId, null);
    expect((await op("POST", `/probes/${region}/activate`, {})).body).toMatchObject({ code: "probe_activation_requires_recent_validation" });
    expect((await db!.query<{ enabled: boolean }>("SELECT enabled FROM probe_region_state WHERE region=$1", [region]))[0].enabled).toBe(false);

    const { call } = await account();
    const m = await monitor(call, [region]);
    reset();
    const workspace = (await db!.query<{ organization_id: string }>("SELECT organization_id FROM monitor WHERE id=$1::uuid", [m.id]))[0].organization_id;
    const creditsBeforeSpotCheck = spent[workspace] ?? 0;
    const refusedSpotCheck = await call("POST", `/monitors/${m.id}/check`, { region });
    expect(refusedSpotCheck.status).toBe(502);
    expect(refusedSpotCheck.body).toMatchObject({ code: "probe_unreachable", region, error: "Region is deactivated by the operator" });
    expect(asked).toEqual([]);
    expect(spent[workspace] ?? 0).toBe(creditsBeforeSpotCheck);

    try {
      proofAnswers[region] = {};
      expect((await op("POST", `/probes/${region}/validate`, {})).body).toMatchObject({ validated: true, credentialProof: "matched", sourceAttestation: false });
      const configFingerprint = await probeConfigurationFingerprint(region, baseEnv.BETTER_AUTH_SECRET);
      expect(configFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(await repo.setProbeRegionEnabled!(region, true, operator.userId, "0".repeat(64)))
        .toMatchObject({ changed: false, enabled: false, validationRequired: true });
      expect(await op("POST", `/probes/${region}/activate`, {})).toMatchObject({ status: 200, body: { id: region, enabled: true, changed: true } });

      const concurrent = await Promise.all([
        repo.setProbeRegionEnabled!(region, false, operator.userId, null),
        repo.setProbeRegionEnabled!(region, false, operator.userId, null),
      ]);
      expect(concurrent.filter((r) => r.changed)).toHaveLength(1);
      expect(concurrent.every((r) => !r.enabled)).toBe(true);
      expect((await db!.query<{ enabled: boolean }>("SELECT enabled FROM probe_region_state WHERE region=$1", [region]))[0].enabled).toBe(false);

      const audit = await op("GET", `/probes/${region}/audit?limit=10`);
      const lifecycle = audit.body.lifecycleEvents.filter((event: { id: number }) => event.id > baseline.id);
      expect(lifecycle.map((event: { action: string }) => event.action)).toEqual(["deactivate", "activate", "deactivate"]);
      expect(lifecycle.map((event: { operatorId: string }) => event.operatorId)).toEqual([operator.userId, operator.userId, operator.userId]);
      expect(audit.text).not.toMatch(/probe-regions-e2e-(?:secret|north-dedicated-secret)|probe\.test|challenge|signature/i);
      expect(audit.text).not.toContain(configFingerprint!);
      await expect(db!.query("UPDATE probe_region_lifecycle_event SET action='activate' WHERE id=$1", [lifecycle[0].id])).rejects.toThrow();
      await expect(db!.query("DELETE FROM probe_region_lifecycle_event WHERE id=$1", [lifecycle[0].id])).rejects.toThrow();
      await expect(db!.query("TRUNCATE probe_region_lifecycle_event")).rejects.toThrow();
    } finally {
      delete proofAnswers[region];
      await repo.recordProbeRegionValidation!(region, "validated", operator.userId, await probeConfigurationFingerprint(region, baseEnv.BETTER_AUTH_SECRET));
      await repo.setProbeRegionEnabled!(region, true, operator.userId, await probeConfigurationFingerprint(region, baseEnv.BETTER_AUTH_SECRET));
      resetProbeRegionCache();
    }
  });

  it("refuses drain and undrain to everyone but a verified operator, and refuses malformed bodies, without changing state", async () => {
    const { operator, send, signUpCookie, unverifiedCookie, verifiedCookie } = await operatorSessions();
    const customer = await account();
    const repo = db!.repo;
    // known starting state: e2e-east undrained, e2e-central drained by a synthetic operator id with a note
    await repo.setProbeRegionDrain!("e2e-east", { drained: false, by: null, note: null });
    await repo.setProbeRegionDrain!("e2e-central", { drained: true, by: "synthetic-operator-id", note: "Synthetic seeded drain" });
    type Row = { region: string; drained: boolean; drained_at: Date | null; drained_by: string | null; drain_note: string | null; updated_at: Date };
    const snapshot = () => db!.query<Row>(
      `SELECT region, drained, drained_at, drained_by, drain_note, updated_at FROM probe_region_state WHERE region IN ('e2e-east', 'e2e-central') ORDER BY region`,
    );
    const seeded = await snapshot();
    expect(seeded.map((r) => [r.region, r.drained, r.drained_by, r.drain_note])).toEqual([
      ["e2e-central", true, "synthetic-operator-id", "Synthetic seeded drain"],
      ["e2e-east", false, null, null],
    ]);
    const unchanged = async () => expect(await snapshot()).toEqual(seeded);
    const post = (path: string, cookie: string | null, body: string | undefined = "{}", extra: Record<string, string> = {}) =>
      send(`/api/operator${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, body });
    const routes = ["/probes/e2e-east/drain", "/probes/e2e-central/undrain", "/probes/e2e-west/validate"];

    for (const path of routes) {
      // (1) a signed-in customer who is not an operator
      const notOperator = await post(path, customer.cookie, JSON.stringify({ note: "Synthetic note" }));
      expect(notOperator.status).toBe(403);
      expect(await notOperator.json()).toEqual({ error: "Forbidden" });
      await unchanged();
      // (2) a listed operator whose session did not pass a second factor: the enrolling session and the sign-up session
      for (const cookie of [unverifiedCookie, signUpCookie]) {
        const unverified = await post(path, cookie, JSON.stringify({ note: "Synthetic note" }));
        expect(unverified.status).toBe(403);
        expect(await unverified.json()).toEqual({ error: "Forbidden" });
        await unchanged();
      }
      // (3) no session at all: the operator gate answers 403 to everyone it does not admit
      const anonymous = await post(path, null, JSON.stringify({ note: "Synthetic note" }));
      expect(anonymous.status).toBe(403);
      await unchanged();
      // a verified operator session sent from another origin, or next to an API key header, is refused as well
      expect((await post(path, verifiedCookie, "{}", { origin: "https://elsewhere.example" })).status).toBe(403);
      expect((await post(path, verifiedCookie, "{}", { "x-api-key": "synthetic-key" })).status).toBe(403);
      await unchanged();

      // a verified operator with a malformed body: refused, nothing changes
      for (const bad of ["{not json", "[]", "\"just a string\"", "42", "null"]) {
        const r = await post(path, verifiedCookie, bad);
        expect(r.status, `${path} ${bad}`).toBe(400);
        await unchanged();
      }
      // an oversized body: refused before it is read, nothing changes
      const huge = await post(path, verifiedCookie, JSON.stringify({ note: "x".repeat(4096) }));
      expect(huge.status).toBe(413);
      await unchanged();
    }
    // an over-long note on drain (201 characters, within the body limit): 400, nothing changes
    const longNote = await post("/probes/e2e-east/drain", verifiedCookie, JSON.stringify({ note: "x".repeat(201) }));
    expect(longNote.status).toBe(400);
    expect((await post("/probes/e2e-east/drain", verifiedCookie, JSON.stringify({ note: 42 }))).status).toBe(400);
    await unchanged();

    // and the same verified session can change state with a valid request, so the refusals above were not accidental
    expect(await (await post("/probes/e2e-east/drain", verifiedCookie, JSON.stringify({ note: "Synthetic valid drain" }))).json()).toEqual({ id: "e2e-east", drained: true });
    expect(await (await post("/probes/e2e-central/undrain", verifiedCookie, undefined)).json()).toEqual({ id: "e2e-central", drained: false });
    const after = Object.fromEntries((await snapshot()).map((r) => [r.region, r]));
    expect(after["e2e-east"]).toMatchObject({ drained: true, drained_by: operator.userId, drain_note: "Synthetic valid drain" });
    expect(after["e2e-central"]).toMatchObject({ drained: false, drained_by: null, drain_note: null, drained_at: null });
    await repo.setProbeRegionDrain!("e2e-east", { drained: false, by: null, note: null });
    resetProbeRegionCache();
  });

  it("persists operator-managed probe metadata with MFA, configuration fences, atomic audit and no execution path", async () => {
    const { operator, send, unverifiedCookie, verifiedCookie } = await operatorSessions();
    const region = `managed-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const endpointUrl = `https://probe.test/api/probe/${region}`;
    const body = { region, displayName: "Synthetic managed probe", endpointUrl };
    const sendJson = (path: string, cookie: string | undefined, method: string, value?: unknown) => send(path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), origin: ORIGIN, "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const op = (path: string, method: string, value?: unknown) => sendJson(`/api/operator${path}`, verifiedCookie, method, value);

    expect((await sendJson("/api/operator/managed-probes", undefined, "GET")).status).toBe(403);
    expect((await sendJson("/api/operator/managed-probes", unverifiedCookie, "GET")).status).toBe(403);
    expect((await sendJson("/api/operator/managed-probes", unverifiedCookie, "POST", body)).status).toBe(403);
    expect((await sendJson(`/api/operator/managed-probes/${region}/credentials`, undefined, "POST", {})).status).toBe(403);
    expect((await op("/managed-probes", "POST", { ...body, region: "e2e-west", endpointUrl: PROBES["e2e-west"] })).status).toBe(409);
    const unkeyedRegion = `bare-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const unkeyedEnv = {
      ...baseEnv, MONTRAL_OPERATOR_USER_IDS: operator.userId, PROBE_REGIONS: JSON.stringify({ ...PROBES, [unkeyedRegion]: `https://probe.test/api/probe/${unkeyedRegion}` }),
      PROBE_SECRET: "", PROBE_SECRETS: "{}",
    };
    const unkeyedConflict = await app.fetch(new Request(`${ORIGIN}/api/operator/managed-probes`, {
      method: "POST", headers: { cookie: verifiedCookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ region: unkeyedRegion, displayName: "Missing-key configured probe", endpointUrl: `https://probe.test/api/probe/${unkeyedRegion}` }),
    }), unkeyedEnv as never);
    expect(unkeyedConflict.status).toBe(409);
    configureProbes(baseEnv);
    expect((await op("/managed-probes", "POST", { ...body, region: `other-${region}`, endpointUrl: "http://probe.test/api/probe/x" })).status).toBe(400);

    const attempts = await Promise.all([op("/managed-probes", "POST", body), op("/managed-probes", "POST", body)]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await op(`/managed-probes/${region}/credentials`, "POST", {})).status).toBe(503);
    expect((await op(`/managed-probes/${region}/enroll`, "POST", {})).status).toBe(503);
    const duplicateEndpoint = await db!.repo.createManagedProbeRegistration!({
      region: `copy-${region}`, displayName: "Synthetic duplicate endpoint", endpointUrl, createdBy: operator.userId,
    });
    expect(duplicateEndpoint).toEqual({ created: false, conflict: "endpoint" });
    expect((await op("/managed-probes", "POST", { ...body, region: `copy-${region}` })).status).toBe(400);

    expect((await op("/managed-probes?limit=0", "GET")).status).toBe(400);
    expect((await op("/managed-probes?after=auto", "GET")).status).toBe(400);
    const pagedRegions: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = `?limit=1${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
      const listing = await op(`/managed-probes${query}`, "GET");
      expect(listing.status).toBe(200);
      const page = (await listing.json()) as { registrations: Array<Record<string, unknown>>; nextCursor: string | null };
      pagedRegions.push(...page.registrations.map((item) => String(item.region)));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(pagedRegions).toContain(region);
    const registrations = (await (await op("/managed-probes?limit=100", "GET")).json()) as { registrations: Array<Record<string, unknown>> };
    expect(registrations.registrations.find((item) => item.region === region)).toMatchObject({
      region, displayName: "Synthetic managed probe", endpointUrl, state: "registered", createdBy: operator.userId, executionEnabled: false,
    });
    expect(availableRegions().some((configured) => configured.id === region)).toBe(false);

    const key = crypto.getRandomValues(new Uint8Array(32));
    const preparationOutcome = await generateAndPrepareManagedProbeCredential(db!.repo, region, operator.userId, {
      getActiveKey: async () => ({ version: 9, key }), getKey: async (version) => version === 9 ? key : null,
    });
    key.fill(0);
    expect(preparationOutcome).toBe("prepared");
    const preparedEvent = (await db!.repo.managedProbeCredentialEvents!(region, 1))[0]!;
    const credentialVersionId = preparedEvent.versionId;
    const storedEnvelope = await db!.repo.preparedManagedProbeCredentialEnvelope!(region, credentialVersionId);
    expect(storedEnvelope).not.toBeNull();
    const encodedNonce = Buffer.from(storedEnvelope!.nonce).toString("base64");
    const encodedCiphertext = Buffer.from(storedEnvelope!.ciphertext).toString("base64");
    const grant = await createManagedProbeEnrollmentGrant(db!.repo, {
      region, versionId: credentialVersionId, endpointUrl, operatorId: operator.userId,
      keyId: "synthetic-e2e", signingKey: enrollmentSigningKey,
    });
    expect(await consumeManagedProbeEnrollmentGrant(db!.repo, { token: grant.token, nonce: grant.nonce, region, versionId: credentialVersionId, endpointUrl })).toBe(true);
    expect((await op(`/managed-probes/${region}/credential-audit?limit=0`, "GET")).status).toBe(400);
    const credentialAuditResponse = await op(`/managed-probes/${region}/credential-audit`, "GET");
    expect(credentialAuditResponse.status).toBe(200);
    const credentialAudit = await credentialAuditResponse.text();
    expect(credentialAudit).toContain("credential.prepare");
    expect(credentialAudit).toContain("enrollment.issue");
    expect(credentialAudit).toContain("enrollment.consume");
    expect(credentialAudit).not.toContain(grant.token);
    expect(credentialAudit).not.toContain(grant.nonce);
    expect(credentialAudit).not.toContain("ciphertext");
    expect(credentialAudit).not.toContain(encodedNonce);
    expect(credentialAudit).not.toContain(encodedCiphertext);
    expect(credentialAudit).not.toContain("grantId");
    expect((await sendJson(`/api/operator/managed-probes/${region}/credential-audit`, undefined, "GET")).status).toBe(403);
    expect((await sendJson(`/api/operator/managed-probes/${region}/credential-audit`, unverifiedCookie, "GET")).status).toBe(403);

    const suspended = await Promise.all([op(`/managed-probes/${region}/suspend`, "POST", {}), op(`/managed-probes/${region}/suspend`, "POST", {})]);
    expect(suspended.map((response) => response.status)).toEqual([200, 200]);
    expect((await op(`/managed-probes/${region}/restore`, "POST", {})).status).toBe(200);
    expect((await op(`/managed-probes/${region}/revoke`, "POST", {})).status).toBe(200);
    expect((await op(`/managed-probes/${region}/restore`, "POST", {})).status).toBe(409);

    const historyResponse = await op(`/managed-probes/${region}/audit`, "GET");
    const history = (await historyResponse.json()) as { events: Array<Record<string, unknown>> };
    expect(history.events.map((event) => event.action)).toEqual(["revoke", "restore", "suspend", "register"]);
    expect(history.events.every((event) => !("endpointUrl" in event) && !("secret" in event))).toBe(true);
    await expect(db!.query(`DELETE FROM managed_probe_registration_event WHERE region = $1`, [region])).rejects.toThrow(/append-only/);
    await expect(db!.query(`UPDATE managed_probe_registration_event SET action = 'register' WHERE region = $1`, [region])).rejects.toThrow(/append-only/);
    await expect(db!.query(`TRUNCATE managed_probe_registration_event`)).rejects.toThrow(/append-only/);

    const failedRegion = `fail-${region}`;
    await db!.query(`DROP TRIGGER IF EXISTS test_fail_managed_probe_registration_audit ON public.managed_probe_registration_event`);
    await db!.query(`DROP FUNCTION IF EXISTS public.test_fail_managed_probe_registration_audit()`);
    await db!.query(`CREATE OR REPLACE FUNCTION public.test_fail_managed_probe_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
    await db!.query(`CREATE TRIGGER test_fail_managed_probe_registration_audit BEFORE INSERT ON public.managed_probe_registration_event FOR EACH ROW EXECUTE FUNCTION public.test_fail_managed_probe_registration_audit()`);
    try {
      const failed = await op("/managed-probes", "POST", {
        region: failedRegion, displayName: "Synthetic rollback probe", endpointUrl: `https://probe.test/api/probe/${failedRegion}`,
      });
      expect(failed.status).toBe(503);
      const persisted = await db!.query<{ count: string }>(`SELECT count(*)::text AS count FROM managed_probe_registration WHERE region = $1`, [failedRegion]);
      expect(persisted[0]?.count).toBe("0");
    } finally {
      await db!.query(`DROP TRIGGER test_fail_managed_probe_registration_audit ON public.managed_probe_registration_event`);
      await db!.query(`DROP FUNCTION public.test_fail_managed_probe_registration_audit()`);
    }
  });
});
