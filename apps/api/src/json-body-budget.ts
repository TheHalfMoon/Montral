import { HTTPException } from "hono/http-exception";
import { limitedBodyBytes } from "@montral/mcp-rest/body-budget";
export { limitedBodyBytes } from "@montral/mcp-rest/body-budget";

/**
 * Read a small or bulk API JSON request within a strict byte and elapsed-time
 * budget, regardless of claimed Content-Length or chunk pacing.
 *
 * Consume the original stream once, rather than cloning it: an abandoned
 * cloned branch can otherwise buffer an unbounded amount of request data.
 * Malformed/empty JSON stays null so route-specific validators determine
 * their existing 400 response and no credentials/body are ever logged.
 */
export async function limitedJsonBody(request: Request, maxBytes: number, timeoutMs = 10_000): Promise<unknown> {
  const bytes = await limitedBodyBytes(request, maxBytes, timeoutMs);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { return null; }
}

/**
 * Like `limitedJsonBody`, for routes that must not treat a malformed body as an empty one (operator writes): an empty
 * body is `{}`, anything that is not a JSON object is a 400. Size and time limits are the same (413, 408).
 */
export async function strictJsonObjectBody(request: Request, maxBytes: number, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const bytes = await limitedBodyBytes(request, maxBytes, timeoutMs);
  if (!bytes || bytes.byteLength === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HTTPException(400, { message: "Request body must be a JSON object" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HTTPException(400, { message: "Request body must be a JSON object" });
  return parsed as Record<string, unknown>;
}
