# Torn Education Scheduler — Design

Date: 2026-08-03
Status: approved (design), pending implementation plan

## Purpose

Torn's education system runs one course at a time and takes years to complete.
Players currently answer "when do I finish?" with private spreadsheets, rebuilt
from scratch by each player and shared as forum posts that drift out of date.

This userscript replaces that spreadsheet. It runs only on
`https://www.torn.com/page.php?sid=education`, reads the player's own progress
off the page, lets them build a queue of courses, and computes the exact finish
date and time for the whole path.

## Scope

In scope:

- Course queue with prerequisite validation.
- Finish date and time for the queue, and cumulative finish per course.
- Perk-reduction handling, derived from the page rather than entered.
- A consumable budget (job points, Book of Carols) bounded by the schedule.
- Ordering modes that front-load benefit.
- Presets drawn from the community guides.
- Export/import of a plan as a text string.

Out of scope:

- Any Torn API use. No API key, therefore no secret in the script.
- Modelling perks acquired part-way through the schedule.
- Any server, account, or hosted component.
- Recommending *which* courses to take on the player's behalf. Presets carry
  guide recommendations; the script does not editorialise beyond them.

## Source-data warning

`docs/initial-spec.md` collects nine community guides spanning roughly 2019 to
2025. They contradict each other on specifics, and at least one author states
they quit the game years before writing. Known conflicts:

| Item | Conflict |
|---|---|
| Book of Carols | "past 2 hours" (guide 2) vs "-6 hours" (guides 7, 8, 9) |
| BIO2410 Anatomy | +5% critical hit (five places) vs +3% (guide 8) |
| MTH3330 Bachelor of Mathematics | +30% ammo (guides 4, 6) vs +20% (guide 8) |
| DEF2730 Krav Maga | +1% defense (guide 4) vs +2% (guides 6, 8) |
| BIO1340 | "Introduction to Biology" vs "Introduction to Biochemistry" |
| CBT2790 Military Psychology | +1% hit rate vs +1% passive speed (guide 8) |
| HAF3111 | "50% decrease in escape chance" vs "+25% speed during escape" |

**No duration, cost, or outcome from these guides is authoritative.** Torn's
own education page is the only non-contradictory source. The guides are used
for two things only: the *membership* of preset paths (which courses, not what
they do), and as a cross-check when the bundled catalogue is first built.

## Architecture

Three layers with a hard boundary between them.

| Layer | Contents | Fragility |
|---|---|---|
| `catalogue` | Bundled course table: code, name, degree, tier, base duration, prerequisites, cost | Can go stale; cannot break |
| `engine` | Pure functions. No DOM, no browser API, no ambient clock | None — testable in Node |
| `adapter` | Scrape, panel render, row ordinals, storage | All of it |

The engine is the part worth testing. The adapter is the part worth guarding.
Everything Torn-shaped stays in the adapter, so a markup change on Torn's side
can never reach the mathematics.

The engine takes an explicit `now` parameter. It never reads the clock itself,
because a function that reads the clock cannot be tested against a fixed
expected date.

### Data flow

```
education page
  → scrape:    completed set, current course + remaining, base and reduced durations
  → reconcile: bundled catalogue vs observed → drift notice on mismatch
  → derive:    account-wide perk multiplier
  → engine.schedule(catalogue, completed, current, multiplier, budget, queue, now)
  → render:    panel + row ordinals
  ↺ user edits queue or sets a what-if override → re-run engine → re-render
```

## Catalogue: bundled with live reconcile

A verified course table ships in the script as the baseline. On each run the
adapter compares it against whatever the page renders and prefers the live
value where they differ, surfacing a visible drift notice naming the course
and both values.

This is deliberately the most expensive of the three options considered
(bundled-only, scrape-only, bundled-with-reconcile). It is chosen because
bundled-only goes stale silently — the failure mode is a confidently wrong
date — and scrape-only cannot function if the page renders degrees lazily.

The bundled table is built once during development by reading the real page,
cross-checked against the guides, with any disagreement resolved in favour of
the page.

## Perk multiplier: derived, not entered

The education page displays both the base duration of a course and the reduced
duration after the player's perks. The multiplier is therefore observable, and
the player is never asked to enumerate their merits, job rank, or stock block.

