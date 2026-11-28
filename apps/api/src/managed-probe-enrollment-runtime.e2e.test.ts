import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createDb, createRepo, migrate } from "@montral/db-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProbeServer } from "../../probe/src/node-server";
import { openManagedProbeCredentialStore, type ManagedProbeCredentialStore } from "../../probe/src/managed-credential-store";
import type { ManagedProbeKekProvider } from "./managed-probe-kek-provider";
import { deliverManagedProbeEnrollment } from "./managed-probe-enrollment-delivery";

// Keep outbound policy evaluation real, while mapping the already-validated public test DNS answer to the local TLS
// receiver. This harness does not skip guardedFetch's hostname, public-address, redirect, or response checks.
const harness = vi.hoisted(() => ({
  dispatch: undefined as undefined | ((url: string, init: RequestInit, addresses: string[]) => Promise<Response>),
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
});
vi.mock("./pinnedfetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pinnedfetch")>();
  return { ...actual, pinnedFetch: (url: string, init: RequestInit, addresses: string[]) => {
    if (!harness.dispatch) throw new Error("TLS receiver harness is not ready");
    return harness.dispatch(url, init, addresses);
  } };
});

const postgresUrl = process.env.TEST_DATABASE_URL;
const db = postgresUrl ? createDb(postgresUrl, { max: 8 }) : undefined;
const repo = db ? createRepo(db) : undefined;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = "synthetic-e2e-key";
const signingKey = privateKey;
const kek = Buffer.alloc(32, 0x6d);

let tempRoot: string | undefined;
let store: ManagedProbeCredentialStore | undefined;
let probe: ReturnType<typeof createProbeServer> | undefined;
let tlsCert: Buffer;
let receiverPort = 0;
let receiverHost = "";
let simulatedLostResponse = false;
const deliveredBodies: Buffer[] = [];

function listen(server: ReturnType<typeof createProbeServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function dispatchToLocalTls(url: string, init: RequestInit, addresses: string[]): Promise<Response> {
  expect(addresses).toEqual(["93.184.216.34"]);
  deliveredBodies.push(Buffer.from(init.body as Uint8Array));
  const target = new URL(url);
  expect(target.hostname).toBe(receiverHost);
  const requestHeaders: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { requestHeaders[key] = value; });
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: "127.0.0.1", port: receiverPort, path: `${target.pathname}${target.search}`,
      method: init.method, headers: requestHeaders,
      ca: tlsCert, servername: receiverHost,
      checkServerIdentity: (_host, cert) => checkServerIdentity(receiverHost, cert),
      signal: init.signal ?? undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        if (simulatedLostResponse) {
          simulatedLostResponse = false;
          reject(new TypeError("synthetic connection reset after receiver committed response"));
          return;
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 502,
          headers: { "content-type": String(res.headers["content-type"] ?? "application/octet-stream") },
        }));
      });
    });
    req.once("error", reject);
    if (init.body instanceof Uint8Array) req.end(init.body);
    else if (typeof init.body === "string") req.end(init.body);
    else req.end();
  });
}

const kekProvider: ManagedProbeKekProvider = {
  async getActiveKey() { return { version: 1, key: Buffer.from(kek) }; },
  async getKey(version) { return version === 1 ? Buffer.from(kek) : null; },
  releaseKey(value) { value.fill(0); },
};

beforeAll(async () => {
  if (db) await migrate(db);
});

afterEach(async () => {
  harness.dispatch = undefined;
  simulatedLostResponse = false;
  if (probe?.listening) await new Promise<void>((resolve) => probe!.close(() => resolve()));
  probe = undefined;
  store?.close();
  store = undefined;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  for (const body of deliveredBodies.splice(0)) body.fill(0);
});

afterAll(async () => {
  if (db) await db.$client.end();
  kek.fill(0);
});

describe.skipIf(process.platform !== "linux" || !postgresUrl)("managed probe API-to-runtime enrollment (HTTPS + PostgreSQL)", () => {
  it("retries an identical payload after a lost TLS response, persists it, and settles verified but inactive", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "montral-managed-probe-e2e-"));
    chmodSync(tempRoot, 0o700);
    const keyPath = join(tempRoot, "probe-key.pem");
    const certPath = join(tempRoot, "probe-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
      "-out", certPath, "-days", "1", "-subj", "/CN=probe.example.test", "-addext", "subjectAltName=DNS:probe.example.test"], { stdio: "ignore" });
    chmodSync(keyPath, 0o600);
    tlsCert = readFileSync(certPath);
    const region = `e2e-${randomUUID().slice(0, 8)}`;
    receiverHost = "probe.example.test";
    const databasePath = join(tempRoot, "credentials.sqlite");
    store = openManagedProbeCredentialStore({ databasePath, region, keyProvider: kekProvider });
    const endpointUrlBase = "";
    const receiverConfig = { region, endpointUrl: endpointUrlBase, apiPublicKeys: new Map([[keyId, publicKey]]), credentialStore: store };
    probe = createProbeServer({
      secret: undefined, region, managedEnrollment: receiverConfig,
      managedEnrollmentTls: { key: readFileSync(keyPath), cert: tlsCert },
    });
    receiverPort = await listen(probe);
    const endpointUrl = `https://${receiverHost}:${receiverPort}/api/probe/${region}`;
    receiverConfig.endpointUrl = endpointUrl;
    harness.dispatch = dispatchToLocalTls;

    const operatorId = "synthetic-managed-probe-e2e";
    expect((await repo!.createManagedProbeRegistration!({ region, displayName: "Synthetic TLS receiver", endpointUrl, createdBy: operatorId })).created).toBe(true);
    const generated = await (await import("./managed-probe-credential-envelope")).generateEncryptedManagedProbeCredential(region, 1, kek);
    try {
      expect(await repo!.prepareManagedProbeCredential!({
        region, versionId: generated.credentialVersionId, formatVersion: 1, algorithm: "A256GCM", keyVersion: 1,
        nonce: generated.envelope.nonce, ciphertext: generated.envelope.ciphertext, operatorId,
      })).toBe("prepared");

      simulatedLostResponse = true;
      const input = {
        repo: repo!, region, versionId: generated.credentialVersionId, operatorId,
        keyId, signingKey, kekProvider,
      };
      expect(await deliverManagedProbeEnrollment(input)).toBe("proof_verified");
      expect(deliveredBodies.length).toBeGreaterThanOrEqual(2);
      expect(deliveredBodies.every((body) => body.equals(deliveredBodies[0]!))).toBe(true);
      expect(await repo!.managedProbeCredentialState!(region, generated.credentialVersionId)).toBe("verified");
      expect(await repo!.managedProbeEnrollmentGrantEvents!(region, 10).then((events) => events.map((event) => event.action))).toContain("consume");
      expect(await repo!.managedProbeEnrollmentGrantEvents!(region, 10).then((events) => events.filter((event) => event.action === "issue"))).toHaveLength(1);

      let persisted: Buffer | undefined;
      expect(await store!.withPreparedCredential(generated.credentialVersionId, (credential) => {
        persisted = Buffer.from(credential);
        return "persisted";
      })).toBe("persisted");
      expect(persisted).toEqual(Buffer.from(generated.credential));
      expect(JSON.stringify(await repo!.managedProbeCredentialEvents!(region, 10))).toContain("verify");
    } finally {
      generated.credential.fill(0);
      generated.envelope.nonce.fill(0);
      generated.envelope.ciphertext.fill(0);
    }
  });
});
