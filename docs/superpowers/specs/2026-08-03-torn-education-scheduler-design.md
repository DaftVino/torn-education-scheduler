# Torn Education Scheduler — Design

Date: 2026-08-03
Status: approved (design), revised after live-data probe, pending implementation plan

## Purpose

Torn's education system runs one course at a time and takes years to complete.
Players currently answer "when do I finish?" with private spreadsheets, rebuilt
from scratch by each player and shared as forum posts that drift out of date.

This userscript replaces that spreadsheet. It runs only on
`https://www.torn.com/page.php?sid=education`, reads the player's own progress,
lets them build a queue of courses, and computes the exact finish date and time
for the whole path.

## Scope

In scope:

- Course queue with prerequisite validation.
- Finish date and time for the queue, and cumulative finish per course.
- A consumable budget (job points, Book of Carols) bounded by the schedule.
- Ordering modes that front-load benefit.
- Presets drawn from the community guides.
- Export/import of a plan as a text string.

Out of scope:

- The public Torn API. No API key, therefore no secret in the script.
- Modelling perks acquired part-way through the schedule.
- Any server, account, or hosted component.
- Recommending *which* courses to take. Presets carry guide recommendations;
  the script does not editorialise beyond them.

## The data source

The education page is a React bundle (`webpackChunk_torn_education`) that
fetches its state from:

```http
GET /page.php?sid=educationInitData
```

Same-origin, session cookie sent automatically, no API key, no `@connect`
needed. It returns the complete model. Every course carries:

```json
{ "id": 34, "prefix": "BIO1340", "name": "Introduction to Biochemistry",
  "description": "...", "status": "completed",
  "learningOutcomes": [], "workingStatsGain": ["Gain 50 intelligence..."],
  "tier": 1,
  "originDuration": 604800, "actualDuration": 362880,
  "originCost": 200, "actualCost": 200,
  "parentId": null }
```

Plus `activeCourse`, carrying the exact finish timestamp of the course in
progress:

```json
"activeCourse": { "id": 119, "category": 12, "name": "General Science",
                  "completedAt": 1786497780 }
```

**The script never parses HTML for data.** Durations, costs, statuses, the
prerequisite graph, and the current course's finish time all arrive as typed
JSON. Selectors survive only for mounting the panel and drawing row markers —
cosmetic surface, where a break is visible and harmless, rather than
load-bearing surface where a break produces a wrong date.

This matters because Torn's class names are CSS-module hashes
(`courseWrapper___MMeaD`, `courseIndicator___njtf2`). The `___XXXXX` suffix is
generated at build time and changes whenever Torn rebuilds its frontend. Any
selector the script does keep must match on the stable prefix
(`[class*="courseWrapper___"]`), never the full hashed name. This is a rule,
not a preference.

Acquisition order, most to least preferred:

1. `fetch('/page.php?sid=educationInitData')` — the primary path.
2. The React fiber props, where the same `sections` array is reachable — a
   fallback if the endpoint changes shape or name.
3. A bundled catalogue snapshot — offline fallback only, and the source for
   preset course lists. It cannot supply the player's own status or durations.

## What the live data overturned

An earlier draft of this design was built on the assumption that the page
displayed rounded durations in text. Two sections were wrong, and one of them
would have shipped a wrong answer.

### The perk multiplier needs no derivation

The earlier design proposed deriving the player's perk reduction from rounded
display text, by collecting `(base, reduced)` pairs, intersecting their
constraint bands, and **snapping to the nearest achievable value** — where the
achievable set was computed from the guides' model of the three documented
reduction perks (merits −20%, Principal −10%, WSU block −10%, multiplied:
`0.8 × 0.9 × 0.9 = 0.648`).

The live data gives `originDuration` and `actualDuration` as exact integer
seconds, per course, for every course including locked ones. The ratio is
constant across all 131 courses in the captured sample:

```text
604800 → 362880    1209600 → 725760    1814400 → 1088640
2419200 → 1451520  3024000 → 1814400   3628800 → 2177280
4233600 → 2540160
```

Every one is exactly `0.6`.

**`0.6` is not in the achievable set the earlier design would have snapped
to.** The guides' model puts the maximum reduction at `0.648`; the observed
value is a larger reduction than the model says is possible. The snap would
have silently moved a correct `0.6` to an incorrect `0.648` — a 7.4% error
compounded across a multi-year queue, presented with full confidence.

