# Code Map

Symbol index with line anchors for `torn-education-scheduler.user.js` (1241 lines)
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

### ENGINE START … ENGINE END (lines 24–382)

Pure functions only — no DOM, no network, no `GM_*`, no ambient clock.
Enforced by `tests/purity.test.js`, which strips comments before scanning —
prose here may use ordinary English words like "window" or "location";
code here may not touch them.

| Symbol | Line |
| --- | --- |
| `─── ENGINE START ───` marker | 24 |
| `VALID_STATUSES` | 30 |
| `PayloadError(reason, detail)` — sets a `reason` property on the returned `Error`; callers reuse `e.reason` rather than re-deriving one | 32 |
| `isInt(v)` | 39 |
| `readRfcvToken(cookieString)` — parses a raw cookie string and returns the `rfc_v` token, falling back to `rfc_id`, or `null` if neither is present/non-empty; exact name matching (`xrfc_v`/`rfc_value` do not collide) | 48 |
| `MIN_COMPLETED_AT` / `MAX_COMPLETED_AT` — sane Unix-seconds bounds (2020–2100) for `activeCourse.completedAt`, catching a milliseconds-not-seconds payload that `isInt` alone would pass | 77–78 |
| `normaliseCourse(raw, categoryId)` | 80 |
| `deriveReduction(courses)` | 109 |
| `parsePayload(raw)` — validates `raw.activeCourse`: `id`/`completedAt` must both be integers when present, and `completedAt` must fall within `MIN_COMPLETED_AT`–`MAX_COMPLETED_AT`; absent/`null` yields `activeCourse: null`; when `raw.success !== true`, carries `raw.error` (if a string) into the `PayloadError` detail so Torn's own diagnosis reaches the panel | 124 |
| `unmetPrerequisites(courseId, completedIds, courses)` | 184 |
| `requiredCoursesFor(courseId, completedIds, courses)` — post-order DFS over the same parentId/tier-3 graph as `unmetPrerequisites`; returns the full transitive prerequisite chain in an order `validateQueue` accepts, `courseId` last, completed courses excluded, cycle-guarded via a `visiting` set | 222 |
| `validateQueue(queue, completedIds, courses)` | 256 |
| `schedule(options)` | 274 |
| `looksLikePayload(v)` — shape probe for acquisition path 2: `true` only for a non-array object with `success === true` and a non-empty `categories` array whose first entry has an integer `id` and an array `courses` | 306 |
| `newWalkState()` — one walk's shared budget: `{seen, visited, exhausted}`. Callers with more than one root must create this once and pass it to every `searchForPayload` call, or the node bound is silently multiplied by the root count | 323 |
| `searchForPayload(root, limits, state)` — bounded breadth-first walk of a plain object graph returning the first `looksLikePayload` hit or `null`; `limits` is `{maxNodes, maxDepth}` (both required integers), cycle-guarded by a `Set`. Both the `looksLikePayload` probe and every property read are try/guarded, so one throwing getter cannot abandon the remaining nodes or roots. `state` is optional (a private budget when omitted); on budget exhaustion it returns `null` **and** sets `state.exhausted`, which is how the caller tells "not there" from "gave up" | 335 |
| `─── ENGINE END ───` marker | 382 |

### RUNTIME (lines 384–1241)

GM storage, the fetch adapter, the panel, and the bootstrap.

