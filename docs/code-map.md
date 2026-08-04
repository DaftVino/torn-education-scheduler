# Code Map

Symbol index with line anchors for `torn-education-scheduler.user.js` (684 lines)
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

### ENGINE START … ENGINE END (lines 24–228)

Pure functions only — no DOM, no network, no `GM_*`, no ambient clock.
Enforced by `tests/purity.test.js`, which scans this section by source text
(including comments — words like "window" collide with `/\bwindow\b/` and
must be avoided even in prose here).

| Symbol | Line |
| --- | --- |
| `─── ENGINE START ───` marker | 24 |
| `VALID_STATUSES` | 28 |
| `PayloadError(reason, detail)` | 30 |
| `isInt(v)` | 37 |
| `MIN_COMPLETED_AT` / `MAX_COMPLETED_AT` — sane Unix-seconds bounds (2020–2100) for `activeCourse.completedAt`, catching a milliseconds-not-seconds payload that `isInt` alone would pass | 53–54 |
| `normaliseCourse(raw, categoryId)` | 56 |
| `deriveReduction(courses)` | 85 |
| `parsePayload(raw)` — validates `raw.activeCourse`: `id`/`completedAt` must both be integers when present, and `completedAt` must fall within `MIN_COMPLETED_AT`–`MAX_COMPLETED_AT`; absent/`null` yields `activeCourse: null` | 100 |
| `unmetPrerequisites(courseId, completedIds, courses)` | 153 |
| `validateQueue(queue, completedIds, courses)` | 182 |
| `schedule(options)` | 200 |
| `─── ENGINE END ───` marker | 228 |

### RUNTIME (lines 230–684)

GM storage, the fetch adapter, the panel, and the bootstrap.

| Symbol | Line |
| --- | --- |
| `─── RUNTIME ───` marker | 230 |
| `freshPlan()` — returns a new `{ queue: [], collapsed: false }` object each call | 234 |
| `loadPlan()` — dedupes `queue`, preserving first-occurrence order | 241 |
| `savePlan(plan)` — returns `true`/`false` so the caller can tell whether the save persisted | 274 |
| `fetchEducationData(fetchImpl)` | 290 |
| `isEducationPage()` | 333 |
| `formatTimestamp(seconds)` | 339 |
| `formatDuration(seconds)` | 343 |
| `reductionLabel(reduction)` | 353 |
| `buildPanelModel(state)` — reads `state.saveFailed` into `model.saveError` and `state.selectedCourseId` into `model.selectedCourseId` | 358 |
| `MOUNT_SELECTORS` | 447 |
| `findMountPoint(doc)` | 453 |
| `injectStyleOnce(doc)` — appends `#tes-style` to `doc.head \|\| doc.body`, guarded on `doc.querySelector('#tes-style')` so redraws never duplicate it | 466 |
| `renderPanel(doc, mount, model, handlers)` — calls `injectStyleOnce`; renders a prominent `.tes-finish` line, a `.tes-save-error` line when `model.saveError`, preserves the picker's selection via `model.selectedCourseId`, and guards the add button on `picker.value !== ''` | 483 |
| `errorModel(message)` | 600 |
| `noopHandlers` | 608 |
| `init()` — falls back to a fixed-position `#tes-fallback-mount` appended to `document.body` when `findMountPoint` finds nothing; wraps each `draw()` in try/catch so a throw renders inside the panel via `errorModel` instead of vanishing; tracks `selectedCourseId` and `saveFailed` across redraws | 610 |
| Bootstrap guard: `if (isEducationPage()) { init(); }` | 681 |
| IIFE close `})();` | 684 |

## `tests/*.js`

| File | Covers |
| --- | --- |
| `tests/load-userscript.js` | Test harness, not a test file: reads the production source, injects an in-memory export statement before the final `})();`, and runs it in a Node `vm` context with mocked `GM_*`/`document`/`location`/`fetch` globals. Owns `EXPORT_NAMES` — the list of internals tests can see — and fixture loading. |
| `tests/metadata.test.js` | `@version`/`SCRIPT_VERSION`/`package.json` agreement, the `@match`/`@grant` security surface (and absence of `@connect`), and the `isEducationPage()` page guard. |
| `tests/payload.test.js` | `parsePayload()`: course/category counts and shape against the real fixture, `normaliseCourse` field mapping, active-course/completed-id extraction, reduction-ratio derivation, rejection of malformed payloads, and rejection of an `activeCourse` with a non-integer `completedAt`, a `null` `id`, or a `completedAt` outside the `MIN_COMPLETED_AT`–`MAX_COMPLETED_AT` range (milliseconds, `0`, negative) — all `reason === 'bad-active-course'` — plus confirmation the fixture's real `completedAt` still passes. |
| `tests/prereq.test.js` | `unmetPrerequisites()`/`validateQueue()`: parent-chain walking, tier-3 bachelor gating against tier-2 courses in the same category, cycle termination, and queue-order validation. |
| `tests/engine.test.js` | `schedule()`: finish-date arithmetic from `activeCourse.completedAt`, back-to-back queue timing, order-independence of the total across permutations, and rejection of an unknown course id or a missing `now`. |
| `tests/purity.test.js` | Source-text scan of the ENGINE START/END section asserting no DOM, network, `GM_*`, clock, or storage reference appears there. |
| `tests/storage.test.js` | `loadPlan()`/`savePlan()`: default plan on fresh install, round-trip through mocked GM storage, fallback on corrupt or malformed stored data, deduping a duplicated queued course id (first occurrence wins), and `savePlan()` returning `true`/`false` to reflect success/failure. |
| `tests/adapter.test.js` | `fetchEducationData()`: successful parse, same-origin request shape, network/HTTP/non-JSON failure reporting, the never-rejects contract, and that a non-JSON response body is never echoed. |
| `tests/panel.test.js` | `buildPanelModel()`/`findMountPoint()`: label formatting, error vs. ok model shape, stale-queue pruning (deleted or already-finished courses), problem reporting, addable-course sorting, and prefix-matched mount-point lookup. Also `renderPanel()`/`init()` against a local fake DOM (`makeFakeDocument()`, id-aware `querySelector`): the `#tes-style` injection guard against duplication across redraws, error-model message rendering, the add-button guard against an empty picker selection, and `init()`'s fixed-position fallback mount when no selector matches. |
