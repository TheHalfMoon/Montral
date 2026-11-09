import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SyntheticIdp } from "../test/synthetic-idp";
import { safeReturnTo } from "./sso-auth";
import { authorizationUrl, configureSso, discover, exchangeCode, idpUrl, normalizeIssuer, publicSigningKeys, randomToken, setSsoOptionsForTests, sha256b64url, SsoError, verifyIdToken, type Discovery } from "./sso-oidc";
import { decryptSecret, encryptSecret, SecretUnreadable } from "./sso-secret";
import { instanceConnection } from "./sso-store";

/**
 * The OpenID Connect relying party against a synthetic in-process provider: discovery, SSRF and size/time bounds, the
 * token request with PKCE, and every id_token refusal. No database, no external service.
 */

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof SsoError ? e.code : (e as Error).name;
  }
  return "resolved";
};
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "resolved";
};

let idp: SyntheticIdp;
beforeAll(async () => { idp = await SyntheticIdp.start("unit"); });
afterAll(async () => { await idp.close(); });
afterEach(() => {
  setSsoOptionsForTests(null);
  idp.delayMs = 0;
  idp.oversize = "";
  idp.discovery = {};
});
// the synthetic provider listens on 127.0.0.1 over http: only reachable with the private opt-in
const optIn = (o: Parameters<typeof setSsoOptionsForTests>[0] = {}) => setSsoOptionsForTests({ allowPrivate: true, ...o });

