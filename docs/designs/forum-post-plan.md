# The forum post — a beginner's guide to Torn education

**Status:** paste-ready BBCode implemented and verified; awaiting owner review and publication.
**Date:** 2026-08-05
**Draft:** `docs/forum-post.md`
**Verifier:** `node scripts/verify-forum-post.js --require-raw`

## Editorial direction

The post is a welcoming, practical beginner guide and a light advertisement for
Torn Education Scheduler. It does not name, link, count, or criticise any other
education article. Earlier research is input only and is never cited.

The public structure is:

1. What education is and why the slot should stay active.
2. Tiers, prerequisites, and bachelor's requirements.
3. A four-week blood-bag foundation.
4. Fighting, crime, trader/collector, and undecided starter routes.
5. The scheduler's balanced ordering rule and its limits.
6. The approved benefit-taxonomy table, with Working Stats separate.
7. Specialised courses to consider later.
8. A short Greasy Fork advertisement.

The tone is positive and beginner-first. “Courses to consider later” is advice,
not a blacklist. Historical discrepancies remain private fact checks rather than
public material.

## Sources and claims

The current `educationInitData` payload is authoritative for course names,
prerequisites, durations, costs, working-stat gains, and listed outcomes. The
approved taxonomy supplies the human classification of those outcome strings.
Route choice and “consider later” guidance are clearly presented as judgement,
not as facts returned by the payload.

Published time and cost figures use `originDuration` and `originCost`. The
capturing account's `actualDuration` is never published because it includes
personal reductions.

A fresh payload captured on 2026-08-05 contained 12 categories and 131 courses.
Its catalogue fields are identical to the committed scrubbed fixture. The raw
capture remains in `tests/fixtures/raw/`, which is gitignored because it contains
account state.

## Implemented starter routes

Every route is expanded with the scheduler's own `requiredCoursesFor()` helper
and checked with `validateQueue()` against an empty completed set.

| Route | Base days | Base cost | Courses | Remaining at day 182 |
| --- | ---: | ---: | ---: | ---: |
| Foundation | 28 | $3,700 | 2 | 0 |
| Fighting | 231 | $22,530 | 12 | 49 |
| Crime | 252 | $20,180 | 15 | 70 |
| Trader / collector | 203 | $13,850 | 10 | 21 |
| Undecided sampler | 210 | $29,950 | 15 | 28 |

The foundation is deliberately separate: complete `BIO1340` and `BIO2127`
first, then choose a follow-on set. This guarantees that the immediately useful
blood-bag unlock is not delayed by a larger preset's general-purpose ordering.

Route membership lives in `scripts/forum-post-data.js`. It is the single source
for the future guide presets; presets will carry course sets only. Live queue
order remains the scheduler's responsibility.

## Ordering explanation

With Focus ordering selected and no focuses chosen, the script uses its balanced
default:

1. future gain multipliers;
2. quantified benefits, normalised by benefit type and ranked per day;
3. unlock-only or unscored courses.

Prerequisites always outrank those preferences. The post calls this a heuristic,
prints no absolute score, and states that ordering changes time-to-benefit rather
than total finish time. A player wanting a particular unlock is directed to
select that goal in Focus.

## Approved taxonomy

The nine approved classified categories contain 120 selection-to-course links
covering 100 courses. They expose 75 distinct selection labels overall. The
category rows add to 79 selections because four labels are intentionally reused
across categories. Working Stats remains a separate tenth category calculated
directly from the payload.

The verifier requires the registry to remain at zero stale and zero unmapped
outcomes before the draft passes.

## Private fact checks

Ten course-level checks cover the factual discrepancies found during research.
They are executable assertions in `scripts/forum-post-data.js`, not a public
corrections section. The verifier also pins:

- Business: 259 base days and $12,800.
- Law: 266 base days and $28,745.
- the fixture's uniform 0.60 duration ratio, as a capture-integrity check only.

## Publication and URL sequence

The Greasy Fork listing is live, so the draft links directly to:

`https://greasyfork.org/en/scripts/590070-torn-education-scheduler`

`FORUM_POST_URL` remains unresolved until the owner publishes the post. After
publication:

1. insert the real Torn thread URL into `FORUM_POST_URL`;
2. update the URL-state tests;
3. bump the userscript patch version and changelog as part of that release;
4. run the complete release verification before tagging.

No publication, external write, tag, or userscript release is part of the draft
implementation.

## Verification

Routine repository check:

```text
npm run verify:forum
```

Pre-publication check requiring a fresh local capture:

```text
node scripts/verify-forum-post.js --require-raw
```

The verifier checks route prerequisites and totals, taxonomy approval and
health, private payload facts, required draft figures, the Greasy Fork link,
and the absence of direct references or links to other articles.

## Definition of done

- [x] Owner direction captured.
- [x] Fresh payload captured and catalogue-compared.
- [x] Publish-ready BBCode draft written.
- [x] Every route validated from an empty completed set.
- [x] Every published duration uses base/original duration.
- [x] Every published cost uses base/original cost.
- [x] Ordering explanation matches the implemented balanced default.
- [x] No absolute ranking score or finish-time claim appears.
- [x] Approved taxonomy rows only; registry health is zero stale/unmapped.
- [x] Greasy Fork advertisement carries the real URL.
- [ ] Owner reviews and publishes the forum post.
- [ ] Published thread URL is inserted into `FORUM_POST_URL` and released.
