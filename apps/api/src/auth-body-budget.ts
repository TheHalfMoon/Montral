/** Max body accepted before extracting an email for DB-backed authentication quotas. */
const AUTH_EMAIL_BODY_MAX_BYTES = 16 * 1024;
type AuthBodyResult = { oversized: true } | { oversized: false; email?: unknown };

/** Bound even chunked/incorrect-content-length client bodies. A clone keeps the
 * original bytes available for Better Auth on successful requests. */
export async function limitedAuthBody(request: Request): Promise<AuthBodyResult> {
  const header = request.headers.get("content-length");
  if (header && /^\d+$/.test(header) && Number(header) > AUTH_EMAIL_BODY_MAX_BYTES) {
    void request.body?.cancel().catch(() => {});
    return { oversized: true };
  }
  if (!request.body) return { oversized: false };
  const reader = request.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > AUTH_EMAIL_BODY_MAX_BYTES - count) {
        void reader.cancel().catch(() => {});
        void request.body?.cancel().catch(() => {});
        return { oversized: true };
      }
      count += value.byteLength;
      chunks.push(value);
    }
  } finally {
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