So: **the multiplier is read, never derived.** The whole band-intersection
mechanism is deleted. The core calculation does not need to know why the
player's reduction is what it is, only what it is.

#### Reduction perks stack additively, not multiplicatively

The player whose account produced this capture holds all three documented
reduction perks: 10 education merits (−20%), Principal rank in the Education
starter job (−10%), and the West Side University stock benefit block (−10%).

- Additive: `1 − (0.20 + 0.10 + 0.10)` = **`0.60`**
- Multiplicative, as guides 7 and 8 assert: `0.8 × 0.9 × 0.9` = `0.648`

The observed ratio is `0.60` exactly. **The guides are wrong about stacking.**
Guide 7 states the claim explicitly — "The −% perks don't stack additively, but
are multiplied together. So the max you can get from perks is .8*.9*.9 = .648"
— and the live payload contradicts it.

Scope of the claim: this confirms the three perks *together* yield exactly 40%.
It does not independently prove each perk's individual contribution, since only
the combined figure is observable on one account. What-if overrides therefore
assume additivity across arbitrary subsets, which is the natural reading but
remains an assumption. It becomes falsifiable the moment any player's observed
ratio disagrees with the sum of the perks they hold — so the panel reports both
the observed ratio and the predicted one, and flags a mismatch rather than
hiding it.

One further observation the calculation does not depend on: `originCost` equals
`actualCost` for every course in the sample, so no cost reduction is in play.
The field exists, so the model supports one.

### Prerequisites are a real tree, not a tier heuristic

The earlier design encoded the guides' rule: a tier-1 introduction unlocks the
tier-2 courses in its degree, and all tier-2 courses gate the tier-3 bachelor.

`parentId` shows this is too coarse. Prerequisites chain arbitrarily deep
within a category:

- `BIO2370` → parent `BIO2360` → parent `BIO1340`
- `CMT2129` → parent `CMT2128` → parent `CMT2570` → parent `CMT1520`
- `MTH2320` → parent `MTH2260` → parent `MTH1220`
- `CMT2610` → parent `CMT2540` → parent `CMT1520`

A tier-based model would let the player queue `MTH2320` immediately after
`MTH1220` and produce a schedule they cannot actually follow.

**`parentId` is the prerequisite graph.** The one rule not present in the data
is tier-3 gating: bachelors have `parentId: null` but require every tier-2
course in their category. That rule is encoded separately, and is the only
prerequisite knowledge the script holds that Torn did not hand it.

### The guides are worse than "contradictory"

The initial spec's nine community guides disagree with each other, which the
earlier draft catalogued. The live data now resolves each conflict — and in
most cases **the majority of guides are wrong**:

| Item | Guide majority | Live data |
| --- | --- | --- |
| BIO2410 Anatomy | +5% crit (5 guides) | **+3% crit** (1 guide) |
| MTH3330 Bachelor of Maths | +30% ammo (2 guides) | **+20%** (1 guide) |
| DEF2730 Krav Maga | +1% defense | **+2% defense** |
| BIO2380 Neurobiology | damage to the *neck* | damage to the **throat** |
| BIO2400 Forensic Science | stealth −25% | **stealthiness −0.5** |
| CBT28xx weapon studies | +5% accuracy | **+1.00 accuracy** (flat, not %) |
| HAF3111 | 50% decrease in escape chance | **+25% speed during escape** |
| DEF3770 | "Master of Self Defense" | **"Bachelor of Self Defense"** |
| LAW2910 | "Law of Property" | **"Property Law"** |
| BIO1340 | "Introduction to Biology" | **"Introduction to Biochemistry"** |

A majority vote across the guides would have been wrong on the first three
rows. The live data also contains courses no guide mentions at all — `CMT2230`
Web Design, `CMT2130` Web Security, `CMT2131` Automated Data Mining,
`CMT2128`/`CMT2129` Overclocking, `PSY2132` Interpersonal Dynamics, `CMT2570`,
`CMT2590` Quantum Computing, `GEN2114` Astronomy — evidently added for
Crimes 2.0, years after most of the guides were written.

**No duration, cost, outcome, or course list from the guides is authoritative
or is used as such.** The guides are used for exactly one thing: the
*membership* of preset paths — which courses a recommended route contains, and
whose recommendation it was. Everything displayed about a course comes from the
live payload.

## Architecture

Three layers with a hard boundary between them.

