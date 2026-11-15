# App shell command menu and accessible dialogs (2026-11-14)

PR #128 (`design/montral-app-shell-20261114`) and PR #129 (`design/montral-dialogs-20261114`, stacked on #128).

## What changed

- **#128.**
  - A Cmd/Ctrl+K command menu (`components/CommandMenu.tsx`): pages taken from the rendered sidebar, so edition gating carries over; monitors and open incidents from `GET /api/monitors` and `GET /api/incidents`; theme, docs and sign-out actions.
  - An Ink sidebar in both themes, set through scoped tokens.
  - Shared `.st` status shapes.
  - The Monitors search shortcut moves to `/`.
- **#129.**
  - `components/Modal.tsx`: dialog role, focus trap, Escape, backdrop and focus return.
  - `lib/confirm.ts` + `components/ConfirmHost.tsx`: `ask(body, confirmLabel)`.
  - Seven hand-built dialogs and 21 native `confirm()` calls converted.

## Independent review

A reviewer read both diffs without editing them. Resolution:

| Severity | Finding | Resolution |
|---|---|---|
| High | Escape inside a dropdown in a dialog closed the whole dialog (document capture listener + `stopPropagation`), also during IME composition | Keys handled on the dialog in the bubbling phase; `Select` consumes Escape while its list is open; composition (`isComposing`, keyCode 229) ignored |
| High | Cmd/Ctrl+K over an open dialog fought it for Escape and Tab | Command menu and `/` shortcut stand down while a `.modal` is open; each dialog only handles keys from inside itself |
| Medium | Focus not returned to the opener when a child had `autoFocus` | Opener captured during render; falls back to `#main-content` when the opener is gone |
| Medium | Confirmation read only "Are you sure?" to screen readers | `aria-describedby` points at the question |
| Medium | Dialogs layered under the mobile drawer (35 vs 40) | `--z-modal` 50, `.modal` uses the token |
| Medium | Mobile bottom sheet no longer full width | `.modal-box` spans the width |
| Low | Escape/backdrop closed dialogs during a request | `busy` passed for Alerting, ApiKeys, Team, Incidents, StatusPages |
| Low | Incidents failure discarded monitors; empty listbox; groups not announced; focus left on removed node after non-navigating actions; `--bg` not re-scoped in the sidebar | `Promise.allSettled`; listbox only with results; `role="group"` with headings; focus restored first; `--bg` scoped |

## Verification (local, built Node app, system Edge, synthetic API fixtures)

- Command menu, 14/14:
  - focus in the combobox;
  - search finds the monitor and INC-7;
  - monitors still listed when incidents fail, with a note;
  - axe clean with results and when empty (no listbox);
  - Escape closes and returns focus to the sidebar button;
  - no page errors.
- Dialogs, 13/13:
  - the monitor form is named by its heading;
  - Escape in an open dropdown closes only the list;
  - a backdrop click does not close the long form;
  - axe on the dialog is clean;
  - a second Escape closes it and focus returns to "New monitor";
  - the confirmation is described by its question, with Cancel focused first;
  - Tab then Enter confirms, and focus returns;
  - IME-composition Escape is ignored, and a plain Escape answers no.
- `astro check` 0 errors; web unit tests 189/189 (including `lib/confirm.test.ts`); build and CSP hash check pass.

The Playwright/axe matrix and PostgreSQL suites run in each PR's CI.
