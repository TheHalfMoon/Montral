# Status-page Create action on mobile (2026-11-12)

## Regression and exact-head evidence

Cross-browser GitHub Actions run [43121817419](https://github.com/TheHalfMoon/Montral/actions/runs/43121817419) at PR #90 head `efa1e90` passed 59 of 60 browser tests. The sole failure was the `mobile-chromium` signed-in journey: Playwright's real Create click was intercepted by the focused Slug input, even though a prior element-from-point check had passed. The failure was a layout/pointer-action defect, not a failed API request.

## Change

- Keep the modal's action row outside the scrollable fields instead of letting the Slug input and action buttons share one scrolling flex area.
- Use border-box sizing and a viewport-bounded form with a separate, scrollable fields region and a non-shrinking footer.
- Extend the signed-in Playwright journey with a `click({ trial: true })` prior to the actual click. This checks the same scroll and pointer interception behavior without submitting or using a force click.

## Local independent smoke test

A temporary, isolated Edge/Chromium harness loaded the **actual** `apps/web/src/styles/global.css` against representative form markup and focused the Title and Slug fields. On each viewport, the Create button remained inside the viewport, was hit-testable, passed Playwright's trial click, and submitted once with a real click:

- 320 x 568: PASS
- 375 x 667: PASS
- 393 x 852: PASS
- 800 x 600: PASS
- 1280 x 800: PASS

The temporary harness is outside the repository. These checks are not a substitute for the real database-backed, multi-browser GitHub Actions journey. Requalify the full matrix on the exact fix commit before merging.

No production deployment, paid services, secrets, private commercial configuration or release publication were changed.

## Follow-up after Linux mobile Chromium failure at `d020eef`

Hosted [cross-browser run 43123706767](https://github.com/TheHalfMoon/Montral/actions/runs/43123706767) still found 59/60 passed. The same mobile Chromium Create action failed in Playwright's **trial click**, so an earlier `document.elementFromPoint` check alone was insufficient. The retained trace shows an action target close to the bottom of a Pixel 7 viewport, at `y=796` or `819` (viewport `412×839`), and the focused Slug input repeatedly intercepted the action after auto-scroll.

The new fix limits the change to this status-page Create dialog: it centers the short form instead of placing its actions at the mobile viewport's bottom edge. The controls remain in a separately scrollable field area, and Cancel/Create remain outside that scroll area. The real multi-browser E2E now asserts a clearance of more than 48 CSS pixels below Create on mobile, **before** the trial and real click; no force click, artificial blur, skipped project, or retry was introduced.

A fresh isolated Microsoft Edge Playwright smoke test, using the actual stylesheet, a mobile touch context at Pixel 7's `412×839` viewport, and representative form markup, passed hit-test, trial click and one real form submission at each of: `412×839`, `320×568`, `375×667`, `393×852`, `800×600`, `1280×800`. On `412×839`, the Create button was at `y=518–558`, leaving ~281 CSS pixels to the bottom. This isolated test is indicative but does not replace the exact-head Linux Chromium CI journey.