Per the spec, reductions multiply rather than add: merits (up to −20%),
Principal rank in the Education starter job (−10%), and a West Side University
stock benefit block (−10%) give `0.8 × 0.9 × 0.9 = 0.648`, a 35.2% reduction.

### The rounding problem

Displayed durations are rounded. A 7-day course shown as 5 days yields a naive
ratio of 0.714, when the truth may be 0.648. One pair is not enough.

### Derivation

1. Collect every visible `(base, reduced)` pair.
2. Treat each as a constraint band, given the display granularity — a value
   shown as *n* days constrains the true value to a known interval.
3. Intersect the bands across all pairs.
4. Snap to the nearest value in the achievable set. That set is small and
   discrete: 11 merit levels × Principal present/absent × WSU block
   present/absent ≈ 44 values. Snapping to it pins the multiplier exactly.
5. If the intersection is empty, or no achievable value falls inside it, do not
   guess. Show the observed range in the panel and ask the player to confirm.

An empty intersection is a real signal — it means either a display assumption
is wrong or Torn has changed the mechanic. Silently picking a midpoint would
hide that.

The multiplier is reported to the player as a single total, e.g. "total perk
reduction: 35.2%". The breakdown is not knowable from the page and is not
claimed. Manual fields exist only as **what-if overrides** — "what would this
look like with the WSU block?" — never as required input.

## Ordering: what it does and does not do

**Ordering does not change the finish date.** Courses run one at a time, so the
total is a sum over the queue, and a sum is order-independent. Prerequisites
constrain which orders are legal; they do not change the total. The consumable
budget removes a fixed number of hours from the total regardless of when it is
spent.

The spec asks for "the final date and time". That figure is order-independent,
and the UI states so plainly.

What ordering *does* change is **time-to-benefit**: how early each perk starts
paying off. This is the real content of "do Sports Science first" — the
bachelor's compounding gym-gain bonus is worth far more claimed a year earlier,
while the finish date is identical either way. Several of the source guides
blur these two things together. The UI will not.

Ordering modes:

- **As listed** — the player's own order, prerequisites enforced.
- **Shortest first** — quickest courses first, maximising completions early.
- **Days per bonus** — the efficiency metric from guide 7's table.
- **Unlocks first** — bachelors and ability-unlocking courses as early as
  prerequisites allow.

All modes are a topological sort over the prerequisite graph with a different
tiebreak. Prerequisite rules, per the spec: a tier-1 introduction unlocks the
tier-2 courses in its degree; all tier-2 courses in a degree must complete
before its tier-3 bachelor.

## Consumable budget and its fixed point

The player enters how many job points and Books of Carols they expect to spend.
Per the spec, a job point buys 30 minutes off the current course, and a 10★
Fitness Center or Hair Salon supports about 5 hours per 24 hours. A Book of
Carols reduces the current course and carries a 6-hour booster cooldown.

These couple in both directions: the schedule length bounds how many the player
could possibly spend, but spending them shortens the schedule, which lowers
that bound.

The engine resolves this by iteration:

1. Compute the schedule with the current spend.
2. Compute the ceiling implied by that schedule length.
3. Clamp the spend to the ceiling.
4. Repeat until stable.

The sequence is monotone decreasing and bounded below, so it converges. The
implementation caps the iteration count and treats non-convergence as a bug,
asserted in tests rather than silently truncated.

The panel shows the entered figure alongside "you could use at most N over this
period", so the ceiling is visible rather than an invisible clamp.

The exact Book of Carols reduction is disputed in the sources (2h vs 6h). It is
a configurable constant with the conflict recorded next to it, defaulting to
the value the majority of sources give, and must be verified against the game
before release.

## UI

A collapsible themed panel, modelled on Torn Bookie Live Scores: default theme
matching Torn's own styling, style settings, and an open/hide action.

The panel carries the queue, the derived multiplier, what-if overrides, the
consumable budget, and the schedule output.

Torn's own course list is modified minimally: queued courses receive an ordinal
marker and a highlight class. No text is injected into the host page's rows.
This gives the visual link between queue and list at a fraction of the selector
dependency that inline text badges would need.

## Failure behaviour

