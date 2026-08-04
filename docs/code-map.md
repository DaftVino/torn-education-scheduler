# Code Map

Symbol index with line anchors for `torn-education-scheduler.user.js` (662 lines)
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

### ENGINE START … ENGINE END (lines 24–206)

Pure functions only — no DOM, no network, no `GM_*`, no ambient clock.
Enforced by `tests/purity.test.js`, which scans this section by source text.

| Symbol | Line |
| --- | --- |
| `─── ENGINE START ───` marker | 24 |
| `VALID_STATUSES` | 28 |
| `PayloadError(reason, detail)` | 30 |
| `isInt(v)` | 37 |
| `normaliseCourse(raw, categoryId)` | 41 |
| `deriveReduction(courses)` | 70 |
| `parsePayload(raw)` — validates `raw.activeCourse` (`id`/`completedAt` must both be integers when present; absent/`null` yields `activeCourse: null`) | 85 |
| `unmetPrerequisites(courseId, completedIds, courses)` | 131 |
| `validateQueue(queue, completedIds, courses)` | 160 |
| `schedule(options)` | 178 |
| `─── ENGINE END ───` marker | 206 |

### RUNTIME (lines 208–662)

GM storage, the fetch adapter, the panel, and the bootstrap.

| Symbol | Line |
| --- | --- |
| `─── RUNTIME ───` marker | 208 |
| `freshPlan()` — returns a new `{ queue: [], collapsed: false }` object each call | 212 |
| `loadPlan()` — dedupes `queue`, preserving first-occurrence order | 219 |
| `savePlan(plan)` — returns `true`/`false` so the caller can tell whether the save persisted | 252 |
| `fetchEducationData(fetchImpl)` | 268 |
| `isEducationPage()` | 311 |
| `formatTimestamp(seconds)` | 317 |
| `formatDuration(seconds)` | 321 |
| `reductionLabel(reduction)` | 331 |
| `buildPanelModel(state)` — reads `state.saveFailed` into `model.saveError` and `state.selectedCourseId` into `model.selectedCourseId` | 336 |
| `MOUNT_SELECTORS` | 425 |
| `findMountPoint(doc)` | 431 |
| `injectStyleOnce(doc)` — appends `#tes-style` to `doc.head \|\| doc.body`, guarded on `doc.querySelector('#tes-style')` so redraws never duplicate it | 444 |
| `renderPanel(doc, mount, model, handlers)` — calls `injectStyleOnce`; renders a prominent `.tes-finish` line, a `.tes-save-error` line when `model.saveError`, preserves the picker's selection via `model.selectedCourseId`, and guards the add button on `picker.value !== ''` | 461 |
| `errorModel(message)` | 578 |
| `noopHandlers` | 586 |
| `init()` — falls back to a fixed-position `#tes-fallback-mount` appended to `document.body` when `findMountPoint` finds nothing; wraps each `draw()` in try/catch so a throw renders inside the panel via `errorModel` instead of vanishing; tracks `selectedCourseId` and `saveFailed` across redraws | 588 |
| Bootstrap guard: `if (isEducationPage()) { init(); }` | 659 |
| IIFE close `})();` | 662 |

## `tests/*.js`

| File | Covers |
| --- | --- |
| `tests/load-userscript.js` | Test harness, not a test file: reads the production source, injects an in-memory export statement before the final `})();`, and runs it in a Node `vm` context with mocked `GM_*`/`document`/`location`/`fetch` globals. Owns `EXPORT_NAMES` — the list of internals tests can see — and fixture loading. |
| `tests/metadata.test.js` | `@version`/`SCRIPT_VERSION`/`package.json` agreement, the `@match`/`@grant` security surface (and absence of `@connect`), and the `isEducationPage()` page guard. |
| `tests/payload.test.js` | `parsePayload()`: course/category counts and shape against the real fixture, `normaliseCourse` field mapping, active-course/completed-id extraction, reduction-ratio derivation, rejection of malformed payloads, and rejection of an `activeCourse` with a non-integer `completedAt` or a `null` `id` (`reason === 'bad-active-course'`). |
| `tests/prereq.test.js` | `unmetPrerequisites()`/`validateQueue()`: parent-chain walking, tier-3 bachelor gating against tier-2 courses in the same category, cycle termination, and queue-order validation. |
| `tests/engine.test.js` | `schedule()`: finish-date arithmetic from `activeCourse.completedAt`, back-to-back queue timing, order-independence of the total across permutations, and rejection of an unknown course id or a missing `now`. |
| `tests/purity.test.js` | Source-text scan of the ENGINE START/END section asserting no DOM, network, `GM_*`, clock, or storage reference appears there. |
| `tests/storage.test.js` | `loadPlan()`/`savePlan()`: default plan on fresh install, round-trip through mocked GM storage, fallback on corrupt or malformed stored data, deduping a duplicated queued course id (first occurrence wins), and `savePlan()` returning `true`/`false` to reflect success/failure. |
| `tests/adapter.test.js` | `fetchEducationData()`: successful parse, same-origin request shape, network/HTTP/non-JSON failure reporting, the never-rejects contract, and that a non-JSON response body is never echoed. |
| `tests/panel.test.js` | `buildPanelModel()`/`findMountPoint()`: label formatting, error vs. ok model shape, stale-queue pruning (deleted or already-finished courses), problem reporting, addable-course sorting, and prefix-matched mount-point lookup. Also `renderPanel()`/`init()` against a local fake DOM (`makeFakeDocument()`, id-aware `querySelector`): the `#tes-style` injection guard against duplication across redraws, error-model message rendering, the add-button guard against an empty picker selection, and `init()`'s fixed-position fallback mount when no selector matches. |
