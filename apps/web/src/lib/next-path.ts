/** Keep an internal destination unchanged; reject characters the browser may normalize before navigating. */
export function internalPath(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(path) ? path : "/app";
}

/**
 * Only a genuine invitation-return destination should advertise the sign-up
 * page while public registration is closed. This is a UI hint, not an
 * invitation/authorization check: the server still checks the invited email.
 */
export function invitationReturn(search: string): boolean {
  const requested = new URLSearchParams(search).get("next");
  return requested !== null && /^\/(?:(?:zh-Hans|ja|es)\/)?accept-invite\/[A-Za-z0-9_-]{1,128}$/.test(internalPath(requested));
}

/** Show the registration link only for open registration or an explicit invitation return. */
export function offerSignupLink(signupOpen: boolean | null, search: string): boolean {
  return signupOpen === true || invitationReturn(search);
}

/** Where to go after signing in: only same-site paths, so the `next` parameter cannot be used as an open redirect. */
export function nextPath(search: string): string {
  const n = new URLSearchParams(search).get("next") ?? "";
  return internalPath(n);
}