Every host-site selector is null-guarded, and every failure is **visible in the
panel**. "Couldn't read your completed courses" is a better outcome than a
silently wrong date, because a userscript that fails quietly reads to the user
as the host site breaking.

Each selector carries a comment recording what it targets and why, so that
repair is possible when Torn changes the markup.

Failure states:

- Scrape returned nothing → panel shows a read failure, names what it could not
  find, offers a retry.
- Catalogue drift → notice naming the course, bundled value, and observed value.
- Multiplier underdetermined → observed range shown, player asked to confirm.
- Import string invalid → rejected with the reason; existing plan untouched.

## Persistence and sharing

Plan state — queue, overrides, budget, panel settings — persists in script
storage via `GM_setValue` / `GM_getValue`, keyed per Torn account.

Export produces a copyable text string encoding the queue and modifiers, so a
plan can be pasted into faction chat or a forum post. Import parses it
defensively: validated against the catalogue, unknown codes rejected with a
named reason, never evaluated as code. The import string is untrusted input and
is treated as such.

No server, no accounts, nothing leaves the browser unless the player copies it
out deliberately.

## Security surface

- `@match https://www.torn.com/page.php*` with a runtime `sid=education` guard.
  Tampermonkey cannot match query strings precisely, so the match is
  deliberately broader than the target page and the runtime guard does the real
  work. This reasoning is recorded in the script, per repo rule 4.
- `@grant GM_setValue`, `@grant GM_getValue`. The repo's default is
  `@grant none`, to be argued against rather than for. The argument: plan data
  survives a site-data clear, and is not readable by torn.com's own page
  scripts. Both matter for data the player may have spent months building.
- `@connect` is not required — the script makes no network requests.
- No API key, so no secret reaches the script. Repo rule 5 holds trivially.
- Torn navigates without a full page load, so the script observes for
  navigation and mounts and unmounts accordingly rather than assuming a single
  page load.

## Testing

The engine is tested in Node under `npm test`, with no browser:

- Schedule arithmetic against fixed `now` values.
- Order-independence of the total — a property test asserting that any legal
  permutation of a queue yields the same finish date.
- Prerequisite validation: tier-1 gating, bachelor gating, cycle rejection.
- Multiplier derivation: band intersection, snapping, and the underdetermined
  case producing a range rather than a guess.
- Fixed-point convergence, including the assertion that it terminates.
- Import parsing: malformed, hostile, and stale-catalogue inputs.

The adapter is tested against **saved HTML fixtures** captured from the real
education page. Fixtures are what make the scraping layer testable at all, and
capturing them is a prerequisite for implementing that layer.

## Release sequence

| Version | Contents |
|---|---|
| v0.1.0 | Catalogue, engine, panel, hand-built queue, finish date, local persistence |
| v0.2.0 | Row ordinals, multiplier derivation, drift notice |
| v0.3.0 | Consumable budget and fixed point |
| v0.4.0 | Ordering modes |
| v0.5.0 | Guide presets, export/import string |

Each version tags, and moves `@version`, the `CHANGELOG.md` heading, and the
git tag together in one commit, per repo rule 3.

## Open items

These block implementation of specific layers, not the design:

1. **Page structure unknown.** Whether all degrees render at once or lazily per
   degree, and the granularity durations display in. This sets both the scrape
   strategy and how tight the multiplier snap can be. Resolved by capturing the
   real page.
2. **HTML fixtures not yet captured.** Required before the adapter layer.
3. **Book of Carols reduction unverified.** Sources conflict; must be checked
   in-game before the v0.3.0 release.

## Decisions and alternatives

| Decision | Chosen | Rejected |
|---|---|---|
| Data source | DOM with manual what-if overrides | Torn API (adds a key and a setup flow, killing the lightweight feel) |
| Catalogue | Bundled with live reconcile | Bundled-only (stales silently); scrape-only (fails on lazy rendering) |
| Perk input | Derived from the page | Player enumerates merits, rank, stock block |
| Host page changes | Ordinal and highlight only | Inline text badges (more selector dependency) |
| Sharing | Export/import string | Shareable URL (parses untrusted input on a page holding a live session) |
| Storage | `GM_setValue` | `localStorage` under `@grant none` |
