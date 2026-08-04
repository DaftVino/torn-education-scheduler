# Architecture

A Tampermonkey userscript that turns Torn's education page into a live planner: it reads your own course progress and time-reduction perks, lets you pick a set of courses, and computes the exact finish date for the whole path. Runs only on torn.com's education page, with a collapsible themed panel modelled on Torn Bookie Live Scores.

## How it works

The script runs on `page.php?sid=education` and fetches Torn's own
`page.php?sid=educationInitData` — same-origin, so the session cookie rides
along and no API key is involved. That payload carries every course with
`originDuration` and `actualDuration` in exact seconds, the `parentId`
prerequisite graph, and `activeCourse.completedAt`, the timestamp the current
course ends. The script never parses HTML for data.

`torn-education-scheduler.user.js` is one IIFE in marked sections:

- **Engine** — pure functions: payload parsing, prerequisite validation, and
  the schedule. No DOM, no network, no clock. `tests/purity.test.js` enforces
  this by reading the section and failing on a forbidden reference.
- **Runtime** — GM storage, the fetch adapter, the panel, and the bootstrap.

There are two notions of "completed" and they must not be merged.
`unmetPrerequisites` answers "can I start this course today?", where the course
currently being served is **not** completed; `plannedCompletions` answers "is
this plan followable?", where it **is**, because nothing queued can begin before
`activeCourse.completedAt` and the schedule already starts there. Collapsing
them either way is a bug: use the first for a plan and a degree gated on the
active course is permanently unqueueable, use the second for a start check and
the panel invites a course the player cannot begin. The promotion is gated on
`activeCourse` naming the course, so a course marked in progress with no
completion time anywhere withholds the finish date rather than under-counting it.

Because `actualDuration` already carries the player's perk reduction, the
finish date is `activeCourse.completedAt` plus a sum over the queue. That sum
is order-independent, which is why ordering features are about time-to-benefit
rather than the finish date.

Tests run in Node with no browser: `tests/load-userscript.js` reads the
production file, injects an export statement in memory only, and runs it in a
`vm` context with mocked globals. See `docs/superpowers/specs/` for the design
and the evidence behind it.

This is a living document: update it in the same PR as any change it describes.

## Key decisions

See `docs/adr/`.
