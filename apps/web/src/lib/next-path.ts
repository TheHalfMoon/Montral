/** Keep an internal destination unchanged; reject characters the browser may normalize before navigating. */
export function internalPath(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(path) ? path : "/app";
}

/** Where to go after signing in: only same-site paths, so the `next` parameter cannot be used as an open redirect. */
export function nextPath(search: string): string {
  const n = new URLSearchParams(search).get("next") ?? "";
  return internalPath(n);
}
