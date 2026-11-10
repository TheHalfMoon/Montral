import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

/**
 * A tiny OpenID Connect provider for tests, in process and on 127.0.0.1 only: discovery, a JWKS with rotating keys, an
 * authorization step (called directly, no browser) and a token endpoint that checks the client secret, the redirect
 * URI and the PKCE verifier. Every id_token it issues can be bent (claims, algorithm, key) to exercise the relying
 * party's refusals. Nothing here talks to an external service.
 */

type Key = { kid: string; alg: string; privateKey: CryptoKey; publicJwk: JWK };
export type IdpUser = { sub: string; email?: string; email_verified?: unknown; name?: string };
/** How to bend the id_token of one authorization. */
export type Tweak = {
  /** claims merged over the defaults (undefined values remove a claim) */
  claims?: Record<string, unknown>;
  /** "current": the published signing key; "unpublished": a key not in the JWKS under the current kid (bad signature);
   *  "unknown-kid": a key not in the JWKS under a new kid; "none": alg none; "hs256": HMAC keyed with the public key */
  sign?: "current" | "unpublished" | "unknown-kid" | "none" | "hs256";
  /** return this exact id_token instead of minting one (replay) */
  idToken?: string;
  /** the token endpoint answers with this status and body instead */
  tokenResponse?: { status: number; body: unknown };
  /** what the userinfo endpoint answers for this authorization's access token (default: only `sub`) */
  userinfo?: { status?: number; body?: unknown; raw?: string };
};
type Grant = { clientId: string; redirectUri: string; challenge: string; nonce: string | null; user: IdpUser; tweak: Tweak };

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const read = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => ok(s)); });

async function newKey(alg = "RS256"): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = `k-${randomBytes(6).toString("hex")}`;
  return { kid, alg, privateKey: privateKey as CryptoKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } };
}

export class SyntheticIdp {
  issuer = "";
  readonly clientId = `client-${randomBytes(4).toString("hex")}`;
  readonly clientSecret = `idp-secret-${randomBytes(16).toString("hex")}`;
  /** the first key signs; all are published */
  keys: Key[] = [];
  /** merged over the discovery document */
  discovery: Record<string, unknown> = {};
  /** delay before every answer, and an oversized answer instead of the real one */
  delayMs = 0;
  oversize: "" | "discovery" | "jwks" | "token" = "";
  readonly requests: { method: string; path: string }[] = [];
  /** every id_token issued, newest last */
  readonly issued: string[] = [];
  /** the authorization requests received, parsed */
  readonly authorizations: URLSearchParams[] = [];
  private grants = new Map<string, Grant>();
  /** userinfo answers by access token; set directly in tests or through `Tweak.userinfo` */
  readonly userinfo = new Map<string, Tweak["userinfo"]>();
  /** the Authorization header of the last userinfo request */
  lastUserinfoAuth = "";
  private server!: Server;

