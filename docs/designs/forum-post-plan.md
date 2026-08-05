# The forum post — a beginner's guide to Torn education

**Status:** ready to draft. Blocked on the owner's voice and a fresh payload
capture. Nothing here is written.
**Date:** 2026-08-05
**Moved from:** `docs/designs/v0.2.0-scope.md` § J3, which is now a bare pointer
to this file. This document is the complete and only record; the scope doc
carries no copy of it.

## Why this has its own document

§ J3 was a section inside a scope document that had grown past eleven hundred
lines. The post is the largest single piece of unwritten work left on the
project, it gates § J1 (guide presets), and it carries a factual liability the
rest of the project does not — it asserts the existing community guides are
wrong on ten specific points, in public, under the owner's name.

That deserves its own file, its own material, and its own re-verification rule.

## What it is

A guide to Torn education for a complete beginner, for the Torn forums.

- **Aimed at a total novice.** What education is, why starting early matters,
  how tiers and prerequisites work, what a bachelor's degree actually gates on.
- **Better organised and more engaging than the nine guides** in
  `docs/initial-spec.md`. Those are long, repetitive, and contradict each other
  — which is the gap this fills.
- **Ends with a short advertisement for the script** and where to download it.
  The Greasy Fork link comes later; leave a clear placeholder.

---

## The payload is the source of truth

**Every factual claim is checked against `educationInitData` and nothing else** —
not the nine guides, not this repository's prose, not recollection. It is Torn's
own backend response, the data the page renders *from*, with no transcription
layer in between.

Not a formality: the guides are wrong often enough that writing from them would
reproduce their errors under a new byline, and a post whose selling point is
"the old guides are wrong" is exactly what readers will fact-check.

**Re-capture before publishing.** `tests/fixtures/education-init-data.json` is a
2026-08-03 snapshot of one account. Fetch a fresh payload, diff it against the
fixture, and confirm every claim still holds. Regenerate with
`node scripts/scrub-fixture.mjs` after dropping a fresh capture into
`tests/fixtures/raw/`.

> **Never commit `tests/fixtures/raw/` or `tests/fixtures/*.html`.** Both are
> gitignored, and the saved page carries a `logoutHash` and a signed JWT.

---

## Material

### Starter paths — 3 to 6 of them

Concrete opening paths, one per gameplay type, so a reader leaves with something
to enrol in rather than a wall of options.

- **3 to 6 paths**, each aimed at a recognisable player type — fighting, crime,
  money, undecided. Pick archetypes from what the courses actually reward.
- **Assume a poor new player**: no Book of Carols, no job points, no merits, no
  Principal rank, no stock block. Time and almost nothing else.
- **First 6 to 12 months only.** Opening paths, not routes to finishing
  education. Say where each ends and why that is a sensible place to reassess.
- **Balance them mathematically.** Rank candidates by benefit per day and
  justify the order — each path should survive "why not this course instead?".
- Give each a total in days and dollars, and a 6-month checkpoint.

Two methodological traps, both confirmed in a trial run on 2026-08-04:

1. **Use `originDuration`, never `actualDuration`.** The fixture's
   `actualDuration` carries the capturing account's 40% reduction. A new player
   has none of it, so every published figure must come from `originDuration`, or
   the paths will promise roughly a third less time than they take. The single
   easiest way to get this section wrong.
2. **Validate every path with `validateQueue` against an empty completed set.**
   Prerequisite chains are not obvious by eye — several Computer Science courses
   hang off `CMT2530` rather than the intro, so a hand-written crime path can
   look right and be unfollowable.

A trial run of five candidate archetypes came out between 84 and 336 days and
$2,400 to $28,530, all prerequisite-clean, so the shape is workable. The paths
are not written and are not fixed by that run.

### The ordering advice — reference the script's own default

"What order should I take courses in?" is the question a beginner actually
asks, and the nine existing guides answer it inconsistently. The script now has
an opinion, and **the post should explain that opinion rather than invent a
second one.** One answer, in both places — the same rule that sequences § J1's
presets after this post.

