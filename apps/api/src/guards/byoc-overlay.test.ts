import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, read } from "./helpers";

/**
 * docker-compose.byoc.yml and docs/BYOC.md promise BYOC customers specific behaviour: keep them honest. Every variable
 * the overlay sets must be one docker-compose.yml already passes (env-docs.test.ts ties that set to the code), its
 * outbound-connection defaults must stay off, and every `path:line` the trust-boundary document cites must still exist.
 */

const overlay = read("docker-compose.byoc.yml");

function appEnvironment(yml: string): Map<string, string> {
  const block = yml.match(/^ {2}montral:\n(?: {4}.*\n|\s*\n)*? {4}environment:\n((?: {6}.*\n|\s*\n)+)/m);
  if (!block) throw new Error("no environment block for the montral service");
  return new Map([...block[1].matchAll(/^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
}

describe("docker-compose.byoc.yml", () => {
  const env = appEnvironment(overlay);
  const base = appEnvironment(read("docker-compose.yml"));

  it("sets only variables docker-compose.yml passes to the app (and so the code reads)", () => {
    expect(env.size).toBeGreaterThan(0);
    expect([...env.keys()].filter((k) => !base.has(k))).toEqual([]);
  });

  it("switches the reference-URL self-check off by default", () => {
    expect(env.get("SELFCHECK_URLS")).toBe("${SELFCHECK_URLS-}");
  });

  it("pins the operator control plane off", () => {
    expect(env.get("MONTRAL_OPERATOR_USER_IDS")).toBe('""');
  });

  it("requires an external DATABASE_URL and keeps the bundled database behind a profile", () => {
    expect(env.get("DATABASE_URL")).toMatch(/^\$\{DATABASE_URL:\?/);
    expect(overlay).toMatch(/^ {2}postgres:\n {4}profiles: \[bundled-postgres\]$/m);
    expect(overlay).toMatch(/^ {4}depends_on: !reset \{\}$/m);
  });

  it("keeps the container hardening the BYOC qualification asserts", () => {
    expect(overlay).toMatch(/^ {4}read_only: true$/m);
    expect(overlay).toMatch(/^ {4}cap_drop: \[ALL\]$/m);
    expect(overlay).toMatch(/no-new-privileges:true/);
  });

  it("enables none of the features that open outbound connections", () => {
    for (const k of ["SMTP_URL", "SMTP_HOST", "RESEND_API_KEY", "GITHUB_CLIENT_ID", "OIDC_ISSUER", "APNS_KEY", "PROBE_REGIONS", "TURNSTILE_SITE_KEY", "PLAUSIBLE_DOMAIN", "LEMONSQUEEZY_API_KEY", "MONTRAL_BILLING_ENABLED"]) {
      expect(env.has(k), k).toBe(false);
    }
  });
});

describe("docs/BYOC.md citations", () => {
  const doc = read("docs/BYOC.md");
  const refs = [...doc.matchAll(/`((?:apps|packages|scripts)\/[^`:\s]+):(\d+)(?:-(\d+))?`/g)];

  it("cites code", () => {
    expect(refs.length).toBeGreaterThan(20);
  });

  it("cites only files and lines that exist", () => {
    const broken = refs
      .filter(([, file, start, end]) => !existsSync(join(ROOT, file)) || Math.max(Number(start), Number(end ?? 0)) > read(file).split("\n").length)
      .map((r) => r[0]);
    expect(broken).toEqual([]);
  });

  it("names every file it refers to by path", () => {
    const paths = [...doc.matchAll(/`((?:docs|scripts|apps|\.github)\/[^`:\s]+?\.(?:md|sh|mjs|cjs|ts|yml|json))`/g)].map((m) => m[1]);
    expect(paths.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });
});
