import { createDb, createRepo, eq, migrate, schema } from "@montral/db-pg";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptManagedProbeCredentialWithProvider,
  generateEncryptedManagedProbeCredentialWithProvider,
  type ManagedProbeKekProvider,
} from "./managed-probe-kek-provider";
import { withPreparedManagedProbeCredential } from "./managed-probe-credential-access";
import { createFileManagedProbeKekProvider } from "./managed-probe-kek-file-provider";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url, { max: 2 }) : (undefined as never);
const repo = url ? createRepo(db) : (undefined as never);

beforeAll(async () => { if (url) await migrate(db); });
afterAll(async () => { if (url) await db.$client.end(); });

describe.skipIf(!url)("managed probe envelope persistence and database-only recovery", () => {
  it("persists only the envelope, round-trips with an external KEK, and fails closed without it", async () => {
    const region = `probe-${crypto.randomUUID().slice(0, 12)}`;
    const operatorId = "synthetic-envelope-test";
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const keyProvider: ManagedProbeKekProvider = {
      getActiveKey: async () => ({ version: 5, key: kek }),
      getKey: async (version) => version === 5 ? kek : null,
    };
    const registered = await repo.createManagedProbeRegistration!({
      region,
      displayName: "Synthetic encrypted probe",
      endpointUrl: `https://${region}.example.test/probe`,
      createdBy: operatorId,
    });
    expect(registered.created).toBe(true);

    const generated = await generateEncryptedManagedProbeCredentialWithProvider(region, keyProvider);
    try {
      expect(await repo.prepareManagedProbeCredential!({
        region,
        versionId: generated.credentialVersionId,
        formatVersion: generated.envelope.formatVersion,
        algorithm: generated.envelope.algorithm,
        keyVersion: generated.envelope.keyVersion,
        nonce: generated.envelope.nonce,
        ciphertext: generated.envelope.ciphertext,
        operatorId,
      })).toBe("prepared");

      const [stored] = await db.select().from(schema.managedProbeCredential).where(eq(schema.managedProbeCredential.region, region));
      expect(stored).toBeDefined();
      expect(stored.ciphertext).toEqual(generated.envelope.ciphertext);
      expect(stored.nonce).toEqual(generated.envelope.nonce);
      expect(stored.ciphertext).not.toEqual(generated.credential);
      expect(Object.keys(stored)).not.toContain("kek");

      let observedCredential: Uint8Array | undefined;
      await withPreparedManagedProbeCredential(repo, region, stored.versionId, keyProvider, (credential) => {
        observedCredential = credential;
        expect(credential).toEqual(generated.credential);
      });
      expect(observedCredential).toBeDefined();
      expect(observedCredential).toEqual(new Uint8Array(generated.credential.length));

      // Persisted database fields contain ciphertext and metadata, never the plaintext credential or its external KEK.
      const backupRow = JSON.stringify({
        region: stored.region,
        versionId: stored.versionId,
        keyVersion: stored.keyVersion,
        nonce: Buffer.from(stored.nonce).toString("hex"),
        ciphertext: Buffer.from(stored.ciphertext).toString("hex"),
        state: stored.state,
      });
      expect(backupRow).not.toContain(Buffer.from(generated.credential).toString("hex"));
      expect(backupRow).not.toContain(Buffer.from(kek).toString("hex"));

      const recovered = await decryptManagedProbeCredentialWithProvider(region, stored.versionId, {
        formatVersion: stored.formatVersion as 1,
        algorithm: stored.algorithm as "A256GCM",
        keyVersion: stored.keyVersion,
        nonce: stored.nonce,
        ciphertext: stored.ciphertext,
      }, keyProvider);
      try {
        expect(recovered).toEqual(generated.credential);
      } finally {
        recovered.fill(0);
      }
      const noKeys: ManagedProbeKekProvider = { getActiveKey: async () => null, getKey: async () => null };
      await expect(withPreparedManagedProbeCredential(repo, region, stored.versionId, noKeys, () => undefined))
        .rejects.toThrow("Managed probe credential unavailable");
      await expect(decryptManagedProbeCredentialWithProvider(region, stored.versionId, {
        formatVersion: stored.formatVersion as 1,
        algorithm: stored.algorithm as "A256GCM",
        keyVersion: stored.keyVersion,
        nonce: stored.nonce,
        ciphertext: stored.ciphertext,
      }, noKeys)).rejects.toThrow("Managed probe credential unavailable");
    } finally {
      generated.credential.fill(0);
      kek.fill(0);
    }
  });

  it("recovers a persisted envelope through the file provider after active-key rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "montral-kek-storage-e2e-"));
    const region = `probe-${crypto.randomUUID().slice(0, 12)}`;
    const operatorId = "synthetic-file-kek-test";
    const key1 = crypto.getRandomValues(new Uint8Array(32));
    const key2 = crypto.getRandomValues(new Uint8Array(32));
    const provider = createFileManagedProbeKekProvider(directory);
    let generated: Awaited<ReturnType<typeof generateEncryptedManagedProbeCredentialWithProvider>> | undefined;
    let observedCredential: Uint8Array | undefined;
    try {
      await writeFile(join(directory, "kek-1.bin"), key1);
      await writeFile(join(directory, "active-version"), "1\n", "ascii");
      const registered = await repo.createManagedProbeRegistration!({
        region,
        displayName: "Synthetic file-backed probe",
        endpointUrl: `https://${region}.example.test/probe`,
        createdBy: operatorId,
      });
      expect(registered.created).toBe(true);

      generated = await generateEncryptedManagedProbeCredentialWithProvider(region, provider);
      const current = generated;
      expect(current.envelope.keyVersion).toBe(1);
      expect(await repo.prepareManagedProbeCredential!({
        region,
        versionId: current.credentialVersionId,
        formatVersion: current.envelope.formatVersion,
        algorithm: current.envelope.algorithm,
        keyVersion: current.envelope.keyVersion,
        nonce: current.envelope.nonce,
        ciphertext: current.envelope.ciphertext,
        operatorId,
      })).toBe("prepared");

      await writeFile(join(directory, "kek-2.bin"), key2);
      await writeFile(join(directory, "active-version"), "2\n", "ascii");
      const storedEnvelope = await repo.preparedManagedProbeCredentialEnvelope!(region, current.credentialVersionId);
      expect(storedEnvelope?.keyVersion).toBe(1);

      await withPreparedManagedProbeCredential(repo, region, current.credentialVersionId, provider, (credential) => {
        observedCredential = credential;
        expect(credential).toEqual(current.credential);
      });
      expect(observedCredential).toBeDefined();
      expect(observedCredential).toEqual(new Uint8Array(current.credential.length));

      const active = await provider.getActiveKey();
      expect(active).toBeDefined();
      try {
        expect(active?.version).toBe(2);
        expect(active?.key).toEqual(key2);
      } finally {
        if (active) provider.releaseKey?.(active.key);
      }
      expect(active?.key).toEqual(new Uint8Array(32));
    } finally {
      observedCredential?.fill(0);
      generated?.credential.fill(0);
      key1.fill(0);
      key2.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!url || process.env.MONTRAL_TEST_PG_DUMP_REQUIRED !== "1")("managed probe credential database-only backup", () => {
  it("keeps plaintext credentials and KEKs out of a real pg_dump data archive", async () => {
    const region = `probe-${crypto.randomUUID().slice(0, 12)}`;
    const operatorId = "synthetic-pg-dump-test";
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const provider: ManagedProbeKekProvider = {
      getActiveKey: async () => ({ version: 8, key: kek }),
      getKey: async (version) => version === 8 ? kek : null,
    };
    const registered = await repo.createManagedProbeRegistration!({
      region,
      displayName: "Synthetic pg_dump probe",
      endpointUrl: `https://${region}.example.test/probe`,
      createdBy: operatorId,
    });
    expect(registered.created).toBe(true);

    const generated = await generateEncryptedManagedProbeCredentialWithProvider(region, provider);
    try {
      expect(await repo.prepareManagedProbeCredential!({
        region,
        versionId: generated.credentialVersionId,
        formatVersion: generated.envelope.formatVersion,
        algorithm: generated.envelope.algorithm,
        keyVersion: generated.envelope.keyVersion,
        nonce: generated.envelope.nonce,
        ciphertext: generated.envelope.ciphertext,
        operatorId,
      })).toBe("prepared");

      const parsed = new URL(url!);
      const dump = execFileSync("pg_dump", [
        "--data-only", "--column-inserts", "--no-owner", "--no-privileges",
        "--table=public.managed_probe_credential", "--table=public.managed_probe_credential_event",
        "--host", parsed.hostname, "--port", parsed.port || "5432",
        "--username", decodeURIComponent(parsed.username), "--dbname", decodeURIComponent(parsed.pathname.slice(1)),
      ], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
      });
      expect(dump).toContain(Buffer.from(generated.envelope.ciphertext).toString("hex"));
      expect(dump).not.toContain(Buffer.from(generated.credential).toString("hex"));
      expect(dump).not.toContain(Buffer.from(generated.credential).toString("base64"));
      expect(dump).not.toContain(Buffer.from(kek).toString("hex"));
      expect(dump).not.toContain(Buffer.from(kek).toString("base64"));
    } finally {
      generated.credential.fill(0);
      kek.fill(0);
    }
  });
});
