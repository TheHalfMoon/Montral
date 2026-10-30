import type { Edition } from "./edition";
import type { Tool } from "@montral/mcp-rest";
import { z } from "zod";
import { unmetered } from "./entitlements";
import { migrateMontralHooks, mountMontralHooks } from "./montral-hooks";

const id = z.string().uuid().describe("Montral webhook inbox UUID.");
export const MONTRAL_TOOLS: Tool[] = [
  {
    name: "list_webhook_inboxes",
    description: "List webhook inboxes in the selected Montral project. Secrets and receiver URLs are not returned.",
    schema: z.object({}),
    readOnly: true,
    build: () => ({ method: "GET", path: "/api/hooks/inboxes" }),
  },
  {
    name: "create_webhook_inbox",
    description: "Create a Montral webhook inbox. Returns a secret receiver path ONCE. Treat that path like a credential; it will not be listed again. Requires workspace manager role.",
    schema: z.object({ name: z.string().min(1).max(100) }),
    build: (a) => ({ method: "POST", path: "/api/hooks/inboxes", body: a }),
  },
  {
    name: "list_webhook_events",
    description: "Inspect the newest 50 captured webhook requests for an inbox in this Montral project; may contain sensitive request bodies. Never disclose event bodies to unauthorized third parties.",
    schema: z.object({ id }),
    readOnly: true,
    build: (a) => ({ method: "GET", path: `/api/hooks/inboxes/${a.id}/events` }),
  },
  {
    name: "delete_webhook_inbox",
    description: "Permanently remove an inbox and all captured events. Requires manager role.",
    schema: z.object({ id }),
    destructive: true,
    idempotent: true,
    build: (a) => ({ method: "DELETE", path: `/api/hooks/inboxes/${a.id}` }),
  },
];

/** Montral's active runtime edition. No billing is enabled; core monitoring stays unmetered in private preview. */
export const montralEdition: Edition = {
  id: "montral",
  entitlements: () => unmetered,
  mount: mountMontralHooks,
  migrate: migrateMontralHooks,
  mcpTools: MONTRAL_TOOLS,
};
