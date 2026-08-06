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

## Torn PDA lifecycle

The userscript runs at `document-end`. This is deliberately late enough for
Torn PDA's webview injection model, but startup must still tolerate the script
arriving before the usable page DOM, or after normal browser readiness events.
The runtime first applies a strict `www.torn.com` / `page.php` /
`sid=education` guard. It then accepts `DOMContentLoaded` and `load` when they
are still available and uses a short, bounded poll as the final readiness
path. These paths converge on one idempotent bootstrap; they must not create
duplicate observers or panels.

Live Torn PDA evidence confirmed that the direct Education URL, usable DOM, GM
APIs, and history assignment are valid. The actual no-panel failure happened
before bootstrap: Torn PDA's official `UserScriptsProvider.adaptSource` source
adaptation replaces typographic double quotes (`“”`) and apostrophes (`‘’`) with
their ASCII equivalents across the entire source before injection. Four curly
apostrophes inside single-quoted JavaScript strings consequently became syntax
errors, so none of the panel, fallback, or lifecycle code could execute.

The distributed userscript therefore uses ASCII-only quotation marks, enforced
by a regression test that rejects typographic quotes. The current route still
mounts before optional history hooks, and history patching plus `popstate`
observation remain best-effort defensive hardening: an unavailable future hook
must not prevent the direct route from rendering.

The panel shell mounts before data acquisition and visibly reports that it is
loading. Data acquisition gives Torn's `educationInitData` endpoint 15 seconds
to respond, then uses the existing React Fiber extraction as its fallback. A
failure after both paths remains visible and retryable rather than leaving a
blank page.

The preferred mount is a connected inline education host. If Torn has not
provided one, or has replaced or detached it during SPA navigation, the runtime
uses an owned, responsive fixed fallback attached to `document.body`. Navigation
and DOM replacement re-evaluate that choice without changing calculations.

This compatibility layer does not alter the data-source precedence (endpoint,
then Fiber), course calculations, GM storage schema, grants, or page-context
security boundary.

This is a living document: update it in the same PR as any change it describes.

## Key decisions

See `docs/adr/`.
