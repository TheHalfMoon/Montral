import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateMigrationHistory } from "../../../packages/db-pg/src/migration-history.mjs";
import { SCHEMA_AHEAD_MESSAGE, SCHEMA_DIVERGED_MESSAGE, fatalMigrationProblem } from "./startup-schema";

const first = { tag: "0000_first", when: 10, sql: "create table first_table(id integer)" };
const second = { tag: "0001_second", when: 20, sql: "create table second_table(id integer)" };
const row = (m: typeof first) => ({ created_at: String(m.when), hash: createHash("sha256").update(m.sql).digest("hex") });
const thrown = (fn: () => unknown) => { try { fn(); } catch (e) { return e; } throw new Error("expected a throw"); };

describe("startup refusal of a database this build cannot run", () => {
  it("a history ahead of the build (an older build after an upgrade) exits at once with the fixed message", () => {
    const e = thrown(() => validateMigrationHistory([first], [row(first), row(second)]));
    expect(fatalMigrationProblem(e)).toBe(SCHEMA_AHEAD_MESSAGE);
    expect(SCHEMA_AHEAD_MESSAGE).toBe("database schema is newer than this Montral build; restore the pre-upgrade backup or run the newer build");
  });

  it("a diverged history (another branch, edited SQL) exits at once too", () => {
    expect(fatalMigrationProblem(thrown(() => validateMigrationHistory([first, second], [row(second)])))).toBe(SCHEMA_DIVERGED_MESSAGE);
  });

  it("connection failures and anything else keep retrying", () => {
    for (const e of [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }), Object.assign(new Error("the database system is starting up"), { code: "57P03" }), new Error("boom"), null, undefined, "x"]) {
      expect(fatalMigrationProblem(e)).toBeNull();
    }
    // a pending migration is normal: nothing is thrown
    expect(validateMigrationHistory([first, second], [row(first)])).toEqual([second]);
  });
});
