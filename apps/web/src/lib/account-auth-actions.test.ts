import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { attemptAuthAction, changePasswordWithCleanup } from "./account-auth-actions";

describe("Better Auth account security mutation failures", () => {
  it("integrates guarded actions into account session and password UI", () => {
    const account = readFileSync(new URL("../components/Account.tsx", import.meta.url), "utf8");
    expect(account).toContain("attemptAuthAction(() => authClient.twoFactor.enable(");
    expect(account).toContain("attemptAuthAction(() => authClient.twoFactor.verifyTotp(");
    expect(account).toContain("attemptAuthAction(() => authClient.twoFactor.disable(");
    expect(account).toContain("attemptAuthAction(() => authClient.deleteUser(");
    expect(account).toContain("attemptAuthAction(() => authClient.signIn.social(");
    expect(account).toContain("attemptAuthAction(() => authClient.linkSocial(");
    expect(account).toContain("attemptAuthAction(() => authClient.unlinkAccount(");
    expect(account).toContain("if (!r) return fail();");
    expect(account).toContain("attemptAuthAction(() => authClient.revokeSession(");
    expect(account).toContain("attemptAuthAction(() => authClient.revokeOtherSessions())");
    expect(account).toContain("const outcome = await changePasswordWithCleanup(");
    expect(account).toContain('outcome.kind === "change-unconfirmed"');
    expect(account).toContain('outcome.kind === "changed-revoke-unconfirmed"');
    expect(account).toContain('outcome.kind === "changed-revoke-failed"');
    expect(account).toContain('setErr(t("Could not load sessions."))');
  });

  it("does not turn a rejected network request into success or throw to a click handler", async () => {
    expect(await attemptAuthAction(async () => { throw new TypeError("network unreachable"); })).toBeNull();
    expect(await attemptAuthAction(async () => ({ error: { status: 429, code: "TOO_MANY_REQUESTS" } })))
      .toEqual({ error: { status: 429, code: "TOO_MANY_REQUESTS" } });
  });

  it("does not attempt other-session revocation when the password update rejected", async () => {
    const revoke = vi.fn(async () => ({ error: null }));
    const result = await changePasswordWithCleanup(async () => { throw new Error("offline"); }, revoke);
    expect(result).toEqual({ kind: "change-unconfirmed" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("preserves server validation details when a password change was refused", async () => {
    const result = await changePasswordWithCleanup(async () => ({ error: { code: "INVALID_PASSWORD", status: 400 } }));
    expect(result).toEqual({ kind: "change-failed", error: { code: "INVALID_PASSWORD", status: 400 } });
  });

  it("reports a successful password change with the optional revocation disabled", async () => {
    expect(await changePasswordWithCleanup(async () => ({ error: null }))).toEqual({ kind: "changed" });
  });

  it("reports a successful password change and successful session revocation", async () => {
    const revoke = vi.fn(async () => ({ error: null }));
    expect(await changePasswordWithCleanup(async () => ({ error: null }), revoke))
      .toEqual({ kind: "changed-revoked" });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("reports a failed revoke after a confirmed password change", async () => {
    const outcome = await changePasswordWithCleanup(async () => ({ error: null }), async () => ({ error: { status: 503 } }));
    expect(outcome).toEqual({ kind: "changed-revoke-failed" });
  });

  it("reports unknown revocation status after transport loss, not a failed password change", async () => {
    const outcome = await changePasswordWithCleanup(async () => ({ error: null }), async () => {
      throw new Error("connection lost after password was changed");
    });
    expect(outcome).toEqual({ kind: "changed-revoke-unconfirmed" });
  });
});
