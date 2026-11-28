import { chmodSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request as httpsRequest, type Server as HttpsServer } from "node:https";
import type { Server as HttpServer } from "node:http";
import { checkServerIdentity } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS,
  MANAGED_PROBE_ENROLLMENT_PURPOSE,
  signManagedProbeEnrollmentGrant,
  verifyManagedProbeEnrollmentProof,
  type ManagedProbeEnrollmentGrantClaims,
} from "../../api/src/managed-probe-enrollment-grant";
import type { ManagedProbeKekProvider } from "../../api/src/managed-probe-kek-provider";
import { openManagedProbeCredentialStore, type ManagedProbeCredentialStore } from "./managed-credential-store";
import { createProbeServer } from "./node-server";

const REGION = "us-east";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const apiPublicKeys = new Map([["test-api-key-1", publicKey]]);
const syntheticKek = Buffer.alloc(32, 0x51);
let endpointUrl = "";

function provider(): ManagedProbeKekProvider {
  return {
    async getActiveKey() { return { version: 3, key: Buffer.from(syntheticKek) }; },
    async getKey(version) { return version === 3 ? Buffer.from(syntheticKek) : null; },
    releaseKey(value) { value.fill(0); },
  };
}

function makeClaims(overrides: Partial<ManagedProbeEnrollmentGrantClaims> = {}): ManagedProbeEnrollmentGrantClaims {
  const issuedAtMs = Date.now();
  return {
    version: 1,
    keyId: "test-api-key-1",
    grantId: randomUUID(),
    region: REGION,
    endpointUrl,
    purpose: MANAGED_PROBE_ENROLLMENT_PURPOSE,
    credentialVersionId: randomUUID(),
    nonce: randomBytes(32).toString("base64url"),
    issuedAtMs,
    expiresAtMs: issuedAtMs + MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS,
    ...overrides,
  };
}

type ProbeServer = HttpServer | HttpsServer;
const listen = (server: ProbeServer) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", reject);
    resolve((server.address() as AddressInfo).port);
  });
});

