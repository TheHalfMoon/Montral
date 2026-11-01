/** Max body accepted before extracting an email for DB-backed authentication quotas. */
const AUTH_EMAIL_BODY_MAX_BYTES = 16 * 1024;
const AUTH_EMAIL_BODY_READ_MS = 10_000;
export class AuthBodyTimeoutError extends Error {
  constructor() { super("Authentication body read timeout"); }
}
type AuthBodyResult = { oversized: true } | { oversized: false; email?: unknown };

/** Bound even chunked/incorrect-content-length client bodies. A clone keeps the
 * original bytes available for Better Auth on successful requests. */
export async function limitedAuthBody(request: Request, timeoutMs = AUTH_EMAIL_BODY_READ_MS): Promise<AuthBodyResult> {
  const header = request.headers.get("content-length");
  if (header && /^\d+$/.test(header) && Number(header) > AUTH_EMAIL_BODY_MAX_BYTES) {
    void request.body?.cancel().catch(() => {});
    return { oversized: true };
  }
  if (!request.body) return { oversized: false };
  const reader = request.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One deadline for the whole stream: dribbling bytes cannot reset it.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthBodyTimeoutError()), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { completed = true; break; }
      if (value.byteLength > AUTH_EMAIL_BODY_MAX_BYTES - count) return { oversized: true };
      count += value.byteLength;
      chunks.push(value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!completed) {
      // Cloned stream cancellation may itself stall. Neither branch may block
      // the HTTP timeout/size refusal; the original body remains unmodified on success.
      void reader.cancel().catch(() => {});
      void request.body?.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let email: unknown;
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { email?: unknown } | null;
    email = data?.email;
  } catch { /* Let the auth provider handle invalid JSON as before. */ }
  return { oversized: false, email };
}