  static async start(name: string): Promise<SyntheticIdp> {
    const idp = new SyntheticIdp();
    idp.keys = [await newKey("RS256")];
    idp.server = createServer((req, res) => void idp.handle(req, res));
    await new Promise<void>((ok) => idp.server.listen(0, "127.0.0.1", () => ok()));
    idp.issuer = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}/realms/${name}`;
    return idp;
  }

  close() {
    this.server.closeAllConnections?.();
    return new Promise<void>((ok) => this.server.close(() => ok()));
  }

  /** A new signing key in front; the old ones stay published unless `retireOld`. */
  async rotate({ retireOld = false, alg = "RS256" }: { retireOld?: boolean; alg?: string } = {}) {
    const key = await newKey(alg);
    this.keys = retireOld ? [key] : [key, ...this.keys];
    return key;
  }

  /**
   * What the provider does when the browser arrives with the authorization request: the user `user` signs in and the
   * provider redirects back. Returns the callback URL with code and state (and the parsed request).
   */
  authorize(authorizationUrl: string, user: IdpUser, tweak: Tweak = {}): { callback: string; params: URLSearchParams } {
    const u = new URL(authorizationUrl);
    const p = u.searchParams;
    this.authorizations.push(p);
    if (`${u.origin}${u.pathname}` !== `${this.issuer}/authorize`) throw new Error("authorization request sent to the wrong provider");
    if (p.get("client_id") !== this.clientId) throw new Error("unknown client_id");
    const code = b64url(randomBytes(24));
    this.grants.set(code, { clientId: p.get("client_id")!, redirectUri: p.get("redirect_uri")!, challenge: p.get("code_challenge") ?? "", nonce: p.get("nonce"), user, tweak });
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state") ?? "");
    return { callback: back.toString(), params: p };
  }

  /** An id_token as this provider would issue it, bent by `tweak`. */
  async mint(user: IdpUser, nonce: string | null, tweak: Tweak = {}, audience = this.clientId): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { iss: this.issuer, aud: audience, sub: user.sub, iat: now, exp: now + 300, nonce: nonce ?? undefined, email: user.email, email_verified: user.email_verified, name: user.name, ...tweak.claims };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    const key = this.keys[0];
    const sign = tweak.sign ?? "current";
    if (sign === "none") return `${b64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })))}.${b64url(Buffer.from(JSON.stringify(claims)))}.`;
    if (sign === "hs256") return new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: key.kid }).sign(new TextEncoder().encode(JSON.stringify(key.publicJwk)));
    if (sign === "unpublished" || sign === "unknown-kid") {
      const stray = await newKey(key.alg);
      return new SignJWT(claims).setProtectedHeader({ alg: key.alg, kid: sign === "unpublished" ? key.kid : stray.kid }).sign(stray.privateKey);
    }
    return new SignJWT(claims).setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" }).sign(key.privateKey);
  }

  discoveryDocument() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/jwks`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256", "ES256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      ...this.discovery,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(new URL(this.issuer).pathname, "") || "/";
    this.requests.push({ method: req.method ?? "GET", path });
    const body = req.method === "POST" ? await read(req) : "";
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const json = (status: number, value: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const huge = () => json(200, { padding: "x".repeat(200 * 1024) });
    if (req.method === "GET" && path === "/.well-known/openid-configuration") return this.oversize === "discovery" ? huge() : json(200, this.discoveryDocument());
    if (req.method === "GET" && path === "/jwks") return this.oversize === "jwks" ? huge() : json(200, { keys: this.keys.map((k) => k.publicJwk) });
    if (req.method === "GET" && path === "/userinfo") {
      this.lastUserinfoAuth = req.headers.authorization ?? "";
      const token = /^Bearer (.+)$/.exec(this.lastUserinfoAuth)?.[1] ?? "";
      if (!this.userinfo.has(token)) return json(401, { error: "invalid_token" });
      const answer = this.userinfo.get(token) ?? {};
      if (answer.raw !== undefined) {
        res.writeHead(answer.status ?? 200, { "content-type": "application/jwt" });
        return void res.end(answer.raw);
      }
      return json(answer.status ?? 200, answer.body ?? {});
    }
    if (req.method === "POST" && path === "/token") {
      if (this.oversize === "token") return huge();
      const form = new URLSearchParams(body);
      let clientId = form.get("client_id");
      let secret = form.get("client_secret");
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      if (basic) {
        const [id, pw] = Buffer.from(basic[1], "base64").toString().split(":");
        clientId = decodeURIComponent(id.replace(/\+/g, " "));
        secret = decodeURIComponent((pw ?? "").replace(/\+/g, " "));
      }
      if (clientId !== this.clientId || secret !== this.clientSecret) return json(401, { error: "invalid_client" });
      const code = form.get("code") ?? "";
      const grant = this.grants.get(code);
      this.grants.delete(code); // codes are single use
      if (!grant || form.get("grant_type") !== "authorization_code") return json(400, { error: "invalid_grant" });
      if (form.get("redirect_uri") !== grant.redirectUri) return json(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") ?? "";
      if (!verifier || b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) return json(400, { error: "invalid_grant" });
      if (grant.tweak.tokenResponse) return json(grant.tweak.tokenResponse.status, grant.tweak.tokenResponse.body);
      const idToken = grant.tweak.idToken ?? (await this.mint(grant.user, grant.nonce, grant.tweak));
      this.issued.push(idToken);
      const accessToken = b64url(randomBytes(16));
      this.userinfo.set(accessToken, grant.tweak.userinfo ?? { body: { sub: grant.user.sub } });
      return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    json(404, { error: "not_found" });
  }
}
