import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
} from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname, isAbsolute, resolve } from "node:path";
import { AUTO, REGION_ID } from "../../api/src/regions";
import type { ManagedProbeKekProvider } from "../../api/src/managed-probe-kek-provider";

const STORE_ERROR = "Managed probe credential storage unavailable";
const PURPOSE = "probe-hmac-signing";
const FORMAT_VERSION = 1;
const ALGORITHM = "A256GCM";
const NONCE_BYTES = 12;
const CREDENTIAL_BYTES = 32;
const TAG_BYTES = 16;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AAD_PREFIX = "montral:probe-runtime-credential:v1";

type StageOutcome = "prepared" | "credential_exists" | "version_exists";
type RevokeOutcome = "revoked" | "unchanged";
type CredentialCallback<T> = (credential: Uint8Array) => T;

type CredentialRow = {
  version_id: string;
  purpose: string;
  state: string;
  format_version: number;
  algorithm: string;
  key_version: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
};

function unavailable(): Error {
  return new Error(STORE_ERROR);
}

function validRegion(region: string): boolean {
  return typeof region === "string" && region !== AUTO && REGION_ID.test(region);
}

function validVersionId(versionId: string): boolean {
  return typeof versionId === "string" && UUID_V4.test(versionId);
}

function aad(region: string, versionId: string, keyVersion: number): Buffer {
  return Buffer.from(JSON.stringify([AAD_PREFIX, PURPOSE, region, versionId, keyVersion]), "utf8");
}

function assertLinux(): void {
  if (process.platform !== "linux" || typeof process.getuid !== "function") throw unavailable();
}

function assertOwnedDirectory(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) throw unavailable();
}

function assertOwnedDatabase(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) throw unavailable();
}

function createOrValidateDatabaseFile(path: string, uid: number): void {
  if (!existsSync(path)) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      // Another process may have won initial creation. Validate its file before opening it.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  assertOwnedDatabase(path, uid);
}

