# Design: beginner-guide route presets

**Date:** 2026-08-06

**Status:** implemented; signed-in browser QA pending

**Public route source:** `docs/forum-post.md`

**Verified route data:** `scripts/forum-post-data.js`

## Goal

Add five beginner-guide presets to the Schedule course picker so a player can
load any route published in the forum guide without copying course codes:

1. `0-Start Here`
2. `1-Fighting`
3. `2-Crime`
4. `3-Trader / collector`
5. `4-Undecided`

The leading numbers are part of the visible names. They communicate that the
foundation comes first and keep the presets in the same order as the guide.

## Picker presentation

The untouched picker must remain safe. Its inert `— choose a course —` option
stays first, selected by default. Immediately after it, add an
`<optgroup label="Guide presets">` containing the five presets in numeric
order. The existing `all remaining courses` option follows the group, then the
individual course options.

Each preset option gets class `tes-option-preset` and uses a new text-safe blue
accent:

```css
--tm-accent-text: #6ea3d0;
#tes-panel .tes-option-preset { color: var(--tm-accent-text); }
```

Blue deliberately distinguishes presets from both the green
`.tes-option-bachelor` options and ordinary option text. Native dropdowns do
not honour option colours consistently, especially on macOS, so colour is not
the only indicator: the `Guide presets` optgroup remains the semantic and
visible fallback. Do not make preset options green or rely on black/dark text.

A preset with no courses left to add remains in the group but is disabled. Its
visible name does not change; the exact five names above remain stable for the
guide and tests.

## Preset membership

Presets store course-code targets, not catalogue IDs. Codes are human-auditable
against the guide and prevent a changed numeric ID from silently selecting the
wrong course. Prerequisite expansion supplies branch prerequisites and full
degree requirements.

| Preset | Stored targets | Expanded route on a new account |
| --- | --- | --- |
| `0-Start Here` | `BIO1340`, `BIO2127` | `BIO1340`, `BIO2127` |
| `1-Fighting` | `BIO1340`, `BIO2127`, `SPT3510` | `BIO1340`, `BIO2127`, `SPT1430`, `SPT2440`, `SPT2450`, `SPT2460`, `SPT2470`, `SPT2480`, `SPT2490`, `SPT2500`, `SPT2126`, `SPT3510` |
| `2-Crime` | `BIO1340`, `BIO2127`, `CMT1520`, `CMT2230`, `CMT2530`, `CMT2130`, `CMT2131`, `PSY1630`, `PSY2640`, `PSY2650`, `PSY2660`, `PSY2670`, `PSY2680`, `PSY2132`, `PSY3690` | Same codes, in the prerequisite-safe order printed in the guide |
| `3-Trader / collector` | `BIO1340`, `BIO2127`, `HIS3210` | `BIO1340`, `BIO2127`, `HIS1140`, `HIS2150`, `HIS2160`, `HIS2170`, `HIS2180`, `HIS2190`, `HIS2200`, `HIS3210` |
| `4-Undecided` | `BIO1340`, `BIO2127`, `DEF1700`, `DEF2740`, `DEF2750`, `DEF2760`, `HAF1103`, `HAF2107`, `HAF2106`, `HAF2109`, `CBT1780`, `CBT2820`, `CBT2830`, `CBT2840`, `CBT2850` | Same codes, in the prerequisite-safe order printed in the guide |

Presets 1–4 intentionally include the Start Here foundation. A new player may
therefore select a direction immediately. A player who follows the guide and
loads `0-Start Here` first can later select a direction without creating
duplicates.

`scripts/forum-post-data.js` remains the editorial definition used to verify
the published totals. The userscript must expose its shipped preset definition
to the test harness, and `tests/forum-post.test.js` must assert that the shipped
names and course-code targets equal the editorial definitions. This executable
drift check is required because the standalone userscript cannot import a
CommonJS development script at runtime.

## Add behaviour

Preset values use non-numeric sentinels such as `__preset__:foundation`; they
must never share a value with a course ID or `ALL_COURSES_OPTION`.

Selecting a preset and pressing `add` performs one atomic operation:

1. Resolve every stored course code against the live catalogue. If any target
   is missing, add nothing and show a visible, named error.
2. Start the done set with completed courses, the real active course (because
   it finishes before this queue begins), and valid courses already in the
   stored queue.
3. In preset target order, expand each target with `requiredCoursesFor()` while
   advancing that done set. This supplies prerequisites once and produces a
   followable append segment.
4. Drop completed, in-progress, and already queued courses; deduplicate the
   remainder while preserving first occurrence.
5. Append the remainder to the stored queue. Never replace or reorder the
   player's existing stored plan.

`buildPanelModel()` continues to apply the selected queue-order mode to the
combined queue for scheduling and display. Presets choose membership, not the
benefit-ranking policy. This preserves the guide's statement that the
scheduler decides the best live order for the player's settings.

Use one `onAddPreset(presetKey)` handler rather than five route-specific
handlers. `onPickerChange` must preserve preset sentinels just as it preserves
`ALL_COURSES_OPTION`, and the add-button dispatch must check both sentinel
families before numeric conversion.

## Failure and feedback

- A fully completed or already queued preset is disabled and cannot submit.
- A partially completed preset adds only remaining work.
- A preset containing the active course treats it as planned complete and does
  not queue it again.
- A stale preset code is an atomic failure: no partial route is written.
- Storage failure uses the existing visible save-error path.
- Adding a preset must never change settings, Focus selections, the active
  course, or Torn enrolment.

## Tests

Add fixture-backed coverage for:

- the exact five labels, numeric order, preset sentinels, and course-code
  targets;
- equality between shipped preset definitions and
  `scripts/forum-post-data.js`;
- all five fresh-account expansions having the course counts, totals, and
  prerequisite-valid membership already verified for the forum guide;
- presets 1–4 containing both foundation courses;
- completed, active, queued, and duplicate courses being omitted;
- selecting Start Here and then a direction producing the same set as selecting
  that direction once;
- a missing target code causing a visible error and no stored queue change;
- placeholder first, then the `Guide presets` group, then all remaining and
  individual courses;
- `.tes-option-preset` using `--tm-accent-text`, never
  `--tm-good-text`, and the optgroup remaining as the non-colour indicator;
- add-button dispatch never coercing a preset sentinel to a course number; and
- the existing all-courses and bachelor-option tests continuing to pass.

Run `npm test` and `npm run verify:forum` after implementation.

## Documentation

`docs/forum-post.md` names all five picker options, tells the player that route
presets 1–4 include the Start Here foundation, and maps each route heading to
its preset. The guide continues to print the course codes so it remains useful
without the script and auditable against Torn's catalogue.

## Out of scope

- changing queue-order modes or Focus behaviour;
- replacing or clearing a queue when a preset is selected;
- automatically enrolling in Torn courses;
- fetching preset data from the forum or any third party; and
- removing the existing all-remaining or individual-course choices.
