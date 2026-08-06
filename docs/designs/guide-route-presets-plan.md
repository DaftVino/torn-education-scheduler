# Beginner-guide route presets — implementation plan

> **STATUS: IMPLEMENTED; SIGNED-IN BROWSER QA PENDING.** This plan implements
> `docs/designs/guide-route-presets.md`, including the post-implementation UX
> correction that omits fully represented presets instead of disabling them.
> It does not edit
> `docs/forum-post.md`; the owner's current forum wording is read-only input.

**Goal:** Add the five forum-guide routes to the Schedule picker as safe,
blue-marked presets that atomically append only unfinished work and never
replace the player's queue.

**Architecture:** A frozen runtime registry holds preset labels, non-numeric
picker values, and stable Torn course codes. A pure engine helper resolves and
prerequisite-expands one preset against the live catalogue. `buildPanelModel`
derives only the picker rows that still have work to add. `renderScheduleView`
groups them in an `<optgroup>` when any remain, while `init()` owns mutation, transient failure
feedback, and storage. The existing `orderQueue()` path remains the sole place
that applies the player's ordering preference.

**Tech stack:** One IIFE in `torn-education-scheduler.user.js`; Node's built-in
test runner; the shared fake DOM; the existing forum-route verifier.

## Global constraints

- Do not modify `docs/forum-post.md`. In particular, preserve the owner's
  current Fighting-route wording exactly. `npm run verify:forum` may read it,
  but implementation must not rewrite or reformat it.
- Never read the userscript whole. Locate symbols through `docs/code-map.md`
  and read narrow ranges.
- Preserve the inert picker placeholder as the first selectable option. A
  fresh picker must still report `''`; a stray `add` must do nothing.
- Presets append membership only. They do not clear, replace, or persistently
  reorder the existing queue, and they do not alter settings or Focus.
- Resolve codes against the live catalogue before producing any additions. A
  missing target is an all-or-nothing failure with visible feedback.
- Use `textContent` for every player-visible error and label.
- Preset blue is `--tm-accent-text: #6ea3d0`. It is distinct from bachelor
  green and ordinary text. The `Guide presets` optgroup is the non-colour
  indicator on native menus that ignore option colours.
- No storage schema or share-string change is needed. Presets are actions, not
  persisted plan metadata.
- Keep `@version`, `package.json`, `CHANGELOG.md`, and tags untouched during
  implementation. Releasing this feature is a separate, explicitly authorized
  v1.1.0 release operation under `docs/quick-ref-workflow.md`.
- Work in the dirty tree without overwriting unrelated changes.

## Runtime contract

Add a frozen `GUIDE_PRESETS` array in numeric display order. Each entry has:

```javascript
{
  key: 'foundation',
  value: '__preset__:foundation',
  label: '0-Start Here',
  courseCodes: ['BIO1340', 'BIO2127'],
}
```

The five keys are `foundation`, `fighting`, `crime`, `trader`, and
`undecided`. Labels and target-code arrays exactly match the design spec and
`scripts/forum-post-data.js`'s `ROUTE_CODES`.

Add these pure interfaces:

```text
guidePresetForValue(value) -> preset | null

expandGuidePreset(
  presetKey,
  completedIds,
  courses,
  activeCourse,
  existingQueue
) -> { ok: true, courseIds }
   | { ok: false, reason, detail }
```

`expandGuidePreset` never mutates any input. It resolves every target code
first, builds planned completions from completed plus the real active course,
adds valid existing queue IDs to that done set, then folds
`requiredCoursesFor()` over the targets. It filters completed, in-progress,
already queued, and duplicate IDs while preserving first occurrence. Before
returning success it validates the append segment against the planned-done set;
an inconsistent live catalogue returns a named failure rather than an
unfollowable partial route.

---

## Task 1 — Teach the shared fake DOM about optgroups

**Files:**

- Modify: `tests/fake-document.js` — `defineSelectValue`
- Modify: `tests/fake-document.test.js`

The current harness reads only `select.children`. A browser's select options
collection includes options nested under `<optgroup>`, so preset values would
otherwise be invisible to tests even though they work in the browser.

### Step 1: Write failing harness tests

Add coverage that:

