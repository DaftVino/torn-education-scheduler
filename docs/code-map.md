# Code Map

Symbol index with line anchors for `torn-education-scheduler.user.js` (541 lines)
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

### ENGINE START … ENGINE END (lines 24–202)

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
| `parsePayload(raw)` | 85 |
| `unmetPrerequisites(courseId, completedIds, courses)` | 127 |
| `validateQueue(queue, completedIds, courses)` | 156 |
| `schedule(options)` | 174 |
| `─── ENGINE END ───` marker | 202 |

### RUNTIME (lines 204–541)

GM storage, the fetch adapter, the panel, and the bootstrap.

| Symbol | Line |
| --- | --- |
| `─── RUNTIME ───` marker | 204 |
| `DEFAULT_PLAN` | 206 |
| `loadPlan()` | 211 |
| `savePlan(plan)` | 234 |
| `fetchEducationData(fetchImpl)` | 248 |
| `isEducationPage()` | 291 |
| `formatTimestamp(seconds)` | 297 |
| `formatDuration(seconds)` | 301 |
| `reductionLabel(reduction)` | 311 |
| `buildPanelModel(state)` | 316 |
| `MOUNT_SELECTORS` | 401 |
| `findMountPoint(doc)` | 407 |
| `renderPanel(doc, mount, model, handlers)` | 415 |
| `init()` | 497 |
| Bootstrap guard: `if (isEducationPage()) { init(); }` | 538 |
| IIFE close `})();` | 541 |

## `tests/*.js`

| File | Covers |
| --- | --- |
| `tests/load-userscript.js` | Test harness, not a test file: reads the production source, injects an in-memory export statement before the final `})();`, and runs it in a Node `vm` context with mocked `GM_*`/`document`/`location`/`fetch` globals. Owns `EXPORT_NAMES` — the list of internals tests can see — and fixture loading. |
| `tests/metadata.test.js` | `@version`/`SCRIPT_VERSION`/`package.json` agreement, the `@match`/`@grant` security surface (and absence of `@connect`), and the `isEducationPage()` page guard. |
| `tests/payload.test.js` | `parsePayload()`: course/category counts and shape against the real fixture, `normaliseCourse` field mapping, active-course/completed-id extraction, reduction-ratio derivation, and rejection of malformed payloads. |
| `tests/prereq.test.js` | `unmetPrerequisites()`/`validateQueue()`: parent-chain walking, tier-3 bachelor gating against tier-2 courses in the same category, cycle termination, and queue-order validation. |
| `tests/engine.test.js` | `schedule()`: finish-date arithmetic from `activeCourse.completedAt`, back-to-back queue timing, order-independence of the total across permutations, and rejection of an unknown course id or a missing `now`. |
| `tests/purity.test.js` | Source-text scan of the ENGINE START/END section asserting no DOM, network, `GM_*`, clock, or storage reference appears there. |
| `tests/storage.test.js` | `loadPlan()`/`savePlan()`: default plan on fresh install, round-trip through mocked GM storage, and fallback on corrupt or malformed stored data. |
| `tests/adapter.test.js` | `fetchEducationData()`: successful parse, same-origin request shape, network/HTTP/non-JSON failure reporting, the never-rejects contract, and that a non-JSON response body is never echoed. |
| `tests/panel.test.js` | `buildPanelModel()`/`findMountPoint()`: label formatting, error vs. ok model shape, stale-queue pruning (deleted or already-finished courses), problem reporting, addable-course sorting, and prefix-matched mount-point lookup. |
