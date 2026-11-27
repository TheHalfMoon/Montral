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
const pgDumpRequired = process.env.MONTRAL_TEST_PG_DUMP_REQUIRED === "1";
if (pgDumpRequired) {
  const parsed = url ? new URL(url) : null;
  const database = parsed ? decodeURIComponent(parsed.pathname.slice(1)) : "";
  if (!parsed || !["127.0.0.1", "localhost"].includes(parsed.hostname) || !database.startsWith("montral_test_")) {
    throw new Error("Managed probe backup tests require a local montral_test_ database");
  }
}
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

describe.skipIf(!url || !pgDumpRequired)("managed probe credential database-only backup", () => {
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
      expect(dump).not.toContain(Buffer.from(generated.credential).toString("base64url"));
      expect(dump).not.toContain(Buffer.from(kek).toString("hex"));
      expect(dump).not.toContain(Buffer.from(kek).toString("base64"));
      expect(dump).not.toContain(Buffer.from(kek).toString("base64url"));
    } finally {
      generated.credential.fill(0);
      kek.fill(0);
    }
  });

  it("restores managed probe envelopes and audit rows into a fresh database with an external KEK", async () => {
    const region = `probe-${crypto.randomUUID().slice(0, 12)}`;
    const operatorId = "synthetic-managed-probe-restore-test";
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const provider: ManagedProbeKekProvider = {
      getActiveKey: async () => ({ version: 8, key: kek }),
      getKey: async (version) => version === 8 ? kek : null,
    };
    const parsed = new URL(url!);
    const restoreDatabase = `montral_test_restore_${crypto.randomUUID().replaceAll("-", "")}`;
    const restoreUrl = new URL(url!);
    restoreUrl.pathname = `/${restoreDatabase}`;
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) };
    const pgArgs = ["--host", parsed.hostname, "--port", parsed.port || "5432", "--username", decodeURIComponent(parsed.username)];
    const archiveDirectory = await mkdtemp(join(tmpdir(), "montral-managed-probe-restore-"));
    const archivePath = join(archiveDirectory, "managed-probe-data.dump");
    let restoreDb: ReturnType<typeof createDb> | undefined;
    let databaseCreated = false;
    let generated: Awaited<ReturnType<typeof generateEncryptedManagedProbeCredentialWithProvider>> | undefined;
    let restoredCredential: Uint8Array | undefined;
    try {
      const registered = await repo.createManagedProbeRegistration!({
        region,
        displayName: "Synthetic restored probe",
        endpointUrl: `https://${region}.example.test/probe`,
        createdBy: operatorId,
      });
      expect(registered.created).toBe(true);
      generated = await generateEncryptedManagedProbeCredentialWithProvider(region, provider);
      const current = generated;
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

      execFileSync("pg_dump", [
        "--format=custom", "--data-only", "--no-owner", "--no-privileges",
        "--table=public.managed_probe_registration", "--table=public.managed_probe_registration_event",
        "--table=public.managed_probe_credential", "--table=public.managed_probe_credential_event",
        "--table=public.managed_probe_registration_event_id_seq", "--table=public.managed_probe_credential_event_id_seq",
        "--host", parsed.hostname, "--port", parsed.port || "5432",
        "--username", decodeURIComponent(parsed.username), "--dbname", decodeURIComponent(parsed.pathname.slice(1)),
        "--file", archivePath,
      ], { env, stdio: "pipe" });
      const archiveSql = execFileSync("pg_restore", ["--file=-", archivePath], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env,
      });
      expect(archiveSql).toContain(Buffer.from(current.envelope.ciphertext).toString("hex"));
      expect(archiveSql).not.toContain(Buffer.from(current.credential).toString("hex"));
      expect(archiveSql).not.toContain(Buffer.from(current.credential).toString("base64"));
      expect(archiveSql).not.toContain(Buffer.from(current.credential).toString("base64url"));
      expect(archiveSql).not.toContain(Buffer.from(kek).toString("hex"));
      expect(archiveSql).not.toContain(Buffer.from(kek).toString("base64"));
      expect(archiveSql).not.toContain(Buffer.from(kek).toString("base64url"));

      execFileSync("createdb", [...pgArgs, restoreDatabase], { env, stdio: "pipe" });
      databaseCreated = true;
      restoreDb = createDb(restoreUrl.toString(), { max: 2 });
      await migrate(restoreDb);
      execFileSync("pg_restore", [
        "--data-only", "--no-owner", "--no-privileges", "--exit-on-error",
        "--dbname", restoreUrl.toString(), archivePath,
      ], { env, stdio: "pipe" });

      const restoredRepo = createRepo(restoreDb);
      const restoredEnvelope = await restoredRepo.preparedManagedProbeCredentialEnvelope!(region, current.credentialVersionId);
      expect(restoredEnvelope).toMatchObject({
        region,
        versionId: current.credentialVersionId,
        formatVersion: current.envelope.formatVersion,
        algorithm: current.envelope.algorithm,
        keyVersion: current.envelope.keyVersion,
        nonce: current.envelope.nonce,
        ciphertext: current.envelope.ciphertext,
      });
      await withPreparedManagedProbeCredential(restoredRepo, region, current.credentialVersionId, provider, (credential) => {
        restoredCredential = credential;
        expect(credential).toEqual(current.credential);
      });
      expect(restoredCredential).toEqual(new Uint8Array(current.credential.length));
      const secondRegion = `probe-${crypto.randomUUID().slice(0, 12)}`;
      expect(await restoredRepo.createManagedProbeRegistration!({
        region: secondRegion,
        displayName: "Synthetic sequence probe",
        endpointUrl: `https://${secondRegion}.example.test/probe`,
        createdBy: operatorId,
      })).toMatchObject({ created: true });
      expect(await restoredRepo.revokeManagedProbeCredential!(region, current.credentialVersionId, operatorId)).toBe("revoked");
      const restoredEvents = await restoreDb.select({ action: schema.managedProbeCredentialEvent.action, id: schema.managedProbeCredentialEvent.id })
        .from(schema.managedProbeCredentialEvent)
        .where(eq(schema.managedProbeCredentialEvent.region, region))
        .orderBy(schema.managedProbeCredentialEvent.id);
      expect(restoredEvents.map((event) => event.action)).toEqual(["prepare", "revoke"]);
      const registrationEvents = await restoreDb.select({ action: schema.managedProbeRegistrationEvent.action, id: schema.managedProbeRegistrationEvent.id })
        .from(schema.managedProbeRegistrationEvent)
        .where(eq(schema.managedProbeRegistrationEvent.region, region))
        .orderBy(schema.managedProbeRegistrationEvent.id);
      expect(registrationEvents.map((event) => event.action)).toEqual(["register"]);
    } finally {
      restoredCredential?.fill(0);
      generated?.credential.fill(0);
      kek.fill(0);
      try {
        await restoreDb?.$client.end();
      } finally {
        try {
          if (databaseCreated) {
            execFileSync("dropdb", ["--force", ...pgArgs, restoreDatabase], { env, stdio: "pipe" });
          }
        } finally {
          await rm(archiveDirectory, { recursive: true, force: true });
        }
      }
    }
  });
});