| Layer | Contents | Fragility |
| --- | --- | --- |
| `catalogue` | Bundled snapshot: offline fallback and preset course lists | Can go stale; cannot break |
| `engine` | Pure functions. No DOM, no network, no ambient clock | None — testable in Node |
| `adapter` | Fetch, panel render, row markers, storage | All of it |

The engine is the part worth testing. The adapter is the part worth guarding.

The engine takes an explicit `now`. It never reads the clock itself, because a
function that reads the clock cannot be tested against a fixed expected date.

### Data flow

```text
fetch /page.php?sid=educationInitData
  → parse and validate payload
  → engine.schedule(courses, activeCourse, queue, budget, now)
  → render panel + row markers
  ↺ user edits queue or budget → re-run engine → re-render
```

### The core calculation

Because `actualDuration` already carries the player's reductions, the base case
is one line:

```text
finish = activeCourse.completedAt + Σ actualDuration(queued) − consumableSeconds
```

The engine is genuinely small. The complexity that remains lives in
prerequisite validation, ordering, and the consumable fixed point — not in the
arithmetic.

## Ordering: what it does and does not do

**Ordering does not change the finish date.** Courses run one at a time, so the
total is a sum over the queue, and a sum is order-independent. Prerequisites
constrain which orders are legal; they do not change the total. The consumable
budget removes a fixed number of seconds regardless of when it is spent.

The spec asks for "the final date and time". That figure is order-independent,
and the UI says so plainly.

What ordering *does* change is **time-to-benefit**: how early each perk starts
paying off. This is the real content of "do Sports Science first" — the
bachelor's compounding gym-gain bonus is worth far more claimed a year earlier,
while the finish date is identical either way. Several source guides blur these
two things together. The UI will not.

Ordering modes:

- **As listed** — the player's own order, prerequisites enforced.
- **Shortest first** — by `actualDuration`, maximising early completions.
- **Days per bonus** — the efficiency metric from guide 7's table, recomputed
  from live durations rather than the guide's stale numbers.
- **Unlocks first** — bachelors and ability-unlocking courses as early as
  prerequisites allow.

All modes are a topological sort over the `parentId` graph, plus the tier-3
rule, with a different tiebreak.

## Consumable budget and its fixed point

The player enters how many job points and Books of Carols they expect to spend.
Per the initial spec, a job point buys 30 minutes off the current course, and a
10★ Fitness Center or Hair Salon supports about 5 hours per 24 hours. A Book of
Carols reduces the current course and carries a 6-hour booster cooldown.

Neither appears in `educationInitData`, so both stay user-entered.

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

A consumable can only reduce the course currently in progress, and cannot take
a course below zero. Surplus spend does not roll forward into the next course;
it is capped per course and the remainder reported as unusable.

The Book of Carols reduction is disputed in the sources — "past 2 hours"
(guide 2) against "−6 hours" (guides 7, 8, 9) — and does not appear in the live
payload. It is a named constant with the conflict recorded beside it, and must
be verified in-game before the v0.3.0 release rather than resolved by vote.

## UI

A collapsible themed panel, modelled on Torn Bookie Live Scores: default theme
matching Torn's styling, style settings, and an open/hide action.

The panel carries the queue, the reduction figure read from the payload,
what-if overrides, the consumable budget, and the schedule output.

Torn's own course list receives an ordinal marker and a highlight class on
queued courses. No text is injected into the host page's rows. This gives the
visual link between queue and list at a fraction of the selector dependency
that inline text badges would need — and each of those selectors uses prefix
matching against the hashed class names.

## Failure behaviour

Every host-site selector is null-guarded, and every failure is **visible in the
panel**. "Couldn't load your education data" beats a silently wrong date,
because a userscript that fails quietly reads to the user as the host site
breaking.

Failure states:

- Fetch failed or returned non-JSON → panel reports it, offers retry, falls
  back to React props, then to the bundled snapshot in read-only mode.
- Payload shape unrecognised — missing `actualDuration`, missing `parentId`,
  `success` not true → refuse to compute and say why. A schedule from a
  half-understood payload is worse than no schedule.
- `originDuration`/`actualDuration` ratio **not constant across courses** →
  surface it. The current model assumes one account-wide reduction; a
  per-course ratio would mean Torn changed the mechanic, and guessing would
  hide that.
- Mount point not found → panel falls back to a fixed-position container rather
  than not rendering.
- Import string invalid → rejected with the reason; existing plan untouched.

## Persistence and sharing

