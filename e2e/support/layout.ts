// Layout-shift guards shared by the specs. The same helper as the signed-in journey's in PR #84; once both are on main
// the journey can import it from here.
import { expect, type Locator } from "@playwright/test";

/** Vertical position of a control right now (NaN when it has no box). */
export async function topOf(target: Locator): Promise<number> {
  return (await target.boundingBox())?.y ?? Number.NaN;
}

/**
 * Asserts a control stays where it was first painted until the page is idle: content that appears late above it (the
 * email verification bar, the usage banner, a checklist) would move it under a click already on its way.
 */
export async function expectNoLayoutShift(target: Locator, painted?: number) {
  await expect(target).toBeVisible();
  const first = painted ?? (await topOf(target));
  await target.page().waitForLoadState("networkidle");
  // vertical position only, to the pixel: content inserted above moves it down; a scrollbar or font swap does not count
  expect(Math.abs((await topOf(target)) - first), "the control moved down after it was painted (layout shift)").toBeLessThanOrEqual(1);
}

/** Clicks a control only after showing it stays where it was first painted. */
export async function clickWithoutLayoutShift(target: Locator) {
  await expectNoLayoutShift(target);
  await target.click();
}