The default ordering, as briefed to the implementation (v0.5.0, superseding
§ H2):

> **Groups, as briefed: gain multipliers first (Gym Gain Bonus, Education
> Working Stat Rewards, Crime Exp/Skill — things that multiply a rate, which is
> your "% increases to gains"), then quantified benefits by normalised score per
> day, then unlocks last.**

**Why each group is where it is — the part worth writing up:**

- **Gain multipliers first** because they multiply a *rate*, so they compound
  over everything queued behind them. Taking Education Working Stat Rewards
  (+10% working stats on all future educations) early pays on every course that
  follows it; taking it last pays on nothing. This is the single most useful
  thing the post can tell a new player, and no existing guide says it plainly.
- **Quantified benefits next**, ranked by measurable benefit per day — so a
  short course with a real gain beats a long one with the same gain.
- **Unlocks last** because they carry no number to rank by. Note for the post:
  this is a *default*, and a player who wants a specific unlock should say so —
  which is what the Focus view is for.

**What the post must NOT claim about it.** This is the section most likely to be
quoted back:

- **It is a heuristic, not an optimum.** Call it a sensible starting point.
  Anyone with a goal should pick a focus and let the queue re-sort.
- **Do not present the per-day scores as quantities.** Benefit types are
  normalised against the catalogue's maximum so no type dominates by unit
  choice; that makes them comparable *for ranking* and meaningless as absolute
  values. A post that prints "this course scores 1.8" is claiming a precision
  that does not exist.
- **Do not claim any ordering finishes education sooner.** Courses run one at a
  time, so the total is a sum and a sum does not care about order. Ordering
  changes how early each benefit starts paying. Several community guides blur
  exactly this, and it is one of the corrections below — so contradicting it
  here would be self-defeating.
- **The percentage-to-number conversion has one honest case and the post should
  not imply more.** Only working stats earned from completed courses give a real
  base. The payload carries no battle stats, no company data and no jail record,
  so "2% passive defense" has no absolute value anywhere — it is ranked, not
  measured.

### Which degrees not to start early

Business runs 259 days and pays off only for a company director; Law is 266 days
for busting and bailing, which the guides themselves call inefficient. Naming
what to skip is as useful to a new player as naming what to take, and no
existing guide leads with it.

### The focus taxonomy table

The v0.3.0 Focus work (§ H3) produced a classification of all 101
`learningOutcomes` into nine categories, with per-category counts of selections,
course links and distinct courses. That table answers a question the nine guides
never do — **what can education actually give you, and how much of it is left**
— and it is derived entirely from the payload, so it meets the source-of-truth
rule above without further checking.

Carry it into the post as a table. `focus-taxonomy.xlsx` is the working copy the
owner marks up; **the post takes the approved category rows only, never the
120-row detail sheet.**

### Verified corrections as material

Confirmed against the payload on 2026-08-04. Useful for a "what the old guides
get wrong" section, which doubles as the credibility hook — each is checkable by
any reader in about ten seconds.

| Course | Guides claim | Game returns |
| --- | --- | --- |
| BIO2410 Anatomy | +5% crit (five guides) | **3% chance increase of achieving a critical hit** |
| MTH3330 Bachelor of Mathematics | +30% ammo | **20% bonus to ammo conservation** |
| CBT2820 Study of Machine Guns | +5% accuracy | **+1.00 accuracy increase** — flat, not a percentage |
| DEF2730 Krav Maga | +1% defense | **2% passive bonus to defense** |
| BIO2380 Neurobiology | damage to the *neck* | damage to an opponent's **throat** |
| BIO2400 Forensic Science | stealth −25% | **decrease stealthiness by 0.5** |
| HAF3111 | 50% decrease in escape chance | **25% increase in speed during an escape attempt** |
| DEF3770 | "Master of Self Defense" | **"Bachelor of Self Defense"** |
| LAW2910 | "Law of Property" | **"Property Law"** |
| BIO1340 | "Introduction to Biology" | **"Introduction to Biochemistry"** |

