import { afterAll, describe, expect, it } from "vitest";
import { createDb, createRepo, eq, schema } from "./index";

const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 8 }) : (undefined as never);
const repo = url ? createRepo(db) : (undefined as never);
const randomRegion = () => `probe-${crypto.randomUUID().slice(0, 8)}`;
const envelope = (versionId: string, operatorId = "synthetic-operator") => ({
  region: "",
  versionId,
  formatVersion: 1 as const,
  algorithm: "A256GCM" as const,
  keyVersion: 1,
  nonce: new Uint8Array(12).fill(7),
  ciphertext: new Uint8Array(48).fill(9),
  operatorId,
});

afterAll(async () => { if (url) await db.$client.end(); });

describe.skipIf(!url)("managed probe credential envelope persistence", () => {
  const register = async (region: string) => {
    const created = await repo.createManagedProbeRegistration!({
      region,
      displayName: "Synthetic probe",
      endpointUrl: `https://${region}.example.test/probe`,
      createdBy: "synthetic-operator",
    });
    expect(created.created).toBe(true);
  };

  it("serializes concurrent preparation, stores only sealed bytes, and audits idempotent revocation", async () => {
    const region = randomRegion();
    await register(region);
    const versions = Array.from({ length: 8 }, () => crypto.randomUUID());
    const outcomes = await Promise.all(versions.map((versionId) => repo.prepareManagedProbeCredential!({ ...envelope(versionId), region })));
    expect(outcomes.filter((outcome) => outcome === "prepared")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "prepared_credential_exists")).toHaveLength(7);

    const [stored] = await db.select().from(schema.managedProbeCredential).where(eq(schema.managedProbeCredential.region, region));
    expect(stored).toBeDefined();
    expect(stored.nonce).toEqual(new Uint8Array(12).fill(7));
    expect(stored.ciphertext).toEqual(new Uint8Array(48).fill(9));
    expect(stored.state).toBe("prepared");
    expect(stored).not.toHaveProperty("plaintext");
    const selectedVersion = stored.versionId;

    expect(await repo.prepareManagedProbeCredential!({ ...envelope(selectedVersion), region })).toBe("credential_exists");
    expect(await repo.revokeManagedProbeCredential!(region, selectedVersion, "synthetic-operator")).toBe("revoked");
    expect(await repo.revokeManagedProbeCredential!(region, selectedVersion, "synthetic-operator")).toBe("already_revoked");
    expect(await repo.managedProbeCredentialEvents!(region, 100)).toMatchObject([
      { versionId: selectedVersion, action: "revoke", operatorId: "synthetic-operator" },
      { versionId: selectedVersion, action: "prepare", operatorId: "synthetic-operator" },
    ]);

    await expect(db.$client.unsafe(
      "update managed_probe_credential set ciphertext = $1 where region = $2",
      [Buffer.from(new Uint8Array(48).fill(3)), region],
    )).rejects.toMatchObject({ code: "42501" });
    const [unchanged] = await db.select().from(schema.managedProbeCredential).where(eq(schema.managedProbeCredential.region, region));
    expect(unchanged.ciphertext).toEqual(new Uint8Array(48).fill(9));
    await expect(db.$client.unsafe("delete from managed_probe_credential where region = $1", [region]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(db.$client.unsafe("delete from managed_probe_credential_event where region = $1", [region]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("rejects preparation for suspended registrations and relies on database envelope length checks", async () => {
    const region = randomRegion();
    await register(region);
    await repo.transitionManagedProbeRegistration!(region, "suspended", "synthetic-operator");
    expect(await repo.prepareManagedProbeCredential!({ ...envelope(crypto.randomUUID()), region })).toBe("registration_inactive");

    const malformedRegion = randomRegion();
    await register(malformedRegion);
    await expect(repo.prepareManagedProbeCredential!({
      ...envelope(crypto.randomUUID()), region: malformedRegion, nonce: new Uint8Array(11),
    })).rejects.toThrow();
    expect(await repo.managedProbeCredentialEvents!(malformedRegion, 100)).toEqual([]);
  });

  it("reads only the exact prepared envelope for a registered region and hides suspended or revoked material", async () => {
    const region = randomRegion();
    const versionId = crypto.randomUUID();
    const input = { ...envelope(versionId), region };
    await register(region);
    expect(await repo.prepareManagedProbeCredential!(input)).toBe("prepared");

    const stored = await repo.preparedManagedProbeCredentialEnvelope!(region, versionId);
    expect(stored).toEqual({
      region, versionId, formatVersion: 1, algorithm: "A256GCM", keyVersion: input.keyVersion,
      nonce: input.nonce, ciphertext: input.ciphertext,
    });
    expect(await repo.preparedManagedProbeCredentialEnvelope!(region, crypto.randomUUID())).toBeNull();
    expect(await repo.preparedManagedProbeCredentialEnvelope!(randomRegion(), versionId)).toBeNull();

    expect(await repo.revokeManagedProbeCredential!(region, versionId, "synthetic-operator")).toBe("revoked");
    expect(await repo.preparedManagedProbeCredentialEnvelope!(region, versionId)).toBeNull();

    const nextVersion = crypto.randomUUID();
    expect(await repo.prepareManagedProbeCredential!({ ...envelope(nextVersion), region })).toBe("prepared");
    await repo.transitionManagedProbeRegistration!(region, "suspended", "synthetic-operator");
    expect(await repo.preparedManagedProbeCredentialEnvelope!(region, nextVersion)).toBeNull();
  });

  it("rolls back credential state whenever its audit insert fails", async () => {
    const region = randomRegion();
    const versionId = crypto.randomUUID();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const trigger = `cred_audit_${suffix}`;
    const fn = `cred_audit_fn_${suffix}`;
    await register(region);
    await db.$client.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure' using errcode = '42501'; end; $$`);
    try {
      await db.$client.unsafe(`create trigger ${trigger} before insert on managed_probe_credential_event for each row when (new.region = '${region}' and new.action = 'prepare') execute function ${fn}()`);
      await expect(repo.prepareManagedProbeCredential!({ ...envelope(versionId), region })).rejects.toMatchObject({ cause: { code: "42501" } });
      expect(await db.select().from(schema.managedProbeCredential).where(eq(schema.managedProbeCredential.region, region))).toEqual([]);
      expect(await repo.managedProbeCredentialEvents!(region, 100)).toEqual([]);

      await db.$client.unsafe(`drop trigger ${trigger} on managed_probe_credential_event`);
      await repo.prepareManagedProbeCredential!({ ...envelope(versionId), region });
      await db.$client.unsafe(`create trigger ${trigger} before insert on managed_probe_credential_event for each row when (new.region = '${region}' and new.action = 'revoke') execute function ${fn}()`);
      await expect(repo.revokeManagedProbeCredential!(region, versionId, "synthetic-operator")).rejects.toMatchObject({ cause: { code: "42501" } });
      const [credential] = await db.select().from(schema.managedProbeCredential).where(eq(schema.managedProbeCredential.region, region));
      expect(credential.state).toBe("prepared");
      expect(await repo.managedProbeCredentialEvents!(region, 100)).toMatchObject([{ action: "prepare" }]);
    } finally {
      await db.$client.unsafe(`drop trigger if exists ${trigger} on managed_probe_credential_event`);
      await db.$client.unsafe(`drop function if exists ${fn}()`);
    }
  });
});
