# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-08-06

**TORN PDA COMPATIBLE.** The scheduler now runs inside the Torn PDA app as well
as desktop Tampermonkey, and the panel lays out for narrow mobile screens. It is
the same file in both places — there is no separate mobile build, and nothing
about the arithmetic, stored plans, or security surface changed.

### Changed

- Hardened Torn PDA startup: the scheduler now starts at document end, guards
  the Torn education route explicitly, waits safely for a usable DOM, shows a
  loading shell before acquisition, and keeps a responsive owned fallback when
  Torn's inline host is unavailable. The actual PDA launch failure was a source
  parse error: its `UserScriptsProvider.adaptSource` normalizes typographic
  quotation marks before injection, which turned curly apostrophes in
  single-quoted JavaScript strings into invalid syntax. The distributed source
  now uses ASCII-only quotes, protected by a regression test. The existing
  endpoint-first, Fiber-fallback data acquisition order, calculations, and GM
  storage/security model are unchanged.

- Corrected the Torn PDA mobile layout: planner navigation uses a contained
  two-column grid, the course picker cannot outgrow the panel, and the
  all-remaining banner stacks its figures and finish date cleanly on narrow
  screens. Manual Torn PDA recheck remains required.

## [1.1.0] - 2026-08-06

### Added

- **Manual queue reordering, which cannot produce a queue you can't follow.**
  Each queue row carries up and down controls. A move that would put a course
  ahead of something it requires — or leave a course behind something that
  requires it — is disabled rather than offered and then rejected, and the
  control says which course is blocking it. Ordering still does not change the
  finish date; courses run one at a time, so the total is a sum. What it
  changes is how early each perk starts paying off.

  Moving a course by hand switches the ordering preference to **As listed** and
  says so, because a manual order and an automatic one cannot both be in
  effect. The order you were looking at is what gets kept.

- **Five beginner-guide route presets in the Schedule course picker** —
  `0-Start Here`, `1-Fighting`, `2-Crime`, `3-Trader / collector` and
  `4-Undecided`, grouped under a `Guide presets` heading above the course list.
  Each loads a published route in one step instead of course-by-course, and the
  leading numbers keep them in the order the guide follows. A preset whose
  courses you have already queued or completed is hidden rather than offered as
  a no-op.

### Changed

