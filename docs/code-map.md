# Code Map

Symbol index with line anchors for `torn-education-scheduler.user.js` (810 lines)
and a file-level index of `tests/*.js`. Grep this file for a symbol, then `Read`
with `offset`/`limit` around the anchor — never open the userscript whole
(`CLAUDE.md` repo-specific constraint 1).

Regenerate whenever a session moves declarations; a stale anchor is worse than
none, because it is trusted.

## `torn-education-scheduler.user.js`

### Metadata block (lines 1–22)

| Symbol | Line |
| --- | --- |
| `// ==UserScript==` header (`@name`, `@version`, `@match`, `@grant`, `@run-at`) | 1 |
| `@match`/`@grant` scoping note (comment) | 13 |
| IIFE open `(function () {` | 17 |
| `SCRIPT_VERSION` | 20 |
| `EDU_ENDPOINT` | 21 |
| `STORAGE_KEY` | 22 |

### ENGINE START … ENGINE END (lines 24–300)

Pure functions only — no DOM, no network, no `GM_*`, no ambient clock.
Enforced by `tests/purity.test.js`, which strips comments before scanning —
prose here may use ordinary English words like "window" or "location";
code here may not touch them.

| Symbol | Line |
| --- | --- |
| `─── ENGINE START ───` marker | 24 |
| `VALID_STATUSES` | 28 |
| `PayloadError(reason, detail)` | 30 |
| `isInt(v)` | 37 |
| `readRfcvToken(cookieString)` — parses a raw cookie string and returns the `rfc_v` token, falling back to `rfc_id`, or `null` if neither is present/non-empty; exact name matching (`xrfc_v`/`rfc_value` do not collide) | 46 |
| `MIN_COMPLETED_AT` / `MAX_COMPLETED_AT` — sane Unix-seconds bounds (2020–2100) for `activeCourse.completedAt`, catching a milliseconds-not-seconds payload that `isInt` alone would pass | 75–76 |
| `normaliseCourse(raw, categoryId)` | 78 |
| `deriveReduction(courses)` | 107 |
| `parsePayload(raw)` — validates `raw.activeCourse`: `id`/`completedAt` must both be integers when present, and `completedAt` must fall within `MIN_COMPLETED_AT`–`MAX_COMPLETED_AT`; absent/`null` yields `activeCourse: null`; when `raw.success !== true`, carries `raw.error` (if a string) into the `PayloadError` detail so Torn's own diagnosis reaches the panel | 122 |
| `unmetPrerequisites(courseId, completedIds, courses)` | 182 |
| `requiredCoursesFor(courseId, completedIds, courses)` — post-order DFS over the same parentId/tier-3 graph as `unmetPrerequisites`; returns the full transitive prerequisite chain in an order `validateQueue` accepts, `courseId` last, completed courses excluded, cycle-guarded via a `visiting` set | 220 |
| `validateQueue(queue, completedIds, courses)` | 254 |
| `schedule(options)` | 272 |
| `─── ENGINE END ───` marker | 300 |

### RUNTIME (lines 302–810)

GM storage, the fetch adapter, the panel, and the bootstrap.

| Symbol | Line |
| --- | --- |
| `─── RUNTIME ───` marker | 302 |
| `freshPlan()` — returns a new `{ queue: [], collapsed: false }` object each call | 306 |
| `loadPlan()` — dedupes `queue`, preserving first-occurrence order | 313 |
| `savePlan(plan)` — returns `true`/`false` so the caller can tell whether the save persisted | 346 |
| `fetchEducationData(fetchImpl, cookieString)` — reads the ambient cookie jar (guarded) when `cookieString` is omitted, resolves `{ok: false, reason: 'no-session-token'}` without firing a request when `readRfcvToken` finds nothing, otherwise appends `&rfcv=<encodeURIComponent(token)>` to `EDU_ENDPOINT`; the token never reaches a `detail` string | 367 |
| `isEducationPage()` | 432 |
| `formatTimestamp(seconds)` | 438 |
| `formatDuration(seconds)` | 442 |
| `reductionLabel(reduction)` | 452 |
| `buildPanelModel(state)` — reads `state.saveFailed` into `model.saveError` and `state.selectedCourseId` into `model.selectedCourseId`; withholds `finishLabel`/`totalLabel` (both `null`) whenever `problems.length > 0` — a queue with unmet prerequisites is not a plan the player can follow, so no finish date is printed for it, confident or otherwise | 457 |
| `MOUNT_SELECTORS` | 551 |
| `findMountPoint(doc)` | 557 |
| `injectStyleOnce(doc)` — appends `#tes-style` to `doc.head \|\| doc.body`, guarded on `doc.querySelector('#tes-style')` so redraws never duplicate it; includes the `#tes-panel button, #tes-panel select` rule (legible foreground/background/border, not inherited black-on-dark) | 570 |
| `renderPanel(doc, mount, model, handlers)` — calls `injectStyleOnce`; renders a prominent `.tes-finish` line, a `.tes-save-error` line when `model.saveError`, a "cannot be followed as ordered" summary line when the queue is non-empty but `finishLabel` is withheld, preserves the picker's selection via `model.selectedCourseId`, and guards the add button on `picker.value !== ''`; each queued row reads `— finishes <date>` (not "done", which read as already-completed in live QA) | 590 |
| `errorModel(message)` | 713 |
| `noopHandlers` | 721 |
| `init()` — falls back to a fixed-position `#tes-fallback-mount` appended to `document.body` when `findMountPoint` finds nothing; wraps each `draw()` in try/catch so a throw renders inside the panel via `errorModel` instead of vanishing; tracks `selectedCourseId` and `saveFailed` across redraws; calls `fetchEducationData(null)`, which reads the ambient cookie jar itself; `onAdd` expands the chosen course through `requiredCoursesFor` before appending, skipping anything already queued and preserving existing queue order | 723 |
| Bootstrap guard: `if (isEducationPage()) { init(); }` | 807 |
| IIFE close `})();` | 810 |

