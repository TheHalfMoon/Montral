// Montral Threshold brand assets, generated from one geometry so every size stays in proportion.
//   node apps/web/scripts/gen-brand.mjs          write the SVG marks and favicon (no browser needed)
//   node apps/web/scripts/gen-brand.mjs --png    also render the PNG icons and og.png with Playwright
// The PNG step uses the e2e workspace's Playwright. It drives the system Edge or Chrome when one is installed
// (BRAND_BROWSER_CHANNEL=msedge|chrome) and otherwise Playwright's own Chromium. Outputs are committed; CI does not run this.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = join(WEB, "public");
const REPO = join(WEB, "..", "..");

const INK = "#171713", SIGNAL = "#F04D35", PAPER = "#F5F2EB", SURFACE = "#FFFDF8";

// The mark: a horizontal bar (the steady state) and a smaller square offset above its right end (the signal that
// crossed the threshold). Units are the 130 x 85 master grid. `small` thickens the bar and enlarges the square for
// 32 px and below, where the master proportions would blur.
function mark({ bar = INK, square = SIGNAL, small = false } = {}) {
  const b = small ? { y: 52, h: 33 } : { y: 58, h: 27 };
  const s = small ? { x: 86, size: 42 } : { x: 92, size: 36 };
  return `<rect x="0" y="${b.y}" width="130" height="${b.h}" rx="2" fill="${bar}"/><rect x="${s.x}" y="0" width="${s.size}" height="${s.size}" rx="2" fill="${square}"/>`;
}
const markSvg = (o, label = "Montral") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 85" role="img" aria-label="${label}">${mark(o)}</svg>\n`;

// An app icon: the mark centred on a tile. `inset` is the share of the tile width the mark spans.
function iconSvg({ size = 128, bg = INK, radius = 0.22, inset = 0.56, bar = SURFACE, square = SIGNAL, small = false } = {}) {
  const w = size * inset, h = (w * 85) / 130, x = (size - w) / 2, y = (size - h) / 2 + size * 0.01;
  const r = radius ? `rx="${(size * radius).toFixed(2)}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Montral">` +
    `<rect width="${size}" height="${size}" ${r} fill="${bg}"/>` +
    `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" viewBox="0 0 130 85">${mark({ bar, square, small })}</svg></svg>\n`;
}

mkdirSync(join(PUB, "brand"), { recursive: true });
const svgs = {
  "brand/mark.svg": markSvg({}),
  "brand/mark-reversed.svg": markSvg({ bar: SURFACE }),
  "brand/mark-mono.svg": markSvg({ square: INK }),
  "brand/mark-mono-reversed.svg": markSvg({ bar: SURFACE, square: SURFACE }),
  "brand/icon.svg": iconSvg({ size: 512 }),
  // favicons render at 16-32 px: optically corrected mark, slightly larger in the tile
  "favicon.svg": iconSvg({ size: 128, radius: 0.22, inset: 0.66, small: true }),
};
for (const [file, svg] of Object.entries(svgs)) writeFileSync(join(PUB, file), svg);
console.log("brand svg:", Object.keys(svgs).join(", "));

if (process.argv.includes("--png")) {
  const pw = await import(pathToFileURL(join(REPO, "e2e", "node_modules", "@playwright", "test", "index.mjs")).href);
  const channel = process.env.BRAND_BROWSER_CHANNEL;
  let browser;
  for (const opt of channel ? [{ channel }] : [{ channel: "msedge" }, { channel: "chrome" }, {}]) {
    try { browser = await pw.chromium.launch(opt); break; } catch { /* try the next browser */ }
  }
  if (!browser) throw new Error("no Chromium-family browser available for PNG rendering");
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function png(svg, size, out) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: join(PUB, out), omitBackground: true });
  }
  await png(iconSvg({ size: 180, radius: 0, inset: 0.56 }), 180, "apple-touch-icon.png");
  // e-mail header logo (apps/api/src/email.ts shows it at 26 px; 2x for sharp mail clients)
  await png(iconSvg({ size: 52, radius: 0.22, inset: 0.64, small: true }), 52, "logo-mark.png");
  await png(iconSvg({ size: 192 }), 192, "icons/pwa-192.png");
  await png(iconSvg({ size: 512 }), 512, "icons/pwa-512.png");
  // maskable: full-bleed tile, mark inside the 80 % safe zone
  await png(iconSvg({ size: 512, radius: 0, inset: 0.46 }), 512, "icons/pwa-maskable-512.png");
  // Open Graph card, from design/og.html (self-hosted fonts, relative paths)
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(pathToFileURL(join(WEB, "design", "og.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(PUB, "og.png") });
  await browser.close();
  console.log("brand png: apple-touch-icon.png, logo-mark.png, icons/pwa-192.png, icons/pwa-512.png, icons/pwa-maskable-512.png, og.png");
}