function createSchema(db: DatabaseSync, region: string): void {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
  if (check?.integrity_check !== "ok") throw unavailable();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        schema_version INTEGER NOT NULL CHECK(schema_version=1),
        region TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS credential_version (
        region TEXT NOT NULL CHECK(length(region) BETWEEN 2 AND 24 AND region NOT GLOB '*[^a-z0-9-]*' AND substr(region,1,1) GLOB '[a-z0-9]' AND region <> 'auto'),
        version_id TEXT NOT NULL CHECK(length(version_id)=36),
        purpose TEXT NOT NULL CHECK(purpose='probe-hmac-signing'),
        state TEXT NOT NULL CHECK(state IN ('prepared','revoked')),
        format_version INTEGER NOT NULL CHECK(format_version=1),
        algorithm TEXT NOT NULL CHECK(algorithm='A256GCM'),
        key_version INTEGER NOT NULL CHECK(key_version BETWEEN 1 AND 2147483647),
        nonce BLOB NOT NULL CHECK(length(nonce)=12),
        ciphertext BLOB NOT NULL CHECK(length(ciphertext)=48),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(region,version_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS managed_probe_one_prepared_per_region
        ON credential_version(region) WHERE state='prepared';
    `);
    db.prepare("INSERT OR IGNORE INTO store_meta(singleton,schema_version,region) VALUES(1,1,?)").run(region);
    const metadata = db.prepare("SELECT schema_version,region FROM store_meta WHERE singleton=1").get() as
      { schema_version?: unknown; region?: unknown } | undefined;
    if (metadata?.schema_version !== 1 || metadata.region !== region) throw unavailable();
    db.exec("COMMIT");
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw unavailable();
  }
}

function safeRun<T>(callback: () => T): T {
  try { return callback(); } catch { throw unavailable(); }
}

function statement(db: DatabaseSync, sql: string): StatementSync {
  return db.prepare(sql);
}

export class ManagedProbeCredentialStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly region: string,
    private readonly keyProvider: ManagedProbeKekProvider,
  ) {}

  /** Non-secret identity binding used to prevent a receiver from staging one region into another region's store. */
  get regionId(): string {
    return this.region;
  }

  static open(input: {
    databasePath: string;
    region: string;
    keyProvider: ManagedProbeKekProvider;
  }): ManagedProbeCredentialStore {
    try {
      assertLinux();
      if (!input || !validRegion(input.region) || !isAbsolute(input.databasePath) || !input.keyProvider) throw unavailable();
      const databasePath = resolve(input.databasePath);
      const directory = dirname(databasePath);
      const uid = process.getuid!();
      assertOwnedDirectory(directory, uid);
      createOrValidateDatabaseFile(databasePath, uid);
      const db = new DatabaseSync(databasePath);
      try {
        createSchema(db, input.region);
      } catch {
        db.close();
        throw unavailable();
      }
      return new ManagedProbeCredentialStore(db, input.region, input.keyProvider);
    } catch {
      throw unavailable();
    }
  }

  async stagePreparedCredential(input: { versionId: string; credential: Uint8Array }): Promise<StageOutcome> {
    if (!input || !validVersionId(input.versionId) || !(input.credential instanceof Uint8Array) || input.credential.byteLength !== CREDENTIAL_BYTES) {
      throw unavailable();
    }
    // Detach from caller-owned memory before yielding to the asynchronous key provider.
    const credential = Buffer.from(input.credential);

    let active: { version: number; key: Uint8Array } | null;
    try { active = await this.keyProvider.getActiveKey(); } catch {
      credential.fill(0);
      throw unavailable();
    }
    if (!active || !Number.isSafeInteger(active.version) || active.version < 1 || active.version > 2_147_483_647 ||
        !(active.key instanceof Uint8Array) || active.key.byteLength !== 32) {
      if (active?.key instanceof Uint8Array) this.releaseProviderKey(active.key);
      credential.fill(0);
      throw unavailable();
    }

    const key = Buffer.from(active.key);
    const nonce = randomBytes(NONCE_BYTES);
    let ciphertext: Buffer | undefined;
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(this.region, input.versionId, active.version));
      ciphertext = Buffer.concat([cipher.update(credential), cipher.final(), cipher.getAuthTag()]);
      const now = Date.now();
      this.db.exec("BEGIN IMMEDIATE");
      const existingVersion = statement(this.db, "SELECT 1 FROM credential_version WHERE region=? AND version_id=?").get(this.region, input.versionId);
      if (existingVersion) {
        this.db.exec("COMMIT");
        return "version_exists";
      }
      const existingPrepared = statement(this.db, "SELECT 1 FROM credential_version WHERE region=? AND state='prepared'").get(this.region);
      if (existingPrepared) {
        this.db.exec("COMMIT");
        return "credential_exists";
      }
      statement(this.db, `INSERT INTO credential_version
        (region,version_id,purpose,state,format_version,algorithm,key_version,nonce,ciphertext,created_at_ms,updated_at_ms)
        VALUES(?,?,?,'prepared',1,'A256GCM',?,?,?,?,?)`).run(
          this.region, input.versionId, PURPOSE, active.version, nonce, ciphertext, now, now,
        );
      this.db.exec("COMMIT");
      return "prepared";
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw unavailable();
    } finally {
      key.fill(0);
      credential.fill(0);
      nonce.fill(0);
      ciphertext?.fill(0);
      this.releaseProviderKey(active.key);
    }
  }

  async withPreparedCredential<T>(versionId: string, callback: CredentialCallback<T>): Promise<T | null> {
    if (!validVersionId(versionId) || typeof callback !== "function") throw unavailable();
    const row = safeRun(() => statement(this.db, `SELECT version_id,purpose,state,format_version,algorithm,key_version,nonce,ciphertext
      FROM credential_version WHERE region=? AND version_id=?`).get(this.region, versionId) as CredentialRow | undefined);
    if (!row || row.state !== "prepared" || row.purpose !== PURPOSE || row.format_version !== FORMAT_VERSION || row.algorithm !== ALGORITHM ||
        !Number.isSafeInteger(row.key_version) || row.key_version < 1 || row.key_version > 2_147_483_647 ||
        !(row.nonce instanceof Uint8Array) || row.nonce.byteLength !== NONCE_BYTES ||
        !(row.ciphertext instanceof Uint8Array) || row.ciphertext.byteLength !== CREDENTIAL_BYTES + TAG_BYTES) return null;

    let supplied: Uint8Array | null;
    try { supplied = await this.keyProvider.getKey(row.key_version); } catch { throw unavailable(); }
    if (!(supplied instanceof Uint8Array) || supplied.byteLength !== 32) {
      if (supplied instanceof Uint8Array) this.releaseProviderKey(supplied);
      throw unavailable();
    }

    const key = Buffer.from(supplied);
    let nonce: Buffer | undefined;
    let stored: Buffer | undefined;
    let credential: Buffer | undefined;
    let transactionOpen = false;
    let callbackThrew = false;
    try {
      // Serialize the final state check, credential use, and revocation with SQLite writers.
      // Holding this synchronous transaction through the callback ensures revoke cannot commit
      // while a previously authorized callback is still waiting on key lookup.
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const current = statement(this.db, `SELECT version_id,purpose,state,format_version,algorithm,key_version,nonce,ciphertext
        FROM credential_version WHERE region=? AND version_id=?`).get(this.region, versionId) as CredentialRow | undefined;
      if (!current || current.state !== "prepared" || current.purpose !== PURPOSE || current.format_version !== FORMAT_VERSION ||
          current.algorithm !== ALGORITHM || current.key_version !== row.key_version ||
          !(current.nonce instanceof Uint8Array) || current.nonce.byteLength !== NONCE_BYTES ||
          !(current.ciphertext instanceof Uint8Array) || current.ciphertext.byteLength !== CREDENTIAL_BYTES + TAG_BYTES) {
        this.db.exec("COMMIT");
        transactionOpen = false;
        return null;
      }
      const nonceCopy = Buffer.from(current.nonce);
      const storedCopy = Buffer.from(current.ciphertext);
      nonce = nonceCopy;
      stored = storedCopy;
      const decipher = createDecipheriv("aes-256-gcm", key, nonceCopy, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(this.region, versionId, row.key_version));
      decipher.setAuthTag(storedCopy.subarray(CREDENTIAL_BYTES));
      credential = Buffer.concat([decipher.update(storedCopy.subarray(0, CREDENTIAL_BYTES)), decipher.final()]);
      if (credential.byteLength !== CREDENTIAL_BYTES) throw unavailable();

      let result: T;
      try {
        result = callback(credential);
      } catch (error) {
        callbackThrew = true;
        throw error;
      }
      if (result !== null && (typeof result === "object" || typeof result === "function") &&
          typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw unavailable();
      }
      this.db.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec("ROLLBACK"); } catch { /* connection failure */ }
        transactionOpen = false;
      }
      if (callbackThrew) throw error;
      throw unavailable();
    } finally {
      credential?.fill(0);
      key.fill(0);
      nonce?.fill(0);
      stored?.fill(0);
      this.releaseProviderKey(supplied);
    }
  }

  revokePreparedCredential(versionId: string): RevokeOutcome {
    if (!validVersionId(versionId)) throw unavailable();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = statement(this.db, `UPDATE credential_version SET state='revoked',updated_at_ms=?
        WHERE region=? AND version_id=? AND state='prepared'`).run(Date.now(), this.region, versionId);
      this.db.exec("COMMIT");
      return Number(result.changes) === 1 ? "revoked" : "unchanged";
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw unavailable();
    }
  }

  close(): void {
    try { this.db.close(); } catch { throw unavailable(); }
  }

  private releaseProviderKey(key: Uint8Array): void {
    try { this.keyProvider.releaseKey?.(key); } catch { /* cleanup must not replace operation result */ }
  }
}

export function openManagedProbeCredentialStore(input: {
  databasePath: string;
  region: string;
  keyProvider: ManagedProbeKekProvider;
}): ManagedProbeCredentialStore {
  return ManagedProbeCredentialStore.open(input);
}
