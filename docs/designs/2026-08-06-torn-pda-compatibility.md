# Torn PDA compatibility — implementation plan

> **STATUS: IMPLEMENTED — QA PASSED (2026-08-06).** Automated verification
> passes on `fix/torn-pda-compatibility`, and the signed-in Torn PDA and desktop
> gates below were walked manually. Awaiting a version bump and release.

**Goal:** Make the Education Scheduler appear reliably in Torn PDA while
preserving its current desktop behavior, calculations, stored plans, security
surface, and SPA-navigation safeguards.

**Current release:** 1.1.0.

**Live implementation finding:** The original no-panel failure occurred before
bootstrap. Torn PDA's `UserScriptsProvider.adaptSource` replaces typographic
quotation marks throughout a script before injection; curly apostrophes inside
single-quoted strings became invalid JavaScript. The implementation now uses
ASCII-only quotes and tests the exact Torn PDA transformation. The lifecycle
work below remains useful defensive hardening, but injection timing was not the
root cause observed on the device.

**Architecture:** Treat PDA compatibility as a runtime-shell concern. Inject at
`document-end`, wait explicitly for a usable DOM, mount a visible loading shell
before data acquisition, and retain the existing endpoint-then-React-fiber
acquisition order. Continue using the current idempotent SPA bootstrap and the
owned fixed-position fallback when Torn has no known education mount.

**Evidence:** The implementation direction was checked against current
PDA-compatible Torn userscripts and the sibling Bookie project:

