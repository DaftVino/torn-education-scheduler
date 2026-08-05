# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-05

### Added

- A Focus view: pick what you want out of education — a working stat, a battle
  stat, weapon damage, or a specific unlock — and the queue re-sorts to deliver
  it first. Ten categories, 79 selections, built from a classification of all
  101 of Torn's `learningOutcomes` strings. Focus mode is switched on from
  Queue order; the nav button is disabled until then and says so. Multiple
  focuses rank lexicographically by the priority you set, never summed.
- Reset controls: `reset` on the schedule clears the queue, `reset` on Focus
  clears your selections, `defaults` on Settings restores setting defaults —
  each takes two clicks to arm and confirm, and each clears only what its own
  page owns.

### Changed

- Finish times read `2026-08-04 · 21:00 TCT` — an ISO date, the time separate,
  labelled Torn City Time (UTC).
- Durations and counts abbreviate in dense readouts: `hrs`, `crs`, `fin`.
- `⚙ settings` is now a permanent right-aligned landmark on every view.
- `hide` is a real button; the header title no longer toggles the panel.
- Queued courses show what they give on a second line.
- The degrees grid's all-courses box became a full-width banner above the
  grid, titled "all remaining courses", rather than a box that sorted last.
- The panel adopts Torn Bookie Live Scores' default palette as design tokens
  (colour, type scale, spacing scale), and gained a keyboard focus ring.

### Notes

- **31 of 131 courses list no learning outcome at all.** Those rows show
  `Bonus: not listed by Torn` rather than guessing at a benefit Torn does not
  state.
- **Bachelor courses are marked by colour, not a `[bachelor]` prefix.** On
  macOS the OS draws the `<select>` menu itself and ignores option colour, so
  macOS players see no marker at all. This is the one place a player on one
  platform gets less than another — recorded here plainly, not as a bug to
  chase.
- `focusScores`' summing branch and `focusTotals`' by-course dedupe exist for
  when the same course is reached twice under one `(category, selection)`
  pair. No such duplicate exists in today's 120-row taxonomy, so neither
  branch is exercised by real data; both are kept as defensive code, guarded
  by a canary test (`tests/focus.test.js`) that fails the day a real duplicate
  is added, rather than removed for looking like dead code.

## [0.2.0] - 2026-08-04

### Added

- React fiber fallback for data acquisition: if the `educationInitData` fetch
  fails, the panel falls back to reading the same course data out of Torn's
  own React component tree instead of going dark.
- The panel now mounts and unmounts across Torn's single-page navigation, so
  arriving at the education page from elsewhere in Torn shows it with no
  reload, and leaving the page unmounts it cleanly.
- A settings view behind a gear icon: max booster cooldown, Books of Carols
  owned and their unit price feed the arithmetic directly. Job points
  available and the merits/Principal rank/WSU stock block overrides do not —
  Torn already applies job points to the course in progress, and the
  reduction is read from the payload rather than reconstructed from perks.
  Both are recorded so they travel with a shared plan string and a debug
  report.
- Perk inference: the panel infers merits, Principal rank and the WSU stock
  block from the observed reduction ratio wherever the split is unique, and
  prefills the settings fields with it.
- A debug report, built from an allowlist, that renders in the panel before
  it can be copied and names where to send it.
- A degree grid view: one box per degree plus one box for every course,
  each computed independently from today.
- The Book of Carols ceiling and floor date: the maximum number of Books a
  cooldown budget supports, and the shortest possible finish date that
  buying that many produces, printed with its cost.
- Three queue ordering modes — as-listed, shortest-first, unlocks-first.
- Plan export and import as a copyable string, validated against the
  catalogue on the way back in.

### Changed

- The course picker now marks bachelor (tier-3) courses in their label and
  gains an "all remaining courses" entry that queues everything not yet
  completed, dependency-ordered — roughly 115 courses on a fresh account.
- The finish date summary now also reports the floor date and its cost
  alongside the planned finish, when Book of Carols settings are supplied.

### Notes

- Ordering does not change the finish date. Courses run one at a time, so
  the total is a sum, and a sum is order-independent. Ordering changes how
  soon each course's bonus starts paying off, not how long the whole queue
  takes.
- Each box in the degree grid starts from today, so their dates overlap and
  cannot be read as a sequence — eleven degrees finishing in 2026 next to an
  all-courses box finishing in 2029 is expected, not a bug. The boxes do
  **not** fail to sum: measured against the real catalogue they come to 115
  courses and the matching duration, both for the twelve degree boxes and
  for the all-courses box. See the 2026-08-04 correction in
  `docs/designs/v0.2.0-scope.md` § C3.
- Perk inference only prefills a field where the observed reduction has
  exactly one decomposition into merits, Principal rank and the WSU stock
  block, and marks the value as inferred rather than known. Ambiguous
  totals — most of them — are left for the player to enter.
- The floor date is always printed together with its cost. When no Book
  price is set, the cost is withheld rather than shown as `$0`, so an
  unset price never reads as a free ceiling.
- A fourth ordering mode, `days-per-bonus`, is not in this release. The
  payload offers two incompatible definitions of "bonus" that sort the
  catalogue differently, and the mode's name would lie about which one it
  used. Recorded in `docs/designs/v0.2.0-scope.md` § H2, pending the
  owner's definition.

## [0.1.0] - 2026-08-03

### Added

- Reads education data from Torn's `educationInitData` endpoint — no API key, no HTML parsing.
- Adding a course queues its whole prerequisite chain, ordered so the plan can
  actually be followed, so the finish date covers the real path rather than one
  course of it.
- Exact finish date and time for the queue, and a projected finish per course.
- Perk reduction read from the payload and reported as a single figure.
- Plan persistence in Tampermonkey storage, surviving a site-data clear.
- Collapsible panel with a persisted hide/show state.

### Notes

- The finish date is withheld whenever the queue has unmet prerequisites. A
  date for a plan that cannot be followed is worse than no date, so the panel
  names what is missing instead.
- Queue order does not change the finish date — courses run one at a time, so
  the total is a sum. Ordering changes how early each perk starts paying off,
  which is a later release.
- Entries in a stored plan that have since been completed, started, or removed
  from the game are dropped from the queue and reported, never silently counted.