- an untouched select with a direct placeholder followed by an optgroup still
  reports the placeholder;
- assigning a nested preset value makes `select.value` report that value;
- a nested option marked selected wins normally; and
- appending an optgroup after an unmatched write triggers the same browser
  reset behavior as appending a direct option.

Use a small helper that creates `select > optgroup > option`; do not involve the
userscript in this harness test.

### Step 2: Confirm the failure

Run:

```text
node --test tests/fake-document.test.js
```

Expected: FAIL — writing or selecting a nested option still reports `''` or the
direct placeholder.

### Step 3: Implement the browser-shaped option walk

Add a local recursive `selectOptions(select)` that returns descendant elements
whose tag is `option`, in document order. Make every branch of
`defineSelectValue` use that flattened list, including `optionsAtWrite`.

Do not add CSS-selector support, layout, or event dispatch to the fake DOM;
this task only corrects the select-options abstraction it already owns.

### Step 4: Verify and commit

```text
node --test tests/fake-document.test.js tests/panel.test.js
git add tests/fake-document.js tests/fake-document.test.js
git commit -m "test: model optgroup options in the shared fake select"
```

---

## Task 2 — Add the preset registry and pure expansion engine

**Files:**

- Modify: `torn-education-scheduler.user.js`
  - constants beside `ALL_COURSES_OPTION`
  - pure helper beside `plannedCompletions` / `allRemainingCourses`
- Modify: `tests/load-userscript.js` — export the registry and helpers
- Add: `tests/presets.test.js`
- Modify: `tests/forum-post.test.js`
- Modify: `scripts/forum-post-data.js` — update only the stale “future presets”
  developer comment if needed; do not alter route data or forum prose

### Step 1: Pin identity and editorial drift

In `tests/presets.test.js`, assert:

- the labels are exactly `0-Start Here`, `1-Fighting`, `2-Crime`,
  `3-Trader / collector`, `4-Undecided` in that order;
- every value is unique, starts with `__preset__:`, converts to `NaN`, and is
  not `ALL_COURSES_OPTION`;
- `guidePresetForValue` accepts exactly the five shipped values and rejects an
  unknown preset value, the all-courses sentinel, numbers, `null`, and `''`;
  and
- all nested arrays and entries are frozen.

In `tests/forum-post.test.js`, import `ROUTE_CODES` and compare it with:

```javascript
Object.fromEntries(GUIDE_PRESETS.map((p) => [p.key, [...p.courseCodes]]))
```

This is the executable drift guard between the standalone userscript and the
editorial route verifier. Do not derive the expected data by importing one
side into the other; a comparison only catches drift if the definitions remain
independent.

### Step 2: Pin expansion behavior

Build a fresh-account catalogue from the fixture by copying course objects with
`status: 'notStarted'`, an empty completed set, and no active course. Against
that catalogue, assert for every preset:

- `courseIds` exactly equal `buildForumPostReport().routes[key].courseIds`;
- `validateQueue(courseIds, new Set(), courses)` returns no problems;
- counts are 2, 12, 15, 10, and 15 respectively; and
- presets 1–4 contain both foundation course IDs.

Add focused tests for:

- completed, real-active, existing-queue, and repeated prerequisite IDs being
  omitted;
- existing queue input and catalogue objects remaining unmodified;
- Start Here followed by Fighting producing the same combined IDs as Fighting
  once;
- unknown preset keys returning a named failure;
- a target code missing from the catalogue returning `missing-course` and no
  `courseIds`; and
- an inconsistent in-progress prerequisite returning a failure rather than a
  queue that `validateQueue` rejects.

### Step 3: Confirm the tests fail

```text
node --test tests/presets.test.js tests/forum-post.test.js
```

Expected: FAIL — `GUIDE_PRESETS`, `guidePresetForValue`, and
`expandGuidePreset` are not exported.

### Step 4: Implement the pure contract

Freeze the array, every entry, and every `courseCodes` array. Use course
prefixes only for target resolution; never encode fixture IDs into the
registry.

`expandGuidePreset` must resolve all targets before calling
`requiredCoursesFor()`. That ordering is the atomicity guarantee: no caller can
receive the first half of a route because a later target vanished.