Plan state — queue, overrides, budget, panel settings — persists via
`GM_setValue` / `GM_getValue`, keyed per Torn account.

Export produces a copyable text string encoding the queue and modifiers, so a
plan can be pasted into faction chat or a forum post. Import parses it
defensively: validated against the catalogue, unknown course IDs rejected with
a named reason, never evaluated as code. The import string is untrusted input
and is treated as such.

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
  scripts. Both matter for a plan representing months of intent.
- `@connect` is **not** required. The only request is same-origin to
  `torn.com`, which the page already makes itself.
- No API key, so no secret reaches the script. Repo rule 5 holds trivially.
- Torn navigates without a full page load, so the script observes for
  navigation and mounts and unmounts accordingly rather than assuming one load.

## Testing

The engine is tested in Node under `npm test`, with no browser and no network:

- Schedule arithmetic against a fixed `now` and the captured fixture.
- Order-independence of the total — a property test asserting every legal
  permutation of a queue yields the same finish timestamp.
- Prerequisite validation over the real `parentId` graph, including the
  three-deep chains (`CMT1520 → CMT2570 → CMT2128 → CMT2129`), tier-3 gating,
  and cycle rejection.
- Reduction-ratio constancy, including the failure path when it is not
  constant.
- Fixed-point convergence, including that it terminates.
- Payload validation: missing fields, `success: false`, unknown status values.
- Import parsing: malformed, hostile, and stale-catalogue inputs.

### Fixtures

The **JSON payload is the fixture**, not saved HTML. A saved copy of the page
contains one `courseWrapper` and zero course codes, because React renders the
list client-side after fetching — so HTML is useless for testing the data path.

Saved page captures are additionally **unsafe to commit at all**: a capture
taken while logged in embeds `userID`, `logoutHash`, and a signed websocket JWT
in inline script tags. `tests/fixtures/*.html` is therefore gitignored
wholesale. Keep a capture locally if a panel-mount reference is useful; it never
enters the repository. gitleaks did not flag these, which is the point — the
control that works here is not committing the file.

The captured payload is personal data: it encodes which courses this account
has completed and when the current one finishes. **It is scrubbed before it is
committed.** `scripts/scrub-fixture.mjs` reads a raw capture from
`tests/fixtures/raw/` — which is gitignored and never committed — and emits a
scrubbed fixture with a synthetic, deterministic progress state. The catalogue
itself is identical for every player and is preserved intact.

This holds regardless of the repo's visibility today, so that a later decision
to go public never has to re-litigate it.

## Release sequence

| Version | Contents |
| --- | --- |
| v0.1.0 | Payload fetch, engine, panel, hand-built queue, finish date, local persistence |
| v0.2.0 | Row markers, prerequisite validation surfaced in the UI, drift and failure states |
| v0.3.0 | Consumable budget and fixed point |
| v0.4.0 | Ordering modes |
| v0.5.0 | Guide presets, export/import string |

Each version moves `@version`, the `CHANGELOG.md` heading, and the git tag
together in one commit, per repo rule 3.

## Open items

1. **Book of Carols reduction.** 2h vs 6h, absent from the payload. Verify
   in-game before v0.3.0.
2. **Whether `actualDuration` updates live** as job points are spent on the
   current course, or only recalculates at course start. Affects whether the
   consumable model can be validated against the payload.

Resolved: the reduction stacking rule. Confirmed additive — see *Reduction
perks stack additively, not multiplicatively* above. What-if overrides are in
scope and ship with the ordering work.

## Decisions and alternatives

| Decision | Chosen | Rejected |
| --- | --- | --- |
| Data source | `educationInitData` JSON, same-origin | HTML scraping (fragile, and the data is not in the HTML); public Torn API (needs a key) |
| Catalogue authority | Live payload | Bundled table (stales silently); community guides (demonstrably wrong) |
| Perk reduction | Read from `actualDuration` | Derived from display text and snapped to a modelled achievable set — **would have produced a wrong answer** |
| Prerequisites | `parentId` graph + tier-3 rule | Tier heuristic from the guides (too coarse; permits illegal queues) |
| Host page changes | Ordinal and highlight only, prefix-matched selectors | Inline text badges; full hashed class names |
| Sharing | Export/import string | Shareable URL (parses untrusted input on a page holding a live session) |
| Storage | `GM_setValue` | `localStorage` under `@grant none` |
| Fixture | Scrubbed JSON payload | Saved HTML (contains no course data) |
