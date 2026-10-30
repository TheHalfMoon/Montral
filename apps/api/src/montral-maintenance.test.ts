import { describe, expect, it } from "vitest";
import type { Database } from "@montral/repo";
import { runMontralMaintenance } from "./montral-maintenance";

describe("Montral scheduled retention", () => {
  it("executes both independent cleanup tasks and returns their counts", async () => {
    const calls: string[] = [];
    const fake = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("WITH old_intents AS")) return [{ removed: "3" }];
        if (sql.includes("WITH expired AS")) return [{ removed: "2" }];
        return [];
      },
    } as unknown as Database;
    expect(await runMontralMaintenance(fake)).toEqual({ expiredHooks: 2, expiredIntents: 3 });
    expect(calls.some(sql => sql.includes("DELETE FROM montral_hook_inbox"))).toBe(true);
    expect(calls.some(sql => sql.includes("DELETE FROM montral_billing_intent"))).toBe(true);
  });

  it("still expires checkout intents when webhook cleanup fails", async () => {
    let billingCalled = false;
    const fake = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM montral_hook_inbox")) throw new Error("simulated webhook cleanup outage");
        if (sql.includes("WITH old_intents AS")) {
          billingCalled = true;
          return [{ removed: "1" }];
        }
        return [];
      },
    } as unknown as Database;
    await expect(runMontralMaintenance(fake)).rejects.toThrow("Montral retention maintenance failed");
    expect(billingCalled).toBe(true);
  });

  it("still expires webhook events when billing nonce cleanup fails", async () => {
    let hookCalled = false;
    const fake = {
      query: async (sql: string) => {
        if (sql.includes("WITH old_intents AS")) throw new Error("simulated billing cleanup outage");
        if (sql.includes("WITH expired AS")) {
          hookCalled = true;
          return [{ removed: "4" }];
        }
        return [];
      },
    } as unknown as Database;
    await expect(runMontralMaintenance(fake)).rejects.toThrow("Montral retention maintenance failed");
    expect(hookCalled).toBe(true);
  });
});
