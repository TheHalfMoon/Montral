/**
 * Per-monitor secrets for browser checks (the values `fill` steps type into password fields and the like).
 *
 * Stored encrypted in `monitor.browser_secrets` as name -> "v1.<iv>.<ciphertext+tag>" (AES-256-GCM, base64url). The key
 * is derived from BETTER_AUTH_SECRET with HKDF-SHA-256 and a fixed, purpose-specific info string, so it is never the
 * session-signing key itself. The workspace id, the monitor id and the secret's name are bound in as additional authenticated data: a
 * ciphertext copied to another workspace, another monitor or renamed does not decrypt.
 *
 * Values are write-only through the API: responses carry the mask for every name, to every role. They are decrypted
 * only by the check runner, right before a run, and handed to the isolated worker over its stdin pipe (never argv or
 * the environment, which other local processes can read).
 *
 * Rotating BETTER_AUTH_SECRET makes stored values undecryptable: such a run fails with "secret is not set" and the
 * secret has to be entered again (documented in /docs/self-host).
 */
import { MASK } from "./secrets";

const INFO = new TextEncoder().encode("montral:browser-check-secrets:v1");
const SALT = new TextEncoder().encode("montral-browser-secrets");
const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT, info: INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    if (keys.size > 4) keys.clear();
    keys.set(secret, k);
  }
  return k;
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const aad = (orgId: string, monitorId: string, name: string) => new TextEncoder().encode(`montral:browser-secret:v2:${orgId}:${monitorId}:${name}`);

export async function encryptSecret(authSecret: string, orgId: string, monitorId: string, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(orgId, monitorId, name) }, await key(authSecret), new TextEncoder().encode(value)));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

/** The plaintext, or null when the value cannot be decrypted (another key, another workspace, tampered). */
export async function decryptSecret(authSecret: string, orgId: string, monitorId: string, name: string, stored: string): Promise<string | null> {
  const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/.exec(stored);
  if (!m) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(m[1]), additionalData: aad(orgId, monitorId, name) }, await key(authSecret), fromB64u(m[2]));
    return new TextDecoder("utf-8", { fatal: true }).decode(pt);
  } catch {
    return null;
  }
}

/**
 * The stored map after applying an update from the API: a plaintext value is encrypted, the mask keeps what is stored
 * under that name, null removes it. Names not in `incoming` are removed too (the map is replaced as a whole, like
 * headers), so `{}` clears every secret.
 */
export async function applySecretUpdate(authSecret: string, orgId: string, monitorId: string, incoming: Record<string, string | null>, stored: Record<string, string> | null | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === null) continue;
    if (value === MASK) {
      if (stored?.[name] !== undefined) out[name] = stored[name];
      continue;
    }
    out[name] = await encryptSecret(authSecret, orgId, monitorId, name, value);
  }
  return out;
}

/** What the API shows: every name with the mask, never a value or ciphertext. */
export const maskedSecrets = (stored: Record<string, string> | null | undefined) => Object.fromEntries(Object.keys(stored ?? {}).sort().map((k) => [k, MASK]));

/** Decrypts the secrets a run needs; a name that cannot be decrypted is left out (the step then fails as "not set"). */
export async function decryptForRun(authSecret: string, orgId: string, monitorId: string, stored: Record<string, string> | null | undefined, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = stored?.[n];
    if (v === undefined) continue;
    const pt = await decryptSecret(authSecret, orgId, monitorId, n, v);
    if (pt !== null) out[n] = pt;
  }
  return out;
}