Use one advancing `done` set while folding the targets. Existing valid queue
IDs enter `done` before expansion, so prerequisites already planned do not
reappear. Return newly added IDs only; the handler owns concatenation.

### Step 5: Verify and commit

```text
node --test tests/presets.test.js tests/forum-post.test.js tests/prereq.test.js tests/purity.test.js
git add torn-education-scheduler.user.js tests/load-userscript.js tests/presets.test.js tests/forum-post.test.js scripts/forum-post-data.js
git commit -m "feat: define and expand the beginner guide presets"
```

---

## Task 3 — Put the five marked presets in the picker

**Files:**

- Modify: `torn-education-scheduler.user.js`
  - `buildPanelModel`
  - `errorModel`
  - `panelStyleText`
  - `renderScheduleView`
  - `noopHandlers`
- Modify: `tests/panel.test.js`
- Modify: `tests/style.test.js`

### Model shape

Add `guidePresets` to both model shapes. The fetch/error model carries `[]`.
The success model maps registry entries that still have work to:

```javascript
{ key, value, label }
```

For each row, call `expandGuidePreset` against the pruned stored queue. Omit a
preset when expansion succeeds with zero additions. A broken preset remains
selectable so selecting it can reach the named atomic-failure path in Task 4.

Keep the existing `selectedCourseId` field name to avoid a broad rename, but
document and test its widened union: `null | integer | ALL_COURSES_OPTION |
preset value`.

### Step 1: Update picker structure tests first

Replace the direct-child assumptions in the existing “all remaining entry
second” tests with this required structure:

1. `picker.children[0]`: inert placeholder option;
2. when at least one preset has work, `picker.children[1]`:
   `<optgroup label="Guide presets">` containing the remaining preset options
   in numeric order;
3. the next child: all remaining, when anything is addable;
4. remaining direct children: the existing individual course options.

Also assert:

- each preset option has `tes-option-preset` and its exact registry value;
- the optgroup label is present as the non-colour indicator;
- individual bachelors remain `tes-option-bachelor` and never receive the
  preset class;
- fully represented presets are absent, while partially represented presets
  remain visible;
- the placeholder remains the actual value of an untouched select;
- the all-remaining option is absent when no individual course is addable,
  and an empty preset group is absent too; and
- direct renderer dispatch calls `onAddPreset(key)` for a preset, never
  `onAdd(Number(value))`.

Update existing child-count/index assertions rather than leaving duplicate old
tests that encode the retired layout.

### Step 2: Add visual-token tests

In `tests/style.test.js`:

- add `--tm-accent-text` to the required token list;
- include it in the text-token WCAG contrast loop; and
- retain the declared/used token bijection.

In `tests/panel.test.js`, assert `.tes-option-preset` uses
`var(--tm-accent-text)` and not `var(--tm-good-text)`, while the bachelor rule
still uses green. The hex literal belongs only in the scoped token block.

### Step 3: Confirm the tests fail

```text
node --test tests/panel.test.js tests/style.test.js
```

Expected: FAIL — no guide optgroup/model rows or accent token exist.

### Step 4: Implement model, renderer, and handler shape

Render the optgroup immediately after the placeholder when the filtered model
contains at least one row. Do not render disabled preset options or an empty
group. Continue rendering all-remaining and ordinary courses exactly as today
after the group when it is present.

Before numeric conversion in the add click listener:

1. handle `''`;
2. handle `ALL_COURSES_OPTION`;
3. resolve `guidePresetForValue(picker.value)` and call
   `handlers.onAddPreset(preset.key)`;
4. only then attempt a numeric course ID.

Add `onAddPreset` to `noopHandlers` and test handler factories in the same
change, so every render path has a complete handler shape.

Declare and use:

```css
--tm-accent-text: #6ea3d0;
#tes-panel .tes-option-preset { color: var(--tm-accent-text); }
```

Do not colour the optgroup itself; its label is the platform-independent
indicator, and inherited native-menu colours vary by operating system.

### Step 5: Verify and commit

```text
node --test tests/fake-document.test.js tests/panel.test.js tests/style.test.js tests/all-courses.test.js
git add torn-education-scheduler.user.js tests/panel.test.js tests/style.test.js
git commit -m "feat: mark guide presets in the course picker"
```

