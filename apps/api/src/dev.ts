import { serve } from "@hono/node-server";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import type { Bindings } from "./env";
import { configureEmail } from "./email";
import { configureApns } from "./apns";
import { configureNetGuard } from "./netguard";
import { configureBrowserChecks } from "./browser-check";
import { configureProbes } from "./probes";
import { runDueChecks } from "./scheduler";

const env = process.env as unknown as Bindings;
configureEmail(env);
configureNetGuard(env);
configureBrowserChecks(env);
configureProbes(env);
configureApns(env);
const app = createApp(openDatabase, {edition: montralEdition});
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: (req) => app.fetch(req, env), port }, () => console.log(`api → http://localhost:${port}`));

// local stand-in for the Workers cron trigger
const { repo } = openDatabase(env.DATABASE_URL!, { max: 5 });
setInterval(() => runDueChecks(repo).catch(() => console.error("scheduler failed; private diagnostic suppressed")), 15_000);
