/**
 * Encryption at rest for SSO client secrets. AES-256-GCM (WebCrypto, so it runs on Node and Workers alike) with a key
 * derived by HKDF-SHA-256 from BETTER_AUTH_SECRET for this one purpose. The connection id is the additional
 * authenticated data: a ciphertext copied into another workspace's row does not decrypt. Rotating BETTER_AUTH_SECRET
 * makes stored secrets unreadable, so owners re-enter them (the sign-in then fails closed with a clear error).
 *
 * Format: `v1.<iv base64url>.<ciphertext+tag base64url>`.
 */

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export class SecretUnreadable extends Error {
  constructor() {
    super("The stored client secret cannot be decrypted (was BETTER_AUTH_SECRET changed?). Enter the client secret again.");
    this.name = "SecretUnreadable";
  }
}

async function key(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new Error("BETTER_AUTH_SECRET must be set (at least 16 characters) to store SSO secrets");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("montral-sso-client-secret"), info: enc.encode("v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(serverSecret: string, connectionId: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(connectionId) }, await key(serverSecret), enc.encode(plaintext)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptSecret(serverSecret: string, connectionId: string, stored: string): Promise<string> {
  const [v, iv, ct, ...rest] = stored.split(".");
  if (v !== "v1" || !iv || !ct || rest.length) throw new SecretUnreadable();
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv), additionalData: enc.encode(connectionId) }, await key(serverSecret), unb64url(ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new SecretUnreadable();
  }
}