- [BUSTR](https://greasyfork.org/en/scripts/480750-bustr-busting-reminder-pda/code)
  uses `document-end`, waits for PDA/browser readiness, and polls for its mount.
- [Torn Gym Ratios](https://greasyfork.org/en/scripts/549686-torn-gym-ratios-pda-compatible/code)
  uses `document-end`, a bounded element wait, and slower PDA polling.
- [GymIQ](https://greasyfork.org/en/scripts/568580-gymiq/code) recommends END
  injection for TornPDA, retries host/data discovery, and observes SPA changes.
- [Bazaars in Item Market](https://greasyfork.org/en/scripts/527616-bazaars-in-item-market-powered-by-tornw3b/code)
  processes the current DOM and then observes for replacements.
- `X:\Projects\Torn Bookie Live Scores\Torn_Bookie_Live_Scores.js` explicitly
  waits for `document.body` and renders a waiting shell. Its `document-start`
  setting is not copied: Bookie needs to intercept Torn's early requests, while
  this scheduler does not.
- Android InAppWebView documents that document-start injection may only happen
  as early as the platform permits. The script must therefore tolerate DOM
  readiness variance instead of assuming an injection timestamp guarantees a
  particular tree state.

## Verified failure shape

The current metadata uses `document-idle`. Changing that value alone cannot
repair all observed paths:

1. `observeNavigation()` installs its `MutationObserver` only when
   `document.documentElement` already exists. It still marks navigation as
   installed when the root is absent, so it does not later retry the observer.
2. `init()` awaits `acquireEducationData()` before it resolves a mount or draws
   anything. A delayed or never-settling request is indistinguishable from the
   script not running.
3. A script evaluated before the PDA DOM exists can remain invisible until a
   later history, popstate, or mutation signal happens.
4. The fixed fallback has desktop-oriented positioning but no explicit viewport
   width or dynamic-viewport height constraints.

A local PDA-shaped harness reproduced item 3: no panel appeared when `body` and
`documentElement` were added after evaluation without a navigation signal; an
artificial `popstate` then mounted it.

## Non-regression contract

The implementation must not change any of these:

- Scheduling, prerequisites, ordering, focus scoring, finish dates, booster
  calculations, formatting, or catalogue parsing.
- The `tes:plan` and `tes:settings` keys or either stored-data shape.
- GM storage semantics. Do not add a `localStorage` fallback unless separate
  on-device evidence proves the installed Torn PDA version lacks the granted GM
  APIs; page-readable storage would weaken isolation.
- The same-origin `educationInitData` endpoint, its request headers, or its
  `rfcv` handling.
- Endpoint-first, React-fiber-second acquisition precedence.
- The exact security surface: one existing `@match`, exactly `GM_getValue` and
  `GM_setValue`, and no `@connect`.
- Existing stale-render protection, single-flight acquisition, route-leave
  cleanup, remount behavior, and duplicate-fallback prevention.
- Desktop inline mounting when Torn's known education container is present.
- Existing panel views, controls, copy, event handlers, and visual tokens.
- `MAX_MOUNT_ATTEMPTS` behavior. Its lifetime-counter limitation is already
  recorded in the code and is a separate repair; changing retry policy here
  would enlarge the regression surface.

The only intended behavior changes are:

- TornPDA should install the script with injection time END.
- A loading panel becomes visible before education data finishes loading.
- A hung endpoint eventually falls through to the existing fiber path and then
  to the existing visible failure state.
- The owned fallback fits a narrow/dynamic mobile viewport.

## Files in scope

| File | Planned responsibility |
| --- | --- |
| `torn-education-scheduler.user.js` | Metadata, route guard, DOM-ready bootstrap, loading-first initialization, bounded endpoint wait, fallback responsiveness |
| `tests/metadata.test.js` | Exact `document-end` and host/path/query route contract |
| `tests/load-userscript.js` | Controllable DOM readiness, listeners and timers for lifecycle tests |
| `tests/navigation.test.js` | Early/late PDA injection, loading shell, SPA and stale-render regressions |
| `tests/adapter.test.js` | Timeout result, timer cleanup, pre-timeout behavior and credential redaction |
| `tests/panel.test.js` | Loading model/shell and final redraw behavior |
| `tests/style.test.js` | Narrow viewport, overflow, dynamic height and unchanged token rules |
| `docs/architecture.md` | Runtime startup and loading-first lifecycle after implementation |
| `docs/qa-checklist.md` | TornPDA and desktop manual regression matrix |
| `docs/code-map.md` | Carefully shifted runtime anchors and updated test inventory |
| `CHANGELOG.md` | PDA compatibility under Unreleased after implementation; no version bump |

No other file is in scope without stopping to amend this plan.

## Task 1 — Pin the compatibility contract in tests

**Symbols:** metadata block, `isEducationPage`, test sandbox location

- [ ] Extend the metadata test to require exactly `@run-at document-end`.
- [ ] Keep the existing exact assertions for `@match`, `@grant`, and absent
  `@connect`, `@downloadURL`, and `@updateURL`.
- [ ] Expand the route-guard table to cover:
  - `https://www.torn.com/page.php?sid=education` — accepted;
  - the same URL with unrelated parameters before or after `sid` — accepted;
  - `educationInitData`, a substring such as `education-extra`, and missing
    `sid` — rejected;
  - another Torn path — rejected;
  - another hostname, including a suffix/spoof hostname — rejected;
  - a missing or hostile `location` object — rejected without throwing.
- [ ] Make the sandbox's default `location` a complete Torn education URL and
  merge per-test overrides field by field, so existing tests that override only
  `search` retain valid host/path defaults.
- [ ] Run `node --test tests/metadata.test.js` and prove the new injection test
  fails against the current `document-idle` metadata before implementation.

## Task 2 — Start only after a usable DOM exists

**Symbols:** `observeNavigation`, bootstrap call site, new readiness helper

- [ ] Add a small runtime helper that invokes its callback once when both
  `document.documentElement` and `document.body` are usable.
- [ ] Resolve immediately when they already exist.
- [ ] Otherwise listen for `DOMContentLoaded` and `load`, plus a short bounded
  poll for webviews that inject after those events have already fired.
- [ ] Clean up listeners and the polling timer after success or terminal
  timeout. Duplicate readiness signals must remain a no-op.
- [ ] Install `observeNavigation()` only after the observation root exists, then
  call `syncToRoute()` once for the route already on screen.
- [ ] Do not set `NAV_INSTALLED_FLAG` for an observer installation that has not
  actually reached the ready bootstrap.
- [ ] Preserve the existing history wrappers, `popstate`, mutation debounce,
  single-install behavior, and disconnect semantics.

Tests written first:

- [ ] `body` and `documentElement` absent at evaluation, added later, no route
  event: exactly one initial mount occurs.
- [ ] DOM already complete: bootstrap remains synchronous up to the existing
  asynchronous acquisition boundary.
- [ ] Script injected after `DOMContentLoaded`/`load`: polling still starts it.
- [ ] `DOMContentLoaded`, `load`, and poll all fire: one observer and one mount.
- [ ] DOM never becomes usable: no throw, request, panel, or unbounded timer.
- [ ] Existing direct-load, sidebar `pushState`, `replaceState`, `popstate`, and
  mutation-only navigation tests continue to pass unchanged in meaning.

## Task 3 — Draw the shell before acquiring data

**Symbols:** `init`, `errorModel`, `renderPanel`, mount resolution

- [ ] Resolve or create the mount before awaiting network/fiber acquisition.
- [ ] Add a complete loading model compatible with `renderPanel()`'s existing
  field contract. It must visibly say that education data is loading.
- [ ] Render the loading shell with `noopHandlers`; do not expose controls that
  look actionable before their data and real handlers exist.
- [ ] Load the plan and settings exactly once per `init()` and use the same
  values for the final model; loading must not write either storage key.
- [ ] After acquisition, redraw through the existing success/error model and
  real handlers without adding a second panel or fallback container.
- [ ] If Torn replaces or detaches the preferred host while acquisition is in
  flight, resolve a current mount before the final draw.
- [ ] Keep `generation` as the authority for stale work. Leaving education must
  remove the loading shell immediately, and a late result must never recreate it
  on another page.

Tests written first:

- [ ] A held fetch shows one loading panel before the promise resolves.
- [ ] Resolving the fetch replaces loading content with the normal schedule.
- [ ] Fetch/fiber failure replaces loading content with the existing named
  error and debug-report path.
- [ ] Leaving during loading removes both panel and fallback; resolving later
  leaves them absent.
- [ ] Mutation/popstate churn during loading starts no second acquisition.
- [ ] A preferred mount replaced during loading receives the final panel once.
- [ ] No preferred mount produces one owned fallback, never stacked fallbacks.
- [ ] Existing plan/settings save, reset, import, focus and navigation tests
  retain their assertions and fixtures.

## Task 4 — Bound the endpoint wait without changing acquisition precedence

**Symbols:** `fetchEducationData`, `acquireEducationData`

- [ ] Add a named, conservative timeout for the endpoint request. The loading
  shell means this deadline is a recovery bound, not the first user feedback.
- [ ] Use a timer race with cleanup rather than depending on `AbortController`,
  whose availability varies between embedded webviews.
- [ ] Resolve a timeout as the normal never-rejecting adapter result:
  `{ ok: false, reason: 'timeout', detail: <non-sensitive message> }`.
- [ ] Let `acquireEducationData()` continue to the React-fiber path only after
  that endpoint failure, preserving its current strict precedence.
- [ ] Ignore any eventual late endpoint settlement. It must not redraw, write
  storage, or create an unhandled rejection.
- [ ] Never put the request URL, `rfcv`, response body, or other session data in
  the timeout detail or debug report.

Tests written first:

- [ ] A fetch settling before the deadline follows the byte-for-byte existing
  success result shape and clears its timer.
- [ ] A never-settling fetch resolves as `timeout` when the test clock advances.
- [ ] Timeout then a valid fiber payload succeeds with `source: 'fiber'`.
- [ ] Timeout plus no fiber payload reaches the visible combined failure.
- [ ] A late resolve/reject after timeout is harmless and does not redraw.
- [ ] Existing network, HTTP, non-JSON, Torn-error, token-redaction and
  never-reject tests remain unchanged in meaning.

## Task 5 — Make mount selection and fallback mobile-safe

**Symbols:** `MOUNT_SELECTORS`, `findMountPoint`, fallback creation,
`panelStyleText`

- [ ] Keep the current selector order and stable-prefix rules. Every host query
  remains guarded and its purpose remains documented beside the selector.
- [ ] Accept a preferred host only when it is still connected; do not use
  geometry or computed-style heuristics that can misclassify Torn content during
  a temporary React layout pass.
- [ ] Fall back to the owned `#tes-fallback-mount` under `document.body` when no
  current preferred host exists.
- [ ] Move fallback positioning into named CSS rules where practical while
  retaining the highest z-index and the existing 12px desktop edge spacing.
- [ ] Constrain fallback width to the available viewport with border-box sizing.
- [ ] Constrain height with `100vh` plus a later `100dvh` override and allow
  internal vertical scrolling. No horizontal page overflow.
- [ ] At narrow widths, reduce edge spacing without changing renderer structure,
  control labels, typography tokens, or desktop inline-panel layout.
- [ ] Keep focus visibility and the existing light-on-dark input/button rules.

Tests written first:

- [ ] Preferred connected host is still selected ahead of the fallback.
- [ ] Detached preferred host is rejected and the body fallback is used.
- [ ] CSS contains viewport-safe width, `100vh`/`100dvh`, vertical overflow and
  a narrow-width rule scoped to the owned fallback/panel.
- [ ] Existing no-black-text, token, spacing, long-text, tabular-number and
  focus-visible style guards all continue to pass.

## Task 6 — Whole-system regression verification

- [ ] Run focused suites after each task, then the complete automated gate:

  ```text
  npm test
  npm run test:syntax
  git diff --check
  ```

- [ ] Inspect the final diff specifically for accidental changes to:
  - engine-section lines;
  - storage keys and normalizers;
  - endpoint URL, request headers and token handling;
  - `@match`, grants and absent `@connect`;
  - panel view renderers and event handlers;
  - version constants or release metadata.
- [ ] Run a mutation check for each new user-visible promise: temporarily
  restore `document-idle`, remove the DOM wait, move acquisition ahead of the
  loading draw, remove the timeout, and remove the viewport constraint. Each
  corresponding new test must fail for the promised reason.
- [ ] Update `docs/architecture.md`, `docs/qa-checklist.md`, `CHANGELOG.md` under
  Unreleased, and hand-shift `docs/code-map.md` anchors. Review the code-map diff
  rather than blindly regenerating it.
- [ ] Do not bump `@version`, `SCRIPT_VERSION`, `package.json`, or create a tag
  until a separately authorized release commit.

## Task 7 — Signed-in manual QA gate

Automated tests cannot prove Torn PDA's actual injection or Torn's live React
tree. Run these checks on the same build before release.

### Torn PDA

- [ ] Install/update the script and select injection time **END**.
- [ ] Cold-launch directly to Education: loading shell appears, then schedule.
- [ ] Navigate into Education from another Torn page without reloading.
- [ ] Navigate away while loading: no panel follows onto the next page.
- [ ] Return to Education: one panel, one request, current active-course time.
- [ ] Background and resume the app, then revisit Education.
- [ ] Test slow/offline data: visible loading followed by a named error; restore
  connectivity and reload successfully.
- [ ] Portrait and landscape at the narrowest practical width: no clipping,
  horizontal page scrolling, unreachable controls, or content hidden beneath
  PDA navigation.
- [ ] Build a plan, close/reopen PDA, and confirm GM-backed persistence.

### Desktop regression

- [ ] Tampermonkey direct load, reload, sidebar navigation in/out, back/forward,
  and Torn React re-render all retain one panel.
- [ ] Known education host still gets the inline panel rather than the fixed
  fallback.
- [ ] Schedule, Degrees, Focus and Settings match the existing QA checklist.
- [ ] Existing saved plan and settings load unchanged; changing and reloading
  them still persists.
- [ ] Finish date, queue ordering, manual reordering, boosters, presets,
  share/import, reset controls and debug report match the 1.1.0 build for the
  same fixture/account state.

## Stop conditions

Stop implementation and amend/review this plan before proceeding if any of the
following becomes necessary:

- widening `@match`, adding a grant or `@connect`;
- changing storage technology or schema;
- changing the Torn endpoint or using an external service;
- changing engine arithmetic or data parsing;
- adding PDA-specific feature forks beyond startup/mount/layout behavior;
- weakening a current navigation, security, privacy or rendering assertion;
- fixing the unrelated lifetime mount-attempt budget in the same change.

## Completion gate

This work is complete only when the new PDA lifecycle tests fail against 1.1.0
and pass against the implementation, all pre-existing tests and syntax checks
pass without weakened assertions, the security/storage/engine diff audit is
clean, and both Torn PDA and desktop signed-in QA pass. Automated verification
can establish non-regression of the tested contracts; the release must remain
blocked until the owner completes the real-device PDA and live-Torn checks.
