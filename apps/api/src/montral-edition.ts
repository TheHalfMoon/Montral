import type { Edition } from "./edition";
import type { Tool } from "@montral/mcp-rest";
import { z } from "zod";

import { migrateMontralHooks, mountMontralHooks } from "./montral-hooks";
import { RESPONSE_CONTENT_TYPES } from "./montral-hook-response";
import { migrateMontralBilling, mountMontralBilling } from "./montral-billing";
import { createMontralEntitlements, migrateMontralMetering } from "./montral-metering";

const id = z.string().uuid().describe("Montral webhook inbox UUID.");
// The REST route validates fully (header deny-list, size caps, location rules); this shape only guides agents.
const responseVariantShape = {
  status: z.number().int().min(200).max(599).optional().describe("HTTP status, 200-599 (default 200)."),
  contentType: z.enum(RESPONSE_CONTENT_TYPES).optional().describe("Body type (default text/plain); charset=utf-8 is added."),
  body: z.string().max(65_536).optional().describe("Response body text; must be empty for 204, 205 and 304."),
  headers: z.array(z.object({ name: z.string().min(1).max(64), value: z.string().max(1024) }).strict()).max(20).optional()
    .describe("Custom headers. Names are HTTP tokens; values printable ASCII without line breaks."),
  location: z.string().max(2048).optional().describe("Absolute http(s) URL, only with a 3xx status."),
};
const responseVariant = z.object(responseVariantShape).strict();
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
    name: "get_webhook_response",
    description: "Read what an inbox's secret receiver answers to captured requests: status, content type, body, custom headers, optional redirect location, delay and per-method overrides. null means the default 202 {\"received\":true}. Requires manager role.",
    schema: z.object({ id }),
    readOnly: true,
    build: (a) => ({ method: "GET", path: `/api/hooks/inboxes/${a.id}/response` }),
  },
  {
    name: "set_webhook_response",
    description: "Configure what an inbox's secret receiver answers (webhook.site-style custom responses), replacing any previous configuration. Status 200-599; a 3xx may carry an absolute http(s) location. Body is text up to 64 KiB (all variants together) served as text/plain, application/json, application/xml, text/xml or text/csv; HTML is not supported. Up to 20 custom headers; cookies, CORS, caching, security-policy, framing and hop-by-hop headers are refused. delayMs waits up to 10000 ms before answering. methods overrides the response for POST, PUT or PATCH. Refusals (invalid token, oversized, malformed, rate-limited) and replay never use it. Requires manager role.",
    schema: z.object({
      id,
      ...responseVariantShape,
      delayMs: z.number().int().min(0).max(10_000).optional().describe("Milliseconds to wait before answering, 0-10000."),
      methods: z.object({ POST: responseVariant.optional(), PUT: responseVariant.optional(), PATCH: responseVariant.optional() }).strict().optional()
        .describe("Per-method overrides; a method without one uses the top-level response."),
    }),
    idempotent: true,
    build: ({ id, ...config }) => ({ method: "PUT", path: `/api/hooks/inboxes/${id}/response`, body: config }),
  },
  {
    name: "reset_webhook_response",
    description: "Remove an inbox's custom response so its receiver answers the default 202 {\"received\":true} again. Captured events are kept. Requires manager role.",
    schema: z.object({ id }),
    idempotent: true,
    build: (a) => ({ method: "DELETE", path: `/api/hooks/inboxes/${a.id}/response` }),
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
