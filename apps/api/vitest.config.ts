import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 20000, globalSetup: ["./test/global-setup.ts"] } });
