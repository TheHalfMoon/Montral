import { createHash, randomUUID } from "node:crypto";
import { createDb, createRepo, eq, migrate, schema } from "@montral/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeManagedProbeEnrollmentGrant, createManagedProbeEnrollmentGrant } from "./managed-probe-enrollment";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url, { max: 5 }) : undefined;
const repo = db ? createRepo(db) : undefined;

beforeAll(async () => { if (db) await migrate(db); });
afterAll(async () => { if (db) await db.$client.end(); });

describe.skipIf(!url)("managed probe enrollment authorization (PostgreSQL)", () => {
  it("stores only digests, binds authorization, serializes concurrent use, and invalidates on suspension", async () => {
    const region = `enroll-${randomUUID().slice(0, 12)}`;
    const endpointUrl = `https://${region}.example.test/api/probe/${region}`;
    const versionId = randomUUID();
    const operatorId = "synthetic-enrollment-test";
    const registration = await repo!.createManagedProbeRegistration!({ region, displayName: "Synthetic enrollment", endpointUrl, createdBy: operatorId });
    expect(registration.created).toBe(true);
    expect(await repo!.prepareManagedProbeCredential!({
      region, versionId, formatVersion: 1, algorithm: "A256GCM", keyVersion: 1,
      nonce: new Uint8Array(12), ciphertext: new Uint8Array(48), operatorId,
    })).toBe("prepared");

    const grant = await createManagedProbeEnrollmentGrant(repo!, { region, versionId, endpointUrl, operatorId });
    const [stored] = await db!.select().from(schema.managedProbeEnrollmentGrant).where(eq(schema.managedProbeEnrollmentGrant.id, grant.id));
    expect(stored).toBeDefined();
    expect(stored.tokenDigest).toEqual(new Uint8Array(createHash("sha256").update(Buffer.from(grant.token, "base64url")).digest()));
    expect(stored.nonceDigest).toEqual(new Uint8Array(createHash("sha256").update(Buffer.from(grant.nonce, "base64url")).digest()));
    expect(JSON.stringify(stored)).not.toContain(grant.token);
    expect(JSON.stringify(stored)).not.toContain(grant.nonce);
    expect(stored.endpointUrl).toBe(endpointUrl);
    expect(stored.versionId).toBe(versionId);

    expect(await consumeManagedProbeEnrollmentGrant(repo!, { ...grant, region: `other-${region}`, versionId, endpointUrl })).toBe(false);
    expect(await consumeManagedProbeEnrollmentGrant(repo!, { ...grant, region, versionId, endpointUrl: `${endpointUrl}/changed` })).toBe(false);
    expect(await consumeManagedProbeEnrollmentGrant(repo!, { ...grant, region, versionId: randomUUID(), endpointUrl })).toBe(false);
    const mismatchedNonce = `${grant.nonce[0] === "A" ? "B" : "A"}${grant.nonce.slice(1)}`;
    expect(await consumeManagedProbeEnrollmentGrant(repo!, { ...grant, region, versionId, endpointUrl, nonce: mismatchedNonce })).toBe(false);
    const replicaDb = createDb(url!, { max: 2 });
    const replicaRepo = createRepo(replicaDb);
    let simultaneous: boolean[];
    try {
      simultaneous = await Promise.all([
        consumeManagedProbeEnrollmentGrant(repo!, { ...grant, region, versionId, endpointUrl }),
        consumeManagedProbeEnrollmentGrant(replicaRepo, { ...grant, region, versionId, endpointUrl }),
      ]);
    } finally {
      await replicaDb.$client.end();
    }
    expect(simultaneous.filter(Boolean)).toHaveLength(1);
    expect(await consumeManagedProbeEnrollmentGrant(repo!, { ...grant, region, versionId, endpointUrl })).toBe(false);

    const second = await createManagedProbeEnrollmentGrant(repo!, { region, versionId, endpointUrl, operatorId });
    expect((await repo!.transitionManagedProbeRegistration!(region, "suspended", operatorId)).outcome).toBe("changed");
    expect(await consumeManagedProbeEnrollmentGrant(repo!, { ...second, region, versionId, endpointUrl })).toBe(false);
    const events = await repo!.managedProbeEnrollmentGrantEvents!(region, 20);
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(["issue", "consume", "revoke"]));
    expect(JSON.stringify(events)).not.toContain(grant.token);
  });

  it("expires stale grants atomically and rejects revoked credentials", async () => {
    const region = `expire-${randomUUID().slice(0, 12)}`;
    const endpointUrl = `https://${region}.example.test/api/probe/${region}`;
    const versionId = randomUUID();
    const operatorId = "synthetic-enrollment-expiry-test";
    expect((await repo!.createManagedProbeRegistration!({ region, displayName: "Synthetic expiry", endpointUrl, createdBy: operatorId })).created).toBe(true);
    expect(await repo!.prepareManagedProbeCredential!({
      region, versionId, formatVersion: 1, algorithm: "A256GCM", keyVersion: 1,
      nonce: new Uint8Array(12), ciphertext: new Uint8Array(48), operatorId,
    })).toBe("prepared");

    const staleToken = crypto.getRandomValues(new Uint8Array(32));
    const staleNonce = crypto.getRandomValues(new Uint8Array(32));
    const staleId = randomUUID();
    await db!.insert(schema.managedProbeEnrollmentGrant).values({
      id: staleId, region, versionId, endpointUrl,
      tokenDigest: createHash("sha256").update(staleToken).digest(),
      nonceDigest: createHash("sha256").update(staleNonce).digest(),
      expiresAt: new Date(Date.now() - 1), createdBy: operatorId,
    });
    const stale = { token: Buffer.from(staleToken).toString("base64url"), nonce: Buffer.from(staleNonce).toString("base64url"), region, versionId, endpointUrl };
    staleToken.fill(0);
    staleNonce.fill(0);
    expect(await consumeManagedProbeEnrollmentGrant(repo!, stale)).toBe(false);
    const [expired] = await db!.select().from(schema.managedProbeEnrollmentGrant).where(eq(schema.managedProbeEnrollmentGrant.id, staleId));
    expect(expired.state).toBe("expired");
    expect((await repo!.managedProbeEnrollmentGrantEvents!(region, 10)).map((event) => event.action)).toContain("expire");

    const pending = await createManagedProbeEnrollmentGrant(repo!, { region, versionId, endpointUrl, operatorId });
    expect(await repo!.revokeManagedProbeCredential!(region, versionId, operatorId)).toBe("revoked");
    expect(await consumeManagedProbeEnrollmentGrant(repo!, { ...pending, region, versionId, endpointUrl })).toBe(false);
    const [revoked] = await db!.select().from(schema.managedProbeEnrollmentGrant).where(eq(schema.managedProbeEnrollmentGrant.id, pending.id));
    expect(revoked.state).toBe("revoked");
  });

  it("rejects a consume that waits on the region lock until after expiry", async () => {
    const region = `lock-${randomUUID().slice(0, 12)}`;
    const endpointUrl = `https://${region}.example.test/api/probe/${region}`;
    const versionId = randomUUID();
    const operatorId = "synthetic-enrollment-lock-test";
    expect((await repo!.createManagedProbeRegistration!({ region, displayName: "Synthetic lock", endpointUrl, createdBy: operatorId })).created).toBe(true);
    expect(await repo!.prepareManagedProbeCredential!({
      region, versionId, formatVersion: 1, algorithm: "A256GCM", keyVersion: 1,
      nonce: new Uint8Array(12), ciphertext: new Uint8Array(48), operatorId,
    })).toBe("prepared");

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const id = randomUUID();
    await db!.insert(schema.managedProbeEnrollmentGrant).values({
      id, region, versionId, endpointUrl,
      tokenDigest: createHash("sha256").update(tokenBytes).digest(),
      nonceDigest: createHash("sha256").update(nonceBytes).digest(),
      expiresAt: new Date(Date.now() + 1_000), createdBy: operatorId,
    });
    const grant = {
      token: Buffer.from(tokenBytes).toString("base64url"),
      nonce: Buffer.from(nonceBytes).toString("base64url"),
      region, versionId, endpointUrl,
    };
    tokenBytes.fill(0);
    nonceBytes.fill(0);

    const lockDb = createDb(url!, { max: 1 });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const holdingLock = lockDb.$client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"managed-probe-registration:" + region}, 0))`;
      acquired();
      await tx`select pg_sleep(3)`;
    });
    try {
      await lockAcquired;
      const consuming = consumeManagedProbeEnrollmentGrant(repo!, grant);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holdingLock;
      expect(await consuming).toBe(false);
      const [expired] = await db!.select().from(schema.managedProbeEnrollmentGrant).where(eq(schema.managedProbeEnrollmentGrant.id, id));
      expect(expired.state).toBe("expired");
    } finally {
      await lockDb.$client.end();
    }
  });
});