---

## Task 4 — Wire atomic preset adds and visible failures through `init()`

**Files:**

- Modify: `torn-education-scheduler.user.js`
  - `buildPanelModel` / `errorModel` transient-error fields
  - `renderScheduleView` error line
  - `init` closure, `draw`, and live handlers
- Modify: `tests/panel.test.js`

### Transient state

Add `presetError = null` beside `selectedCourseId`, `importError`, and
`resetArmed` in `init()`. It is one-action UI feedback and is never stored or
included in share text.

Pass it through `draw()` to `buildPanelModel`; both error-model shapes carry
`presetError` (`null` when unavailable). At the top of `renderScheduleView`,
render a `.tes-error` through `textContent` only when it is non-null.

Clear a stale preset error when the player chooses another picker entry, adds a
single course, adds all courses, removes a course, toggles/views away, resets,
or successfully adds a preset. A return to Schedule must not resurrect an old
failure.

### Step 1: Write live integration tests

Using `initWithFixture` / `bootInit` and the nested preset options, assert:

- choosing `0-Start Here`, firing `change`, and clicking `add` stores exactly
  the helper's additions;
- choosing `1-Fighting` on a fresh plan stores a followable 12-course route
  with the foundation included;
- Start Here followed by Fighting stores no duplicates and the same membership
  as Fighting once;
- a partially completed/queued route appends only its remaining IDs and keeps
  every pre-existing queue entry at the front in its original order;
- settings and Focus storage are byte-identical before and after a preset add;
- adding a fully represented preset is a no-op;
- the preset sentinel survives picker-change state and is not coerced to a
  number on redraw; and
- a save failure reaches the existing save-error message.

For the atomic failure test, clone the fixture, remove one target course (for
example `SPT3510`), seed a non-empty plan, choose `1-Fighting`, and click add.
Assert:

- the stored plan remains byte-identical;
- no partial Biology or Sports route is appended;
- a visible `.tes-error` names `1-Fighting` and the missing code; and
- choosing and successfully adding a valid preset clears the error.

### Step 2: Confirm the tests fail

```text
node --test tests/panel.test.js
```

Expected: FAIL — renderer dispatch reaches a handler that `init()` does not
provide, and no preset failure is rendered.

### Step 3: Implement the live handler

Add one `onAddPreset(presetKey)` handler:

1. disarm reset;
2. call `expandGuidePreset` with live data and `currentPlan.queue`;
3. on failure, build a bounded message naming the preset and missing target,
   set `presetError`, redraw the unchanged plan, and do not call `savePlan`;
4. retain a defensive zero-additions no-op for programmatic/stale calls even
   though that preset is absent from the current picker;
5. on success, clear the error and commit
   `currentPlan.queue.concat(result.courseIds)` through the existing `commit`.

Do not duplicate prerequisite logic in `init()`. The pure helper is the only
route-expansion implementation; the handler owns only UI state and storage.

`onPickerChange` preserves only values recognized by
`guidePresetForValue`. An arbitrary string beginning `__preset__:` is not a
selection and falls back to `null`.

### Step 4: Verify and commit

```text
node --test tests/panel.test.js tests/presets.test.js tests/storage.test.js tests/settings.test.js tests/share.test.js
git add torn-education-scheduler.user.js tests/panel.test.js
git commit -m "feat: append guide presets atomically"
```

---

## Task 5 — Documentation, code map, and release-gate verification

**Files:**

- Modify: `README.md`
- Modify: `docs/qa-checklist.md`
- Modify: `docs/code-map.md`
- Modify: `docs/designs/guide-route-presets.md` — status only
- Modify: this plan — status only after automated implementation is complete
- Do not modify: `docs/forum-post.md`

### Step 1: Update user-facing repository docs

In `README.md`, add one feature bullet explaining that the course picker offers
five beginner-guide presets, that routes include prerequisites/foundation, and
that presets append unfinished work without replacing a plan.

In `docs/qa-checklist.md`, add signed-in checks for:

