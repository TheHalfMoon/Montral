import { defineConfig } from "vitest/config";

// Files share one database and some exercise global queue claims. Keep independent fixtures from claiming
// each other's work; the explicit concurrent callers inside each test still exercise database races.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 20000, fileParallelism: false } });