describe("discovery", () => {
  it("reads the provider's endpoints and the algorithms both sides accept", async () => {
    optIn();
    const d = await discover(idp.issuer);
    expect(d).toMatchObject({ issuer: idp.issuer, authorizationEndpoint: `${idp.issuer}/authorize`, tokenEndpoint: `${idp.issuer}/token`, jwksUri: `${idp.issuer}/jwks`, tokenAuth: "client_secret_basic" });
    expect(d.algorithms).toEqual(["RS256", "ES256"]);
  });

  it("refuses a document that names another issuer, lacks PKCE S256 or offers only HMAC or none", async () => {
    optIn();
    idp.discovery = { issuer: "https://evil.example" };
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("discovery_failed");
    idp.discovery = { code_challenge_methods_supported: ["plain"] };
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("discovery_failed");
    idp.discovery = { id_token_signing_alg_values_supported: ["HS256", "none"] };
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("discovery_failed");
    idp.discovery = { response_types_supported: ["id_token"] };
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("discovery_failed");
    idp.discovery = { token_endpoint_auth_methods_supported: ["private_key_jwt"] };
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("discovery_failed");
    idp.discovery = { jwks_uri: "ftp://127.0.0.1/keys" };
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("invalid_issuer");
  });

  it("refuses private, loopback and internal addresses and plain http without the opt-in, before any request", async () => {
    configureSso({});
    const before = idp.requests.length;
    const port = new URL(idp.issuer).port;
    expect(await code(discover(idp.issuer))).toBe("invalid_issuer"); // http
    expect(await code(discover(`https://127.0.0.1:${port}/realms/unit`))).toBe("blocked_target");
    expect(await code(discover("https://localhost/realms/x"))).toBe("blocked_target");
    expect(await code(discover("https://169.254.169.254/latest"))).toBe("blocked_target");
    expect(await code(discover("https://[::1]/x"))).toBe("blocked_target");
    expect(await code(discover("https://idp.internal/x"))).toBe("blocked_target");
    expect(await code(discover("https://10.0.0.8/x"))).toBe("blocked_target");
    expect(idp.requests.length).toBe(before);
    // ALLOW_PRIVATE_TARGETS (monitors) does not open SSO: only SSO_ALLOW_PRIVATE_IDP does
    configureSso({ SSO_ALLOW_PRIVATE_IDP: "true" });
    expect((await discover(idp.issuer, { fresh: true })).issuer).toBe(idp.issuer);
  });

  it("bounds the size of answers", async () => {
    optIn();
    idp.oversize = "discovery";
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("response_too_large");
  });

  it("bounds the time a slow provider can hold a request", async () => {
    optIn({ timeoutMs: 300 });
    idp.delayMs = 3000;
    const started = Date.now();
    expect(await code(discover(idp.issuer, { fresh: true }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("follows no redirects", async () => {
    optIn();
    const { createServer } = await import("node:http");
    const server = createServer((_, res) => { res.writeHead(302, { location: `${idp.issuer}/.well-known/openid-configuration` }); res.end(); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    try {
      const port = (server.address() as { port: number }).port;
      expect(await code(discover(`http://127.0.0.1:${port}/realms/r`, { fresh: true }))).toBe("invalid_response");
    } finally {
      server.close();
    }
  });

  it("validates issuer input", () => {
    optIn();
    expect(() => normalizeIssuer("https://idp.example.com/realms/a?x=1")).toThrow(SsoError);
    expect(() => normalizeIssuer("https://user:pw@idp.example.com")).toThrow(SsoError);
    expect(() => normalizeIssuer("https://idp.example.com/#frag")).toThrow(SsoError);
    expect(() => normalizeIssuer("javascript:alert(1)")).toThrow(SsoError);
    expect(normalizeIssuer("  https://idp.example.com/realms/a  ")).toBe("https://idp.example.com/realms/a");
    configureSso({});
    expect(() => idpUrl("http://idp.example.com", "x")).toThrow(SsoError);
  });
});

describe("authorization request and token exchange", () => {
  it("sends the code flow with PKCE S256, state and nonce, and exchanges the code with the verifier", async () => {
    optIn();
    const d = await discover(idp.issuer, { fresh: true });
    const verifier = randomToken();
    const state = randomToken();
    const nonce = randomToken();
    const url = authorizationUrl(d, { clientId: idp.clientId, redirectUri: "https://montral.test/api/auth/sso/callback", state, nonce, codeChallenge: await sha256b64url(verifier) });
    const { callback, params } = idp.authorize(url, { sub: "u1", email: "u1@corp.test", email_verified: true });
    expect(Object.fromEntries(params)).toMatchObject({ response_type: "code", scope: "openid email profile", state, nonce, code_challenge_method: "S256", redirect_uri: "https://montral.test/api/auth/sso/callback" });
    const back = new URL(callback);
    expect(back.searchParams.get("state")).toBe(state);
    const token = await exchangeCode(d, { clientId: idp.clientId, clientSecret: idp.clientSecret, code: back.searchParams.get("code")!, redirectUri: "https://montral.test/api/auth/sso/callback", codeVerifier: verifier });
    const id = await verifyIdToken(token, { discovery: d, clientId: idp.clientId, nonce });
    expect(id).toEqual({ issuer: idp.issuer, subject: "u1", email: "u1@corp.test", emailVerified: true, name: null });
  });

  it("is refused a code with the wrong verifier, a reused code, a wrong secret; client_secret_post works too", async () => {
    optIn();
    const d = await discover(idp.issuer, { fresh: true });
    const verifier = randomToken();
    const run = async (opts: { verifier?: string; secret?: string; reuse?: boolean; d?: Discovery }) => {
      const { callback } = idp.authorize(authorizationUrl(d, { clientId: idp.clientId, redirectUri: "https://m.test/cb", state: "s", nonce: "n", codeChallenge: await sha256b64url(verifier) }), { sub: "x", email: "x@corp.test", email_verified: true });
      const c = new URL(callback).searchParams.get("code")!;
      const go = () => exchangeCode(opts.d ?? d, { clientId: idp.clientId, clientSecret: opts.secret ?? idp.clientSecret, code: c, redirectUri: "https://m.test/cb", codeVerifier: opts.verifier ?? verifier });
      if (opts.reuse) await go();
      return go().then((t) => t, (e: Error) => e.message);
    };
    expect(await run({ verifier: randomToken() })).toContain("invalid_grant");
    expect(await run({ secret: "wrong" })).toContain("invalid_client");
    expect(await run({ reuse: true })).toContain("invalid_grant");
    expect(await run({ d: { ...d, tokenAuth: "client_secret_post" } })).toMatch(/^eyJ/);
  });

  it("bounds the token response", async () => {
    optIn();
    const d = await discover(idp.issuer, { fresh: true });
    idp.oversize = "token";
    expect(await code(exchangeCode(d, { clientId: idp.clientId, clientSecret: idp.clientSecret, code: "c", redirectUri: "https://m.test/cb", codeVerifier: "v" }))).toBe("response_too_large");
  });
});

describe("id_token validation", () => {
  const nonce = "nonce-under-test";
  const user = { sub: "alice", email: "Alice@Corp.test", email_verified: true, name: "Alice" };
  const verify = async (token: string, n = nonce) => verifyIdToken(token, { discovery: await discover(idp.issuer), clientId: idp.clientId, nonce: n });
  const refused = async (token: string, n = nonce) => reason(verify(token, n));

  it("accepts a correct token and returns the verified identity", async () => {
    optIn();
    expect(await verify(await idp.mint(user, nonce))).toEqual({ issuer: idp.issuer, subject: "alice", email: "alice@corp.test", emailVerified: true, name: "Alice" });
  });

  it("reports email_verified only when the claim is literally true", async () => {
    optIn();
    for (const v of [false, "true", 1, undefined]) {
      expect((await verify(await idp.mint({ ...user, email_verified: v }, nonce))).emailVerified).toBe(false);
    }
  });

  it("refuses wrong iss, aud and azp, expired and future tokens, and old ones", async () => {
    optIn();
    const now = Math.floor(Date.now() / 1000);
    expect(await refused(await idp.mint(user, nonce, { claims: { iss: "https://other.example" } }))).toContain("claim check failed (iss)");
    expect(await refused(await idp.mint(user, nonce, {}, "another-client"))).toContain("claim check failed (aud)");
    expect(await refused(await idp.mint(user, nonce, { claims: { aud: [idp.clientId, "other"] } }))).toContain("azp");
    expect(await refused(await idp.mint(user, nonce, { claims: { aud: [idp.clientId, "other"], azp: "other" } }))).toContain("azp");
    expect(await refused(await idp.mint(user, nonce, { claims: { azp: "other" } }))).toContain("azp");
    expect(await verify(await idp.mint(user, nonce, { claims: { aud: [idp.clientId, "other"], azp: idp.clientId } }))).toMatchObject({ subject: "alice" });
    expect(await refused(await idp.mint(user, nonce, { claims: { exp: now - 120, iat: now - 400 } }))).toContain("expired");
    expect(await refused(await idp.mint(user, nonce, { claims: { iat: now + 600, exp: now + 900 } }))).toMatch(/iat|claim check failed/);
    expect(await refused(await idp.mint(user, nonce, { claims: { nbf: now + 600 } }))).toContain("nbf");
    expect(await refused(await idp.mint(user, nonce, { claims: { iat: now - 3600, exp: now + 300 } }))).toContain("iat");
    expect(await refused(await idp.mint(user, nonce, { claims: { exp: undefined } }))).toContain("exp");
    // within the 60 s skew
    expect(await verify(await idp.mint(user, nonce, { claims: { iat: now + 30 } }))).toMatchObject({ subject: "alice" });
  });

  it("refuses a bad signature, alg none, HMAC keyed with the public key and an unknown key id", async () => {
    optIn();
    expect(await refused(await idp.mint(user, nonce, { sign: "unpublished" }))).toContain("bad signature");
    expect(await refused(await idp.mint(user, nonce, { sign: "none" }))).toContain("algorithm not allowed");
    expect(await refused(await idp.mint(user, nonce, { sign: "hs256" }))).toContain("algorithm not allowed");
    expect(await refused(await idp.mint(user, nonce, { sign: "unknown-kid" }))).toContain("unknown signing key");
    const good = await idp.mint(user, nonce);
    const [h, p] = good.split(".");
    expect(await refused(`${h}.${p}.`)).toMatch(/bad signature|invalid/);
    expect(await refused("not-a-jwt")).toContain("malformed");
  });

  it("refuses a missing or different nonce", async () => {
    optIn();
    expect(await refused(await idp.mint(user, null))).toContain("nonce");
    expect(await refused(await idp.mint(user, "another-sign-in"))).toContain("nonce");
  });

  it("follows key rotation: an unknown kid refetches the JWKS, within the cooldown it does not", async () => {
    optIn({ jwksCooldownMs: 0 });
    await verify(await idp.mint(user, nonce)); // caches the current set
    await idp.rotate({ retireOld: true });
    expect(await verify(await idp.mint(user, nonce))).toMatchObject({ subject: "alice" });
    // with a cooldown, a burst of unknown key ids cannot make the server hammer the provider
    setSsoOptionsForTests({ jwksCooldownMs: 60_000 });
    optIn({ jwksCooldownMs: 60_000 });
    await verify(await idp.mint(user, nonce));
    const fetches = () => idp.requests.filter((r) => r.path === "/jwks").length;
    const before = fetches();
    for (let i = 0; i < 5; i++) expect(await refused(await idp.mint(user, nonce, { sign: "unknown-kid" }))).toContain("unknown signing key");
    expect(fetches() - before).toBeLessThanOrEqual(1);
  });

  it("accepts ES256 keys and bounds the JWKS response", async () => {
    optIn({ jwksCooldownMs: 0 });
    await idp.rotate({ alg: "ES256" });
    expect(await verify(await idp.mint(user, nonce))).toMatchObject({ subject: "alice" });
    idp.oversize = "jwks";
    setSsoOptionsForTests(null);
    optIn();
    expect(await code(verify(await idp.mint(user, nonce)))).toBe("response_too_large");
  });

  it("uses only public signing keys from a JWKS", () => {
    const set = publicSigningKeys({ keys: [
      { kty: "oct", k: "c2VjcmV0", kid: "sym" },
      { kty: "RSA", n: "x", e: "AQAB", d: "private", kid: "leaked-private" },
      { kty: "RSA", n: "x", e: "AQAB", kid: "enc", use: "enc" },
      { kty: "RSA", n: "x", e: "AQAB", kid: "ok", use: "sig" },
      { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "ec" },
      "garbage",
    ] });
    expect(set.keys.map((k) => k.kid)).toEqual(["ok", "ec"]);
  });
});

describe("client secret encryption at rest", () => {
  const server = "a-server-secret-of-sufficient-length";
  it("round-trips, binds the ciphertext to its connection and to the server secret, and fails closed when tampered", async () => {
    const stored = await encryptSecret(server, "conn-1", "the-client-secret");
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain("the-client-secret");
    expect(await encryptSecret(server, "conn-1", "the-client-secret")).not.toBe(stored); // random IV
    expect(await decryptSecret(server, "conn-1", stored)).toBe("the-client-secret");
    await expect(decryptSecret(server, "conn-2", stored)).rejects.toBeInstanceOf(SecretUnreadable);
    await expect(decryptSecret(`${server}-rotated`, "conn-1", stored)).rejects.toBeInstanceOf(SecretUnreadable);
    const [v, iv, ct] = stored.split(".");
    const flipped = ct.slice(0, -2) + (ct.endsWith("A") ? "B" : "A") + ct.slice(-1);
    await expect(decryptSecret(server, "conn-1", `${v}.${iv}.${flipped}`)).rejects.toBeInstanceOf(SecretUnreadable);
    await expect(decryptSecret(server, "conn-1", "garbage")).rejects.toBeInstanceOf(SecretUnreadable);
    await expect(encryptSecret("short", "c", "x")).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe("helpers", () => {
  it("keeps sign-in return paths inside the app", () => {
    expect(safeReturnTo("/app/monitors?x=1")).toBe("/app/monitors?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "app", "", undefined, "/a b", `/${"x".repeat(600)}`]) expect(safeReturnTo(bad)).toBe("/app");
  });

  it("reads the instance-wide provider only when all three variables are set", async () => {
    expect(instanceConnection({ OIDC_ISSUER: "https://idp.example.com", OIDC_CLIENT_ID: "c" })).toBeNull();
    const conn = instanceConnection({ OIDC_ISSUER: " https://idp.example.com ", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", OIDC_ALLOWED_DOMAINS: "Example.com, @corp.test" });
    expect(conn).toMatchObject({ id: "instance", orgId: null, issuer: "https://idp.example.com", clientId: "c", domains: ["example.com", "corp.test"] });
    expect(await conn!.secret()).toBe("s");
    expect(instanceConnection({ OIDC_ISSUER: "https://idp.example.com", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s" })!.domains).toBeNull();
  });
});