- the placeholder remaining first and inert;
- a visible `Guide presets` group before all remaining when routes remain;
- five exact labels in numeric order on a fresh account;
- fully represented presets and an empty preset group disappearing;
- blue preset options on Windows/Linux while bachelors remain green;
- macOS retaining the group label even if both option colours are ignored;
- Start Here then Fighting producing no duplicates;
- a partial route appending after an existing hand-built queue; and
- no settings/Focus changes or Torn enrolment side effects.

Do not restate or “clean up” the forum post while documenting the feature.

### Step 2: Update source navigation

Update `docs/code-map.md` for:

- `GUIDE_PRESETS` and its value contract;
- `guidePresetForValue`;
- `expandGuidePreset` and atomic failure semantics;
- `buildPanelModel`'s `guidePresets` / widened selection union;
- `renderScheduleView`'s optgroup, blue marker, and dispatch order;
- `init()`'s `onAddPreset` and transient `presetError`; and
- the new `tests/presets.test.js` plus changed panel/fake-DOM/style test counts.

Regenerate or shift every downstream anchor after declarations move, then run
the code-map tests. Do not hand-update only the new rows; stale later anchors
make the map actively misleading.

### Step 3: Mark implementation state

Only after Tasks 1–4 and automated checks are green:

- change the spec status to `implemented; signed-in browser QA pending`; and
- change this plan status to the same.

Do not bump the userscript version or add a changelog release entry here.

### Step 4: Run all automated gates

```text
npm run test:syntax
npm run verify:forum
npm test
```

Expected:

- syntax passes;
- the current owner-edited forum post passes without being modified;
- route totals remain 2 / 12 / 15 / 10 / 15 courses;
- every test passes, including code-map anchors and test counts.

Review the final diff explicitly:

```text
git diff -- docs/forum-post.md
git diff --stat
```

The first command must show no implementation-session change to the forum
post. Because the file is currently untracked, also compare its checksum or
saved starting contents in the implementation handoff; `git diff` alone cannot
prove an untracked file was untouched.

### Step 5: Commit documentation

```text
git add README.md docs/qa-checklist.md docs/code-map.md docs/designs/guide-route-presets.md docs/designs/guide-route-presets-plan.md
git commit -m "docs: record guide preset behavior and QA"
```

---

## Manual QA handoff

Automated implementation is not release-complete until an owner checks a real,
signed-in Torn education page:

1. Open the picker without touching it; confirm the placeholder is selected.
2. On a fresh account, confirm `Guide presets` precedes all remaining and
   contains five labels.
3. On Windows/Linux, confirm presets are blue and bachelors remain green.
4. On macOS, confirm the group label still distinguishes presets even if the
   native menu ignores both option colours.
5. Add `0-Start Here`, then `1-Fighting`; confirm no foundation duplicate.
6. Add a preset to a hand-built queue; confirm the existing rows remain and
   the displayed order still follows the selected Queue order.
7. Queue or complete every remaining course in a preset; confirm that preset
   disappears and an empty group is never left behind.
8. Confirm the script does not enrol in a Torn course or change Focus/settings.

Record screenshots and results in the normal QA handoff. Version bump, tag,
push, Greasy Fork update, and forum publication are outside this plan.

## Self-review

**Spec coverage:** labels and membership → Task 2; optgroup and blue/non-green
indicator → Task 3; completion/active/queued filtering and prerequisite-safe
append → Tasks 2 and 4; omitted completed presets → Task 3; missing-code atomic
failure → Tasks 2 and 4; documentation → Task 5; unchanged ordering/storage
scope → Tasks 2 and 4.

**Gap closed:** the shared fake select currently ignores nested options. Task 1
must precede UI tests, or preset selection tests would exercise a behavior no
browser has.

**Atomicity:** all target codes resolve before expansion, and `init()` writes
nothing unless the pure helper returns success. A stale late target therefore
cannot leave half a route in storage.

**Single responsibility:** the engine computes additions; the model filters
fully represented presets; the renderer groups and dispatches; `init()` alone
mutates storage and owns transient errors.

**Forum preservation:** no task lists `docs/forum-post.md` as writable. The
full verifier reads the owner's current version, and the final review includes
an explicit unchanged-file check suitable for its current untracked state.
