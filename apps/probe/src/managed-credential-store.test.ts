import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openManagedProbeCredentialStore,
  type ManagedProbeCredentialStore,
} from "./managed-credential-store";
import type { ManagedProbeKekProvider } from "../../api/src/managed-probe-kek-provider";

const REGION = "us-east";
const VERSION = "123e4567-e89b-42d3-a456-426614174000";
const SYNTHETIC_CREDENTIAL = Buffer.from("synthetic-probe-credential-00001");
const SYNTHETIC_KEK = Buffer.alloc(32, 0x31);

function provider(key = SYNTHETIC_KEK): ManagedProbeKekProvider {
  return {
    async getActiveKey() { return { version: 7, key: Buffer.from(key) }; },
    async getKey(version) { return version === 7 ? Buffer.from(key) : null; },
    releaseKey(value) { value.fill(0); },
  };
}

describe.runIf(process.platform === "linux")("managed probe credential store", () => {
  let root: string;
  let databasePath: string;
  let store: ManagedProbeCredentialStore | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "montral-probe-store-"));
    chmodSync(root, 0o700);
    databasePath = join(root, "credentials.sqlite");
  });

  afterEach(() => {
    try { store?.close(); } catch { /* test cleanup */ }
    store = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("persists only authenticated ciphertext and reopens the exact prepared version", async () => {
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    expect(await store.stagePreparedCredential({ versionId: VERSION, credential: SYNTHETIC_CREDENTIAL })).toBe("prepared");
    store.close();
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });

    let observed: Buffer | undefined;
    const result = await store.withPreparedCredential(VERSION, credential => {
      observed = Buffer.from(credential);
      return "used synchronously";
    });
    expect(result).toBe("used synchronously");
    expect(observed).toEqual(SYNTHETIC_CREDENTIAL);

    const databaseBytes = readFileSync(databasePath);
    expect(databaseBytes.includes(SYNTHETIC_CREDENTIAL)).toBe(false);
    expect(databaseBytes.includes(SYNTHETIC_KEK)).toBe(false);
    expect(databaseBytes.includes(Buffer.from(REGION))).toBe(true);
  });

  it("binds ciphertext to region, version, and KEK version and zeroes callback bytes", async () => {
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    await store.stagePreparedCredential({ versionId: VERSION, credential: SYNTHETIC_CREDENTIAL });
    let borrowed!: Uint8Array;
    await store.withPreparedCredential(VERSION, value => { borrowed = value; });
    expect(Buffer.from(borrowed).every(byte => byte === 0)).toBe(true);

    store.close();
    expect(() => openManagedProbeCredentialStore({ databasePath, region: "eu-west", keyProvider: provider() })).toThrow(
      "Managed probe credential storage unavailable",
    );
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider(Buffer.alloc(32, 0x44)) });
    await expect(store.withPreparedCredential(VERSION, () => undefined)).rejects.toThrow(
      "Managed probe credential storage unavailable",
    );
  });

  it("makes staging idempotent, enforces one prepared credential, and revokes durably", async () => {
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    expect(await store.stagePreparedCredential({ versionId: VERSION, credential: SYNTHETIC_CREDENTIAL })).toBe("prepared");
    expect(await store.stagePreparedCredential({ versionId: VERSION, credential: SYNTHETIC_CREDENTIAL })).toBe("version_exists");
    expect(await store.stagePreparedCredential({ versionId: randomUUID(), credential: SYNTHETIC_CREDENTIAL })).toBe("credential_exists");
    expect(store.revokePreparedCredential(VERSION)).toBe("revoked");
    expect(store.revokePreparedCredential(VERSION)).toBe("unchanged");
    expect(await store.withPreparedCredential(VERSION, () => "must not run")).toBeNull();
    store.close();
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    expect(await store.withPreparedCredential(VERSION, () => "must not run after reopen")).toBeNull();
  });

  it("serializes concurrent staging through SQLite's immediate transaction", async () => {
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    const other = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    try {
      const [left, right] = await Promise.all([
        store.stagePreparedCredential({ versionId: VERSION, credential: SYNTHETIC_CREDENTIAL }),
        other.stagePreparedCredential({ versionId: randomUUID(), credential: SYNTHETIC_CREDENTIAL }),
      ]);
      expect([left, right].filter(result => result === "prepared")).toHaveLength(1);
      expect([left, right].filter(result => result === "credential_exists")).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it("does not release a credential after revocation wins during asynchronous key lookup", async () => {
    let releaseLookup!: (key: Uint8Array | null) => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>(resolve => { lookupStarted = resolve; });
    const gatedProvider: ManagedProbeKekProvider = {
      async getActiveKey() { return { version: 7, key: Buffer.from(SYNTHETIC_KEK) }; },
      getKey() {
        lookupStarted();
        return new Promise(resolve => { releaseLookup = resolve; });
      },
      releaseKey(value) { value.fill(0); },
    };
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: gatedProvider });
    await store.stagePreparedCredential({ versionId: VERSION, credential: SYNTHETIC_CREDENTIAL });

    let callbackCalled = false;
    const pendingRead = store.withPreparedCredential(VERSION, () => { callbackCalled = true; });
    await started;
    expect(store.revokePreparedCredential(VERSION)).toBe("revoked");
    releaseLookup(Buffer.from(SYNTHETIC_KEK));
    expect(await pendingRead).toBeNull();
    expect(callbackCalled).toBe(false);
  });

  it("recovers a database after a process dies with an uncommitted transaction", async () => {
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    store.close();
    store = undefined;
    const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE crash_probe(value TEXT); INSERT INTO crash_probe VALUES('uncommitted');");
      process.kill(process.pid, "SIGKILL");
    `, databasePath], { encoding: "utf8", timeout: 10_000 });
    expect(crash.signal).toBe("SIGKILL");

    const recovered = new DatabaseSync(databasePath);
    try {
      expect(recovered.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(recovered.prepare("SELECT name FROM sqlite_master WHERE name='crash_probe'").get()).toBeUndefined();
    } finally {
      recovered.close();
    }
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
  });

  it("clears decrypted material even when the callback throws and rejects async callbacks", async () => {
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    await store.stagePreparedCredential({ versionId: VERSION, credential: SYNTHETIC_CREDENTIAL });
    let borrowed!: Uint8Array;
    await expect(store.withPreparedCredential(VERSION, value => {
      borrowed = value;
      throw new Error("synthetic callback failure");
    })).rejects.toThrow("synthetic callback failure");
    expect(Buffer.from(borrowed).every(byte => byte === 0)).toBe(true);
    await expect(store.withPreparedCredential(VERSION, async () => undefined)).rejects.toThrow(
      "Managed probe credential storage unavailable",
    );
  });

  it("fails closed on invalid identities and insecure database paths", async () => {
    store = openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() });
    await expect(store.stagePreparedCredential({ versionId: "not-a-uuid", credential: SYNTHETIC_CREDENTIAL })).rejects.toThrow(
      "Managed probe credential storage unavailable",
    );
    await expect(store.stagePreparedCredential({ versionId: VERSION, credential: Buffer.alloc(31) })).rejects.toThrow(
      "Managed probe credential storage unavailable",
    );
    store.close();
    store = undefined;
    chmodSync(databasePath, 0o644);
    expect(() => openManagedProbeCredentialStore({ databasePath, region: REGION, keyProvider: provider() })).toThrow(
      "Managed probe credential storage unavailable",
    );
  });
});
