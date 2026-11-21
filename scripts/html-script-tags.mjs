/** Return HTML script start attributes and body, including HTML's case-insensitive tag spelling. */
export function scriptTags(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
}
