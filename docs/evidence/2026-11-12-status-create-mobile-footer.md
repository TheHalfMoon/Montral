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
