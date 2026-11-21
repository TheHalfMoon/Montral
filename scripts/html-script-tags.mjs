const isTagBoundary = (character) =>
  character === ">" || character === "/" || character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";

/** Return HTML script start attributes and body, including case-insensitive tag spelling and end-tag attributes. */
export function scriptTags(html) {
  const lower = html.toLowerCase();
  const tags = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = lower.indexOf("<script", cursor);
    if (start < 0) break;
    const afterName = start + 7;
    if (!isTagBoundary(lower[afterName] ?? "")) { cursor = afterName; continue; }
    const openEnd = lower.indexOf(">", afterName);
    if (openEnd < 0) break;
    let close = lower.indexOf("</script", openEnd + 1);
    while (close >= 0 && !isTagBoundary(lower[close + 8] ?? "")) close = lower.indexOf("</script", close + 8);
    if (close < 0) break;
    const closeEnd = lower.indexOf(">", close + 8);
    if (closeEnd < 0) break;
    tags.push([html.slice(start, closeEnd + 1), html.slice(afterName, openEnd), html.slice(openEnd + 1, close)]);
    cursor = closeEnd + 1;
  }
  return tags;
}
