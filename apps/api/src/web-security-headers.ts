import type { ServerResponse } from "node:http";

/**
 * Baseline headers for the web build served by the self-hosted Node process.
 * The policy restricts framing, <base>, plugins and form targets; it does not
 * restrict scripts or styles, because the static pages carry inline scripts
 * and optional analytics/fonts that a script policy would break.
 * Public status pages stay frameable so operators can show them in their own
 * dashboards; everything else (app, sign-in, reset links) refuses framing.
 */
export function webSecurityHeaders(path: string): Record<string, string> {
  const frameable = /^\/(?:[a-z]{2}(?:-[A-Za-z]+)?\/)?status(?:\/|$)/.test(path);
  return {
    "content-security-policy": `base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors ${frameable ? "*" : "'none'"}`,
    ...(frameable ? {} : { "x-frame-options": "DENY" }),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

/** Sets the headers unless a handler already chose its own value (e.g. a stricter referrer policy). */
export function applyWebSecurityHeaders(url: string | undefined, res: ServerResponse): void {
  const path = (url ?? "/").split("?")[0];
  for (const [name, value] of Object.entries(webSecurityHeaders(path))) {
    if (!res.hasHeader(name)) res.setHeader(name, value);
  }
}