**The pattern is the story:** on the first three rows the *majority* of guides
agree with each other and are wrong, while a lone dissenter had Anatomy and the
Mathematics bachelor right. Consensus among stale sources is not evidence.

**The strongest correction is not in the table.** Guide 7 states outright that
education reductions multiply — "the max you can get from perks is
.8\*.9\*.9 = .648". They add. An account holding all three documented perks
shows exactly 0.60, which is 20 + 10 + 10, and a larger reduction than the
guides say is possible. **Re-confirm against a fresh payload before asserting
it: it rests on one account's perk set.**

The payload also contains courses no guide mentions — `CMT2230`, `CMT2130`,
`CMT2131`, `CMT2128`, `CMT2129`, `PSY2132`, `CMT2570`, `CMT2590`, `GEN2114` —
added for Crimes 2.0, years after most of those posts. The cleanest illustration
of why a maintained tool beats a forum post from 2019.

---

## Blockers, both real

1. **The owner's voice.** This is editorial work. It is the one deliverable on
   the project that cannot be generated and then reviewed — a guide written in a
   voice the owner would not use is worse than no guide, because it goes out
   under their name.
2. **A fresh payload capture.** The corrections rest on a capture from
   2026-08-03. Torn rebalances. Every claim gets re-checked against a current
   capture before publication, not after.

## Sequencing — this before presets, deliberately

§ J1 (guide presets) fills the queue from a named route. **The starter paths
written for this post ARE the presets.** Doing the research once and shipping it
in both places is the point; building presets first means inventing routes
twice, and the two would drift.

Presets carry only *which courses a route contains* — never the guides' claims
about what those courses do.

**Order within a preset comes from the script, not from the preset.** A preset
is a set of courses; the queue then orders it by whatever Queue order is set,
which with nothing selected is the balanced default described above. So a preset
does not need to encode an order, and must not — encoding one would give a
player two orderings that can disagree, with no way to tell which is live.

## The URL placeholder

The post's closing advertisement needs the Greasy Fork listing, which does not
exist yet. `FORUM_POST_URL` in the userscript points the other way — the panel
links to this post — so the two resolve in **two passes**, not one:

1. Script published to Greasy Fork → `GREASY_FORK_URL` resolves → the post's
   advertisement can be written.
2. Post published → `FORUM_POST_URL` resolves → the panel's guide link and
   footer start rendering.

Tracked as § K1. The placeholder guard test (`tests/metadata.test.js`) fails a
tagged release that still carries an unresolved placeholder.

## Re-verification rule (§ K3)

The post asserts the community guides are wrong on ten specific points. **If a
correction stops being true, the post becomes the thing it was written to
replace — a confident, stale guide.**

Re-check when Torn changes education, not on a schedule. A "varies by course"
reduction label appearing in a debug report is one signal that something
underneath has moved.

This applies to the ordering section as much as to the corrections table: it is
a factual claim about the catalogue, so if Torn rebalances which courses carry
gain multipliers, the advice goes stale the same way.

## Definition of done

A published forum post, its URL in `FORUM_POST_URL`, and every factual claim in
it verified against a payload captured no more than a few days before
publication.

Specifically, before publishing, confirm:

- [ ] Every figure comes from `originDuration`, not `actualDuration`.
- [ ] Every starter path passes `validateQueue` against an empty completed set.
- [ ] The ordering section matches what the script actually does. If the
      implementation's grouping has moved since this document was written, the
      post follows the code — the code is what readers will run.
- [ ] No score is printed as an absolute quantity.
- [ ] No claim anywhere that an ordering finishes education sooner.
- [ ] The ten corrections re-checked against the fresh capture.
- [ ] The additive-perk claim re-confirmed — it rests on one account.
- [ ] The taxonomy table uses approved category rows only.
- [ ] The closing advertisement carries a real `GREASY_FORK_URL`.
