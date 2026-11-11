import { HTTPException } from "hono/http-exception";

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

/** The request body within the byte and time budget; null when there is none. */
async function limitedBodyBytes(request: Request, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null> {
  const header = request.headers.get("content-length");
  if (header && /^\d+$/.test(header) && Number(header) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new HTTPException(413, { message: "Payload too large" });
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HTTPException(408, { message: "Request body read timed out" })), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { completed = true; break; }
      if (value.byteLength > maxBytes - total) throw new HTTPException(413, { message: "Payload too large" });
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Uncooperative peer cancellation must not delay size/time refusals.
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
