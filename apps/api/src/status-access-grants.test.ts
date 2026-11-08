import { describe, expect, it } from "vitest";
import type { StatusPage } from "@montral/repo";
import { accessCookie, hashPagePassword, hasAccessGrant, newShareToken, sha256Hex, verifyPagePassword } from "./status-access";

const env = { BETTER_AUTH_SECRET: "montral-unit-test-secret-not-for-production", WEB_ORIGIN: "https://status.example.com" } as never;
const page = (over: Partial<StatusPage> = {}) => ({ id: "11111111-2222-4333-8444-555555555555", visibility: "password", accessVersion: 3, ...over }) as StatusPage;
/** A minimal Hono context: only what hasAccessGrant reads. Link grants query the database, which unit tests do not have. */
const ctx = (cookie: string, secret = "montral-unit-test-secret-not-for-production") => ({
  env: { BETTER_AUTH_SECRET: secret },
  req: { header: (name: string) => (name === "cookie" ? cookie : undefined) },
  get: () => ({ query: async () => [] }),
}) as never;
const cookiePair = (setCookie: string) => setCookie.split(";")[0];

describe("status page passwords", () => {
  it("hashes with a fresh salt and verifies only the right password", async () => {
    const a = await hashPagePassword("correct horse battery");
    const b = await hashPagePassword("correct horse battery");
    expect(a).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(a).not.toBe(b);
    expect(await verifyPagePassword("correct horse battery", a)).toBe(true);
    expect(await verifyPagePassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPagePassword("", a)).toBe(false);
  });
  it("never accepts a page without a password, nor a malformed or downgraded hash", async () => {
    expect(await verifyPagePassword("anything", null)).toBe(false);
    expect(await verifyPagePassword("x", "plain$1$AA==$AA==")).toBe(false);
    expect(await verifyPagePassword("x", "pbkdf2-sha256$999999999$AA==$AA==")).toBe(false);
    expect(await verifyPagePassword("x", "pbkdf2-sha256$100000$AA==$!!notbase64")).toBe(false);
  });
});

describe("share tokens", () => {
  it("are 256-bit random hex and stored only as their SHA-256", async () => {
    const { token, hash } = await newShareToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(token));
    expect((await newShareToken()).token).not.toBe(token);
  });
});

describe("access cookies", () => {
  it("are HttpOnly, SameSite=Lax, Secure on https, and bounded to 12 hours", async () => {
    const set = await accessCookie(env, page(), null, new Date(Date.now() + 30 * 24 * 3_600_000));
    expect(set).toMatch(/; HttpOnly; SameSite=Lax; Secure$/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(set)![1]);
    expect(maxAge).toBeGreaterThan(12 * 3600 - 5);
    expect(maxAge).toBeLessThanOrEqual(12 * 3600);
  });
  it("grant access to the same password page and version only", async () => {
    const cookie = cookiePair(await accessCookie(env, page(), null, new Date(Date.now() + 3_600_000)));
    expect(await hasAccessGrant(ctx(cookie), page())).toBe(true);
    // signing everyone out bumps the version
    expect(await hasAccessGrant(ctx(cookie), page({ accessVersion: 4 }))).toBe(false);
    // another page with the same cookie value under its own name
    const other = page({ id: "99999999-2222-4333-8444-555555555555" });
    expect(await hasAccessGrant(ctx(cookie.replace(/^montral_sa_\w+/, "montral_sa_99999999222243338444555555555555")), other)).toBe(false);
    // a password grant does not open a members-only page
    expect(await hasAccessGrant(ctx(cookie), page({ visibility: "members" }))).toBe(false);
  });
  it("rejects tampered, re-signed and expired grants", async () => {
    const cookie = cookiePair(await accessCookie(env, page(), null, new Date(Date.now() + 3_600_000)));
    const [name, value] = cookie.split("=");
    const [payload, sig] = value.split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
    forged.v = 99;
    const forgedPayload = Buffer.from(JSON.stringify(forged)).toString("base64url");
    expect(await hasAccessGrant(ctx(`${name}=${forgedPayload}.${sig}`), page({ accessVersion: 99 }))).toBe(false);
    // a different deployment secret
    expect(await hasAccessGrant(ctx(cookie, "another-deployment-secret-entirely"), page())).toBe(false);
    expect(await hasAccessGrant(ctx(`${name}=${payload}`), page())).toBe(false);
    expect(await hasAccessGrant(ctx(`${name}=garbage.garbage`), page())).toBe(false);
    const expired = cookiePair(await accessCookie(env, page(), null, new Date(Date.now() - 1000)));
    expect(await hasAccessGrant(ctx(expired), page())).toBe(false);
  });
  it("needs the link to still exist for a link grant (unit context has none)", async () => {
    const cookie = cookiePair(await accessCookie(env, page(), "aaaaaaaa-2222-4333-8444-555555555555", new Date(Date.now() + 3_600_000)));
    expect(await hasAccessGrant(ctx(cookie), page())).toBe(false);
  });
});