describe.runIf(process.platform === "linux")("managed probe enrollment receiver", () => {
  let root: string;
  let databasePath: string;
  let store: ManagedProbeCredentialStore;
  let server: ProbeServer;
  let baseUrl: string;
  let tlsCert: Buffer;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "montral-probe-enrollment-"));
    chmodSync(root, 0o700);
    databasePath = join(root, "credentials.sqlite");
    const keyPath = join(root, "probe-key.pem");
    const certPath = join(root, "probe-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
      "-out", certPath, "-days", "1", "-subj", "/CN=probe.example.test", "-addext", "subjectAltName=DNS:probe.example.test"], { stdio: "ignore" });
    chmodSync(keyPath, 0o600);
    tlsCert = readFileSync(certPath);
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    const receiverConfig = { region: REGION, endpointUrl: "", apiPublicKeys, credentialStore: store };
    server = createProbeServer({
      secret: undefined,
      region: REGION,
      managedEnrollment: receiverConfig,
      managedEnrollmentTls: { key: readFileSync(keyPath), cert: tlsCert },
    });
    const port = await listen(server);
    endpointUrl = `https://probe.example.test:${port}/api/probe/${REGION}`;
    receiverConfig.endpointUrl = endpointUrl;
    baseUrl = `https://probe.example.test:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
    syntheticKek.fill(0x51);
  });

  async function send(path: string, body: string, headers: Record<string, string> = {}) {
    const target = new URL(`${baseUrl}${path}`);
    return new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
      const request = httpsRequest({
        hostname: "127.0.0.1",
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        ca: tlsCert,
        servername: "probe.example.test",
        checkServerIdentity: (_host, cert) => checkServerIdentity("probe.example.test", cert),
        headers: { host: `probe.example.test:${target.port}`, "content-type": "application/json", ...headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const result = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 500, json: async () => JSON.parse(result) as unknown });
        });
      });
      request.once("error", reject);
      request.end(body);
    });
  }

  it("persists before proof and returns the same proof for an exact retry", async () => {
    const claims = makeClaims();
    const grant = signManagedProbeEnrollmentGrant(claims, privateKey);
    const credential = randomBytes(32);
    const requestBody = JSON.stringify({ grant, credential: credential.toString("base64url") });
    const bodyBytes = Buffer.from(requestBody);
    try {
      const first = await send(`/api/probe/${REGION}/enroll`, requestBody);
      expect(first.status).toBe(200);
      const firstResult = await first.json() as { grantId: string; credentialVersionId: string; proof: string };
      expect(firstResult).toMatchObject({ grantId: claims.grantId, credentialVersionId: claims.credentialVersionId });
      expect(verifyManagedProbeEnrollmentProof(claims, bodyBytes, credential, firstResult.proof)).toBe(true);

      const retry = await send(`/api/probe/${REGION}/enroll`, requestBody);
      expect(retry.status).toBe(200);
      const retryResult = await retry.json() as { proof: string };
      expect(retryResult.proof).toBe(firstResult.proof);

      let observed: Buffer | undefined;
      expect(await store.withPreparedCredential(claims.credentialVersionId, value => { observed = Buffer.from(value); return "loaded"; })).toBe("loaded");
      expect(observed).toEqual(credential);
      expect(readFileSync(databasePath).includes(credential)).toBe(false);
      expect(readFileSync(databasePath).includes(syntheticKek)).toBe(false);
    } finally {
      credential.fill(0);
      bodyBytes.fill(0);
    }
  });

  it("rejects forged grants, other-region grants, and endpoint substitution before staging", async () => {
    const credential = randomBytes(32);
    const validClaims = makeClaims();
    const signed = signManagedProbeEnrollmentGrant(validClaims, privateKey);
    const altered = { ...signed, claims: { ...signed.claims, region: "eu-west" } };
    expect((await send(`/api/probe/${REGION}/enroll`, JSON.stringify({ grant: altered, credential: credential.toString("base64url") }))).status).toBe(401);

    const wrongRegion = signManagedProbeEnrollmentGrant(makeClaims({ region: "eu-west", endpointUrl: "https://probe.example.test/api/probe/eu-west" }), privateKey);
    expect((await send(`/api/probe/${REGION}/enroll`, JSON.stringify({ grant: wrongRegion, credential: credential.toString("base64url") }))).status).toBe(401);

    const wrongEndpoint = signManagedProbeEnrollmentGrant(makeClaims({ endpointUrl: "https://other.example.test/api/probe/us-east" }), privateKey);
    expect((await send(`/api/probe/${REGION}/enroll`, JSON.stringify({ grant: wrongEndpoint, credential: credential.toString("base64url") }))).status).toBe(401);
    expect(await store.withPreparedCredential(validClaims.credentialVersionId, () => "must not stage")).toBeNull();
    credential.fill(0);
  });

  it("rejects malformed, oversized, and path-substituted requests", async () => {
    const claims = makeClaims();
    const grant = signManagedProbeEnrollmentGrant(claims, privateKey);
    const credential = randomBytes(32).toString("base64url");
    expect((await send(`/api/probe/${REGION}/enroll`, JSON.stringify({ grant, credential, unexpected: true }))).status).toBe(400);
    expect((await send(`/api/probe/${REGION}/enroll`, JSON.stringify({ grant, credential }), { "content-type": "text/plain" })).status).toBe(415);
    expect((await send(`/api/probe/${REGION}/enroll?redirect=1`, JSON.stringify({ grant, credential }))).status).toBe(404);
    expect((await send(`/api/probe/${REGION}/enroll`, "x".repeat(9 * 1024))).status).toBe(413);
    expect((await send(`/api/probe/${REGION}/different`, JSON.stringify({ grant, credential }))).status).not.toBe(200);
    expect(await store.withPreparedCredential(claims.credentialVersionId, () => "must not stage")).toBeNull();
  });

  it("leaves the receiver inaccessible from default production-style startup", async () => {
    const disabled = createProbeServer({ secret: undefined, region: REGION });
    const port = await listen(disabled);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/probe/${REGION}/enroll`, { method: "POST", body: "{}" });
      expect(response.status).toBe(404);
      expect(() => createProbeServer({
        secret: undefined,
        region: REGION,
        managedEnrollment: { region: REGION, endpointUrl, apiPublicKeys, credentialStore: store },
      })).toThrow("Managed probe enrollment requires a TLS listener");

      const mismatchedStore = openManagedProbeCredentialStore({
        databasePath: join(root, "other-region.sqlite"),
        region: "eu-west",
        keyProvider: provider(),
      });
      try {
        expect(() => createProbeServer({
          secret: undefined,
          region: REGION,
          managedEnrollment: { region: REGION, endpointUrl, apiPublicKeys, credentialStore: mismatchedStore },
          managedEnrollmentTls: { key: "synthetic", cert: "synthetic" },
        })).toThrow("Managed probe enrollment store identity does not match receiver region");
      } finally {
        mismatchedStore.close();
      }
    } finally {
      await new Promise<void>((resolve) => disabled.close(() => resolve()));
    }
  });
});
