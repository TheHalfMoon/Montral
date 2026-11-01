import { describe, expect, it } from "vitest";
import { read } from "./helpers";

describe("Node, Worker and local scheduler operational log privacy", () => {
  for (const file of ["apps/api/src/server.ts", "apps/api/src/worker.ts", "apps/api/src/dev.ts"]) {
    it(`${file} must never log raw provider/DB/job exceptions or rethrow a raw scheduled failure`, () => {
      const source = read(file);
      // Scheduler/queue maintenance and SMTP/DB failures can contain URLs, tokens,
      // connection strings, device identifiers and subscriber addresses.
      expect(source).not.toMatch(/console\.(?:warn|error|log)\([^;\n]*,\s*(?:e|err|error)\s*\)/);
      expect(source).not.toMatch(/\((?:e|err|error) as Error\)\.message/);
      expect(source).not.toMatch(/throw schedulerError\b|throw e\b/);
      expect(source).not.toMatch(/\.catch\(\((?:e|err|error)\)\s*=>\s*console\./);
    });
  }
});