- Resolved the scheduler's Help and Schedule guide links to the published
  [Torn Education Scheduler beginner's guide](https://www.torn.com/forums.php#p=threads&f=61&t=16589908&b=0&a=0).

- The maximum-Books floor now defaults to a 48-hour booster cooldown. Its
  descriptor states the cooldown used immediately after the cost (for example,
  `48hr CD`) and stays synchronized if the setting is changed.

## [1.0.1] - 2026-08-05

**Update if you installed 1.0.0.** Two different builds went out under that
version — one before the licence and Greasy Fork details were added, one after
— so 1.0.0 is ambiguous and this replaces it. Nothing about the arithmetic
changed in either.

### Added

- **`@license MIT` in the script itself.** The userscript is the whole
  distribution: installing the raw file gets you no repository, so without this
  the copy on your disk stated no terms at all. It is kept in step with the
  `LICENSE` file and `package.json`.
- `@homepage` and `@supportURL`, both pointing at the Greasy Fork listing.

### Changed

- **The debug report now names where to send it.** It always said "the Greasy
  Fork page"; now it carries the address, because the listing exists.
- **The script's own comments were cut back to what a reader can use** — 173
  lines lighter. References to internal test files, design documents and task
  numbers are gone; the notes explaining what the script reads, what it stores
  and how it fails are kept. It is published, so it is read.

## [1.0.0] - 2026-08-05

**First public release.** The version is 1.0.0 because the repository went
public here, not because the code changed shape — everything below is the work
that was already on `main`, plus the layout pass. Nothing about the panel's
arithmetic changed at 1.0.

### Added

- **A balanced default ordering**, used when Queue order is "My focus first"
  and you have selected no focuses. Gain multipliers first — the courses that
  multiply a *rate* of future gain, so taking them early compounds over
  everything queued behind them — then courses by measurable benefit per day,
  then unlocks. Any explicit Queue order still overrides it, and choosing any
  focus replaces it entirely.
- `focus-taxonomy.xlsx` gains a **Default order** sheet showing how every
  course scores, with a per-course breakdown of what each contribution is worth.

### Changed

- **Degrees now read as a compact definition list** instead of a card grid:
  two columns when space allows, one on narrow panels, with the existing
  all-remaining summary kept above the twelve degree rows. Completed degrees
  stay visible as muted rows labelled `Already complete`.
- **Queue entries now use two compact lines** — course identity first, then
  duration, finish date and the full Torn-provided bonus — with one remove
  action spanning the row.
- **Book and job-point projections are structured scenarios** rather than a
  prose block. Each scenario aligns its finish date with its supporting detail,
  and the maximum-Books floor keeps date, count and cost together.
- **Settings is grouped into five named sections with short role labels:**
  Boosters, Planning, Education perks, Help and Share this plan. The controls,
  saved values and calculations are unchanged.
- Comparable figures use tabular numerals, long Torn-owned names and bonuses
  wrap safely, and read-only rows remain visually quiet with no card fill,
  shadow or hover treatment. Panel text continues to use the existing light
  theme tokens; no text is black.
- Schedule calculations and Focus guidance now sit in matching green-outlined
  overview surfaces, separating explanatory content from course rows. The
  wrapped Schedule summary no longer draws a redundant divider after its total.
  The all-remaining banner uses a compact label/figures layout where the
  existing small count/duration lead into the larger finish date, and Settings
  section headers use the theme's dark-green fill.
- **A fresh install's queue order is no longer "as listed".** It was, by
  design, until this release; the balanced default now applies instead. The
  finish date is unchanged — courses run one at a time, so the total is a sum.
- The two launch URLs hold obvious `REPLACE_BEFORE_LAUNCH` placeholders rather
  than `null`, so the wiring they feed can be checked before either URL exists.
  **Nothing renders until a URL is real** — every consumer tests whether it
  resolves, not whether the constant is set.

### Notes

- **Benefit types are normalised against the catalogue maximum before they are
  summed.** Without that, a course granting 50 manual labor would outrank one
  granting 100% unarmed damage purely because 50 and 100 sit on no shared
  scale. The resulting scores are comparable *for ranking* and are not
  quantities — nothing displays them as such.
- **Only one percentage in the catalogue can honestly be converted to an
  absolute number**: the education working-stat reward, whose base is the
  working stats you have already earned. The payload carries no battle stats,
  no company data and no jail record, so every other percentage is a rank hint.
- **The "unlocks last" group is empty against today's catalogue**, because all
  131 courses grant a working-stat gain and so none is unlock-only. Unlocks
  still contribute nothing to a course's score, so unlock-heavy courses sink on
  their own merits rather than by rule.

## [0.4.0] - 2026-08-05

There is no 0.3.0 release. This work carried that number while it was being
built and went through eight rounds of browser QA before shipping; the version
was bumped once, at the end, rather than tagging a number nobody ever ran.

### Added

- A Focus view: pick what you want out of education — a working stat, a battle
  stat, weapon damage, or a specific unlock — and the queue re-sorts to deliver
  it first. Ten categories, 82 selections — 79 built from a classification of
  all 101 of Torn's `learningOutcomes` strings, plus Working Stats' own three.
  Multiple focuses rank lexicographically by the priority you set, never
  summed. Focus is the default Queue order; with nothing selected it orders
  exactly as listed, so a fresh install's queue is unchanged.
- A sorting basis toggle on the Focus view: **most per day** banks a stat
  fastest in real time, **biggest total** finishes the largest single courses
  first. The button names whichever is active, so the ordering is readable
  before you click it.
- **Job points now shorten the plan.** Each point removes 30 minutes of queued
  course time, and points are spent before any Book of Carols — so the Book
  figures on the schedule are what is left after them, including the ceiling
  on how many Books the path can absorb.
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
- Planner destinations (`schedule`, `degrees`, `focus`) are fixed buttons in a
  fixed order rather than toggles. `focus` is present unless you pick another
  Queue order.
- The Focus view's sections are outlined cards, collapsed by default. Each
  header carries the category, the selection you chose in it, a right-aligned
  `X rem /X total` count, and — in a fixed slot, so nothing shifts when you
  choose something — that category's priority number, editable without opening
  the section.
- Completed selections gather into a collapsed `completed` group at the foot of
  their category, and their checkboxes are disabled. A completed selection you
  have chosen stays in the main list, so its checkbox is still reachable.
- Job points moved back to Boosters, first in the section, so it reads top to
  bottom in the order the arithmetic runs.
- The queue summary's separator sits under the whole block, above the course
  list, rather than between the perk reduction and the total.

### Fixed

- **Focus ordering reordered nothing for four of the ten categories.** Every
  Unlocks & Abilities, Company Bonuses, Crime & Jail and Computing selection
  scored zero, because the guard meant to catch a missing magnitude used the
  global `isFinite`, which coerces `null` to `0` and returns true. Every such
  focus was a provable identity permutation of the queue.
- Courses that scored under a focus stayed pinned behind prerequisites that
  scored nothing. A prerequisite now inherits the best score below it, for
  count-style focuses only — magnitude focuses accumulate rather than route,
  and propagating those would rank a zero-gain gate above a real gainer.
- The per-day rank basis was specified and never implemented; ranking divided
  by nothing, so long courses with large totals outranked short ones that paid
  off sooner.
- `defaults` on Settings cleared the perk fields and never refilled them, so
  they stayed blank for the rest of the session while the note beside them
  promised a refill.

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
