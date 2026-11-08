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

/**
 * Called before the static/SSR handlers run, so these are defaults: a handler
 * that sets the same header later (for example a stricter referrer policy)
 * replaces the value.
 */
export function applyWebSecurityHeaders(url: string | undefined, res: ServerResponse): void {
  const path = (url ?? "/").split("?")[0];
  for (const [name, value] of Object.entries(webSecurityHeaders(path))) res.setHeader(name, value);
}
