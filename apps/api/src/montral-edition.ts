import type { Edition } from "./edition";
import type { Tool } from "@montral/mcp-rest";
import { z } from "zod";

import { migrateMontralHooks, mountMontralHooks } from "./montral-hooks";
import { migrateMontralBilling, mountMontralBilling } from "./montral-billing";
import { createMontralEntitlements, migrateMontralMetering } from "./montral-metering";

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
    description: "Inspect captured webhook requests for an inbox in this Montral project, newest first, 50 per page; may contain sensitive request bodies. Pass the returned next as before for older events (a 410 means that page was evicted: start again). Optionally filter by method or search text in headers, content type and body. Never disclose event bodies to unauthorized third parties.",
    schema: z.object({
      id,
      before: z.string().uuid().optional().describe("The next value from the previous page."),
      method: z.enum(["POST", "PUT", "PATCH"]).optional(),
      q: z.string().max(200).optional().describe("Text to search for; wildcards are literal."),
    }),
    readOnly: true,
    build: ({ id, ...filter }) => {
      const qs = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")).toString();
      return { method: "GET", path: `/api/hooks/inboxes/${id}/events${qs ? "?" + qs : ""}` };
    },
  },
  {
    name: "delete_webhook_event",
    description: "Permanently remove one captured webhook request from an inbox. Requires manager role.",
    schema: z.object({ id, eventId: z.string().uuid().describe("Captured event UUID from list_webhook_events.") }),
    destructive: true,
    idempotent: true,
    build: (a) => ({ method: "DELETE", path: `/api/hooks/inboxes/${a.id}/events/${a.eventId}` }),
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

/** Montral edition: billing and metering are both disabled by default. Only test merchant integration is supported. */
export const montralEdition: Edition = {
  id: "montral",
  entitlements: ({ database, env }) => createMontralEntitlements(database, env),
  mount: ({ app, authed }) => {
    mountMontralHooks({ app, authed });
    mountMontralBilling({ app, authed });
  },
  migrate: async (db) => [...(await migrateMontralHooks(db)), ...(await migrateMontralBilling(db)), ...(await migrateMontralMetering(db))],
  mcpTools: MONTRAL_TOOLS,
};