## `tests/*.js`

| File | Covers |
| --- | --- |
| `tests/load-userscript.js` | Test harness, not a test file: reads the production source, injects an in-memory export statement before the final `})();`, and runs it in a Node `vm` context with mocked `GM_*`/`document`/`location`/`fetch` globals. Owns `EXPORT_NAMES` — the list of internals tests can see — and fixture loading. |
| `tests/metadata.test.js` | `@version`/`SCRIPT_VERSION`/`package.json` agreement, the `@match`/`@grant` security surface (and absence of `@connect`), and the `isEducationPage()` page guard. |
| `tests/payload.test.js` | `parsePayload()`: course/category counts and shape against the real fixture, `normaliseCourse` field mapping, active-course/completed-id extraction, reduction-ratio derivation, rejection of malformed payloads, rejection of an `activeCourse` with a non-integer `completedAt`, a `null` `id`, or a `completedAt` outside the `MIN_COMPLETED_AT`–`MAX_COMPLETED_AT` range (milliseconds, `0`, negative) — all `reason === 'bad-active-course'` — confirmation the fixture's real `completedAt` still passes, and that a string `raw.error` (e.g. Torn's live `"Wrong rfcv token"`) is carried into the thrown detail while a missing or non-string `raw.error` fails cleanly without rendering `[object Object]`. |
| `tests/prereq.test.js` | `unmetPrerequisites()`/`validateQueue()`: parent-chain walking, tier-3 bachelor gating against tier-2 courses in the same category, cycle termination, and queue-order validation. `requiredCoursesFor()`: single-course/no-op case, tier-2 ancestor chain ordering, tier-3 bachelor pulling in its category's tier-2 courses and their shared parent, completed-course exclusion, no-duplicates, cycle termination, and the catalogue-wide property test — for every course id in the fixture, `requiredCoursesFor(id, ...)` queued from empty must leave `validateQueue()` reporting `[]`. |
| `tests/engine.test.js` | `schedule()`: finish-date arithmetic from `activeCourse.completedAt`, back-to-back queue timing, order-independence of the total across permutations, and rejection of an unknown course id or a missing `now`. |
| `tests/purity.test.js` | Source-text scan of the ENGINE START/END section asserting no DOM, network, `GM_*`, clock, or storage reference appears there. |
| `tests/storage.test.js` | `loadPlan()`/`savePlan()`: default plan on fresh install, round-trip through mocked GM storage, fallback on corrupt or malformed stored data, deduping a duplicated queued course id (first occurrence wins), and `savePlan()` returning `true`/`false` to reflect success/failure. |
| `tests/rfcv.test.js` | `readRfcvToken()`: extraction from `rfc_v`, fallback to `rfc_id`, preference for `rfc_v` when both are present, `null` on an empty string/missing cookie/empty value, immunity to name collisions (`xrfc_v`, `rfc_value`), and tolerance of surrounding whitespace and unrelated cookies. Kept separate from `payload.test.js` because cookie-string parsing is unrelated to the education payload shape. |
| `tests/adapter.test.js` | `fetchEducationData()`: successful parse, same-origin request shape, that the request URL carries an `rfcv` parameter (regression guard — verified to fail when the append is removed), the no-token short-circuit (`reason: 'no-session-token'`, fetch never invoked), network/HTTP/non-JSON failure reporting, that Torn's live `"Wrong rfcv token"` response surfaces via `parsePayload`'s carried-through detail, the never-rejects contract, that a non-JSON response body is never echoed, and that the token itself never appears in any `result.detail`. |
| `tests/panel.test.js` | `buildPanelModel()`/`findMountPoint()`: label formatting, error vs. ok model shape, stale-queue pruning (deleted or already-finished courses), problem reporting, addable-course sorting, prefix-matched mount-point lookup, and the honesty backstop — `finishLabel`/`totalLabel` are both `null` whenever `problems` is non-empty (regression guard for the live-QA failure where a confident finish date was printed for an unfollowable queue). Also `renderPanel()`/`init()` against a local fake DOM (`makeFakeDocument()`, id-aware `querySelector`): the `#tes-style` injection guard against duplication across redraws, error-model message rendering, the "cannot be followed" summary line, the add-button guard against an empty picker selection, `init()`'s fixed-position fallback mount when no selector matches, and the real `onAdd` handler auto-queuing a course's full `requiredCoursesFor` chain (verified end-to-end through `GM_setValue`/`gmStore`) without duplicating an already-queued course or its prerequisites. |