| Symbol | Line |
| --- | --- |
| `─── RUNTIME ───` marker | 384 |
| `freshPlan()` — returns a new `{ queue: [], collapsed: false }` object each call | 388 |
| `loadPlan()` — dedupes `queue`, preserving first-occurrence order | 395 |
| `savePlan(plan)` — returns `true`/`false` so the caller can tell whether the save persisted | 428 |
| `fetchEducationData(fetchImpl, cookieString)` — acquisition path 1. Reads the ambient cookie jar (guarded) when `cookieString` is omitted, resolves `{ok: false, reason: 'no-session-token'}` without firing a request when `readRfcvToken` finds nothing, otherwise appends `&rfcv=<encodeURIComponent(token)>` to `EDU_ENDPOINT`; the token never reaches a `detail` string, and a non-JSON body is never echoed. Contracted never to reject | 449 |
| `FIBER_KEY_PREFIXES` / `FIBER_LIMITS` / `FIBER_MAX_ROOTS` / `FIBER_HOST_SELECTORS` — React's per-build `__reactFiber$<random>` keys are prefix-matched, never matched whole, exactly as the class selectors are. `maxNodes` is the binding limit; `maxDepth: 14` is effectively unreachable (a FiberNode has ~15–20 object-valued own properties, so BFS spends 20,000 nodes by depth 3–4 — the real reach is ~4 hops). Tune `maxNodes`, not `maxDepth` | 517–532 |
| `fiberRootsFrom(doc)` — collects React internals objects off `FIBER_HOST_SELECTORS` matches, falling back to the first 200 `div`s when none match; identity-deduped and capped at `FIBER_MAX_ROOTS`, because React 18 sets both `__reactFiber$` and `__reactProps$` on every host node and a sweep would otherwise yield hundreds of entry points into one graph. Every query and property read is guarded | 539 |
| `readFiberEducationData(doc)` — acquisition path 2. Threads **one** `newWalkState()` through every root so the node budget spans the search rather than resetting per root. Resolves `{ok: true, data, source: 'fiber'}` or `{ok: false, reason, detail}`, reusing `PayloadError`'s `reason`; reports `fiber-budget-exhausted` (not `no-fiber-payload`) when the walk ran out of budget. Contracted never to reject | 584 |
| `acquireEducationData(doc)` — the chain, not a race: path 1 first, path 2 only on its failure, so a stale React tree cannot outrank a good response. Resolves `{ok: true, data, source: 'fetch'\|'fiber'}` or `{ok: false, reason, detail, triedFiber: true}`. Wrapped in its own defensive try (`reason: 'acquire-threw'`) because `init()` awaits it with no catch and a rejection here blanks the panel. Contracted never to reject | 626 |
| `isEducationPage()` | 650 |
| `formatTimestamp(seconds)` | 656 |
| `formatDuration(seconds)` | 660 |
| `reductionLabel(reduction)` | 670 |
| `buildPanelModel(state)` — reads `state.saveFailed` into `model.saveError` and `state.selectedCourseId` into `model.selectedCourseId`; withholds `finishLabel`/`totalLabel` (both `null`) whenever `problems.length > 0` — a queue with unmet prerequisites is not a plan the player can follow, so no finish date is printed for it, confident or otherwise | 675 |
| `MOUNT_SELECTORS` | 769 |
| `findMountPoint(doc)` | 775 |
| `queryOne(doc, selector)` — the guarded query every render-path lookup goes through: a document that throws degrades to "not found" rather than taking the render down. `findMountPoint` is deliberately **not** routed through it — its throw is the signal `init()` turns into a named visible error | 794 |
| `injectStyleOnce(doc)` — appends `#tes-style` to `doc.head \|\| doc.body` (both the query and the head/body read are guarded) so redraws never duplicate it; includes the `#tes-panel button, #tes-panel select` rule (legible foreground/background/border, not inherited black-on-dark) | 798 |
| `renderPanel(doc, mount, model, handlers)` — calls `injectStyleOnce`; renders a prominent `.tes-finish` line, a `.tes-save-error` line when `model.saveError`, a "cannot be followed as ordered" summary line when the queue is non-empty but `finishLabel` is withheld, preserves the picker's selection via `model.selectedCourseId`, and guards the add button on `picker.value !== ''`; each queued row reads `— finishes <date>` (not "done", which read as already-completed in live QA) | 821 |
| `unmountPanel(doc)` — removes `#tes-panel` **and** `#tes-fallback-mount`; safe when neither exists and when the document throws on `querySelector`. Both ids, because orphaning the fallback mount leaks a fixed-position container over the rest of the site | 947 |
| `NAV_INSTALLED_FLAG` — `'__tesNavInstalled'`, set on the window so a second `observeNavigation` call is a no-op | 964 |
| `observeNavigation(doc, win, handlers)` — three **route-change** signals into `handlers.onRouteChange()`: `pushState`/`replaceState` patches (programmatic navigation), a `popstate` listener (back button), and a `MutationObserver` on `doc.documentElement` (a route change Torn makes without touching history). It does not itself notice a re-render that drops the panel while the route stays put — that is `syncToRoute`'s job. Installs at most once per `win`; returns `disconnect()`, which restores the originals and clears the flag. A throwing handler is swallowed — a bad callback must not break the site's navigation | 966 |
| `errorModel(message)` | 1012 |
| `noopHandlers` | 1020 |
| `init()` — re-entrant, holds no module state, so the bootstrap can call it again on every route change. Falls back to a fixed-position `#tes-fallback-mount` appended to `document.body` when `findMountPoint` finds nothing; **the acquisition and mount-resolution phase is guarded like `draw()` is** — a host document that throws on `querySelector` renders a visible `errorModel` instead of rejecting, and returns `null` only when there is nowhere left to draw at all; wraps each `draw()` in try/catch so a throw renders inside the panel via `errorModel` instead of vanishing; tracks `selectedCourseId` and `saveFailed` across redraws; calls `acquireEducationData(document)` (the local is still named `fetchResult` — `buildPanelModel`'s contract did not change, only where the data may have come from); `onAdd` expands the chosen course through `requiredCoursesFor` before appending, skipping anything already queued and preserving existing queue order | 1022 |
| `mounted` / `inFlight` / `generation` / `attempts` / `pending` — bootstrap state at IIFE scope, never inside `init()`. `mounted` = a panel of ours belongs on this page; `inFlight` = init() calls between their first await and their render; `generation` is bumped on every route transition so a render that lands after the player left can be identified as stale; `attempts` is the mount budget for the current visit | 1143–1147 |
| `MAX_MOUNT_ATTEMPTS` — 20. The ceiling on mounts per visit to education; a page we can never draw into must fail quietly rather than re-acquire every debounce tick forever. Carries a FOR QA note: the counter never decays, so the realistic exhaustion path is a long dwell rather than a re-render burst, and a rate-windowed budget is the right shape once the real reconciliation rate is measured | 1148–1158 |
| `panelPresent()` — guarded `#tes-panel` lookup; the check that turns a dropped panel into a remount | 1160 |
| `startMount()` — captures `generation`, calls `init()`, and on resolution discards the render (unmount + resync) if the generation moved. A render landing on a page the player has left would otherwise orphan the panel and its fixed-position fallback mount with `mounted` already `false`, so nothing would ever remove it | 1164 |
| `syncToRoute()` — off education: reset the budget and unmount **unconditionally**, not gated on `mounted` — a mount that resolved with no panel has already cleared the flag and may still have attached a fallback container. On education: skip while a mount is in flight (a second one is the request storm), skip while the panel is present, otherwise unmount any stranded fallback mount and mount again under the attempt cap. This is what recovers from a React re-render that drops the panel without changing the route. Data is deliberately re-acquired per mount, never cached: the old mount node does not survive Torn's SPA navigation and the active course's remaining time keeps moving | 1197 |
| `scheduleSync()` — 150 ms debounce; one navigation fires the observer many times | 1232 |
| Bootstrap: `observeNavigation(document, window, { onRouteChange: scheduleSync }); syncToRoute();` | 1239–1240 |
| IIFE close `})();` | 1241 |

## `tests/*.js`

| File | Covers |
| --- | --- |
| `tests/load-userscript.js` | Test harness, not a test file: reads the production source, injects an in-memory export statement before the final `})();`, and runs it in a Node `vm` context with mocked `GM_*`/`document`/`location`/`fetch` globals. Owns `EXPORT_NAMES` — the list of internals tests can see — and fixture loading. The window stub carries a real listener registry (`win.fire(type)`), a `history` stub, and a `MutationObserver`; `setTimeout` records rather than runs, and `runTimers()` (returned alongside `win`) is how a test decides the bootstrap's debounce deadline has arrived. |
| `tests/metadata.test.js` | `@version`/`SCRIPT_VERSION`/`package.json` agreement, the `@match`/`@grant` security surface (and absence of `@connect`), and the `isEducationPage()` page guard. |
| `tests/payload.test.js` | `parsePayload()`: course/category counts and shape against the real fixture, `normaliseCourse` field mapping, active-course/completed-id extraction, reduction-ratio derivation, rejection of malformed payloads, rejection of an `activeCourse` with a non-integer `completedAt`, a `null` `id`, or a `completedAt` outside the `MIN_COMPLETED_AT`–`MAX_COMPLETED_AT` range (milliseconds, `0`, negative) — all `reason === 'bad-active-course'` — confirmation the fixture's real `completedAt` still passes, and that a string `raw.error` (e.g. Torn's live `"Wrong rfcv token"`) is carried into the thrown detail while a missing or non-string `raw.error` fails cleanly without rendering `[object Object]`. |
| `tests/prereq.test.js` | `unmetPrerequisites()`/`validateQueue()`: parent-chain walking, tier-3 bachelor gating against tier-2 courses in the same category, cycle termination, and queue-order validation. `requiredCoursesFor()`: single-course/no-op case, tier-2 ancestor chain ordering, tier-3 bachelor pulling in its category's tier-2 courses and their shared parent, completed-course exclusion, no-duplicates, cycle termination, and the catalogue-wide property test — for every course id in the fixture, `requiredCoursesFor(id, ...)` queued from empty must leave `validateQueue()` reporting `[]`. |
| `tests/engine.test.js` | `schedule()`: finish-date arithmetic from `activeCourse.completedAt`, back-to-back queue timing, order-independence of the total across permutations, and rejection of an unknown course id or a missing `now`. |
| `tests/purity.test.js` | Source-text scan of the ENGINE START/END section asserting no DOM, network, `GM_*`, clock, or storage reference appears there. |
| `tests/storage.test.js` | `loadPlan()`/`savePlan()`: default plan on fresh install, round-trip through mocked GM storage, fallback on corrupt or malformed stored data, deduping a duplicated queued course id (first occurrence wins), and `savePlan()` returning `true`/`false` to reflect success/failure. |
| `tests/rfcv.test.js` | `readRfcvToken()`: extraction from `rfc_v`, fallback to `rfc_id`, preference for `rfc_v` when both are present, `null` on an empty string/missing cookie/empty value, immunity to name collisions (`xrfc_v`, `rfc_value`), and tolerance of surrounding whitespace and unrelated cookies. Kept separate from `payload.test.js` because cookie-string parsing is unrelated to the education payload shape. |
| `tests/adapter.test.js` | `fetchEducationData()`: successful parse, same-origin request shape, that the request URL carries an `rfcv` parameter (regression guard — verified to fail when the append is removed), the no-token short-circuit (`reason: 'no-session-token'`, fetch never invoked), network/HTTP/non-JSON failure reporting, that Torn's live `"Wrong rfcv token"` response surfaces via `parsePayload`'s carried-through detail, the never-rejects contract, that a non-JSON response body is never echoed, and that the token itself never appears in any `result.detail`. |
| `tests/fiber.test.js` | Acquisition path 2 (16 tests). `looksLikePayload()` against the real fixture and five near-misses. `searchForPayload()`: a payload nested in a props graph, cyclic-graph termination, `maxNodes`/`maxDepth` bounds, non-plain values skipped, and **throwing getters on both `success` and `categories` survived** — the walk must still find a payload elsewhere in the same graph rather than abandoning it. Shared-budget behaviour: one `newWalkState()` spends a single budget across roots, and exhaustion is distinguished from a completed search. `fiberRootsFrom()` dedupes and caps at 8 given 200 nodes carrying a shared fiber. `readFiberEducationData()` reports `fiber-budget-exhausted` vs. `no-fiber-payload`. `acquireEducationData()`: fall-through to the fiber when the fetch fails, **unconditional** fetch-preference (a real `rfc_v` cookie on the doc mock so the fetch actually fires — without it the adapter short-circuits and the `fiberTouched === false` assertion never runs), never-rejects against a document that throws on every query, and both-failures reporting. Every one of these was mutation-checked: each fails against a deliberate reintroduction of the bug it guards. |
| `tests/navigation.test.js` | SPA navigation (22 tests). `unmountPanel()`: removes both ids, tolerates neither existing, survives a throwing document. `observeNavigation()`: notifies on `pushState`/`replaceState`/`popstate`/DOM mutation, `disconnect()` really stops it, installs at most once per window, survives a window with no `history`, swallows a throwing handler. Bootstrap end-to-end against the sandbox window and a fake document, driving each real signal in turn — `pushState`, the `MutationObserver` callback, `popstate`: mounts on arrival (after the debounce, not before), unmounts on leaving, installs the observer once, and 20 rounds of churn while mounted re-acquire nothing. Regression guards, each mutation-checked against a revert of the line it protects: a render landing after the player left does not orphan the panel, a dropped panel is remounted, the attempt cap stops an undrawable page looping (and a new visit gets a fresh budget), churn during an in-flight mount starts no second acquisition, remounting does not stack fallback containers, a failed mount does not latch the session, leaving the page clears a fallback container left by a mount that drew no panel, and a document that throws on every query renders a **named visible error** rather than nothing. Unit tests build their own window (`fakeWin()`) because the bootstrap has already claimed the sandbox's. |
| `tests/panel.test.js` | `buildPanelModel()`/`findMountPoint()`: label formatting, error vs. ok model shape, stale-queue pruning (deleted or already-finished courses), problem reporting, addable-course sorting, prefix-matched mount-point lookup, and the honesty backstop — `finishLabel`/`totalLabel` are both `null` whenever `problems` is non-empty (regression guard for the live-QA failure where a confident finish date was printed for an unfollowable queue). Also `renderPanel()`/`init()` against a local fake DOM (`makeFakeDocument()`, id-aware `querySelector`): the `#tes-style` injection guard against duplication across redraws, error-model message rendering, the "cannot be followed" summary line, the add-button guard against an empty picker selection, `init()`'s fixed-position fallback mount when no selector matches, and the real `onAdd` handler auto-queuing a course's full `requiredCoursesFor` chain (verified end-to-end through `GM_setValue`/`gmStore`) without duplicating an already-queued course or its prerequisites. |
