# Next session — paste this into a fresh chat

> Delete this file once the v0.3.0 QA gate is underway; it is a launch pad, not a document.

## Start here

Run `/orient` before anything else, including clarifying questions. Then take
v0.3.0 through its browser QA gate: ask the owner for their QA results, fix
whatever they found on this branch, then merge and tag.

**Ask the owner for their QA results before touching code.** The build is
finished and reviewed; nothing is known to be wrong. If QA found nothing, the
whole job is merge and tag. If QA found defects, fix them on the existing
branch — do not open a new one, and do not re-plan the release.

## Read first

Read nothing else until you have these, in order:

1. `docs/designs/v0.2.0-scope.md` (55.5K) — the phase contract, and the single
   home for all unshipped work despite its name. **Read in slices, not whole.**
   Start at the `## Handoff log` heading and read the 2026-08-05 v0.3.0 entry to
   its end: it carries the do-not-revert list, six corrections the build made to
   its own plans, and what is still open. Sections § H1, § H2, § J1–J3 and
   § K1–K3 are later work — read them only if the conversation turns there.
2. `docs/qa-checklist.md` (22.7K) — the gate itself, and the only QA this
   project gets: `CLAUDE.md` turns `/qa` and `/browse` off because Torn is a
   third-party site behind a login. Small enough to read whole. § A, § B, § M
   and § N are the cases with the least automated cover behind them.
3. `docs/designs/v0.3.0-focus-mode.md` (16.1K) — the largest new feature and the
   one a QA defect is most likely to land in. Read whole; it is the contract for
   the Focus view, the taxonomy and the never-summed ranking rule.
4. `docs/code-map.md` (131.1K) — the symbol index for the userscript. **Read in
   slices:** grep it for the symbol you need, then read only that row's anchors.
   It is hand-curated prose — a blind `/code-map` regeneration destroys it.
5. `torn-education-scheduler.user.js` (203.7K) — the release artifact. **Never
   open it whole; a repo rule forbids it.** Grep `docs/code-map.md` for the
   symbol, then `Read` with `offset`/`limit` around that anchor.

## Branch

`feat/v0.3.0-focus-and-ui` — 41 commits on top of main, which sits at commit
d605988 and is still v0.2.0. Head is 349951b. **Nothing is merged, tagged or
pushed**, and no PR exists.

**Work on this branch.** Do not branch from `main` — it does not contain any of
this release. Do not open a second branch for QA fixes; they belong here.

## Constraints

- **Six corrections are marked do-not-revert** in the handoff entry. The
  load-bearing ones: `focusScores` must reach `orderQueue`'s fourth argument or
  the whole Focus feature silently reorders nothing; `normaliseCourse` must
  carry `learningOutcomes` and `workingStatsGain` through; `FOCUS_UNSTATABLE`
  must contain every selection whose outcomes read `up to N%`, or the panel
  prints an invented total; `.tes-nav` must carry exactly one
  `margin-left: auto`; and `shareText` uses the pruned queue in **storage
  order**, never the ordered queue.
- **`docs/code-map.md` is hand-curated prose.** Hand-shift anchors; never run
  `/code-map` or any regeneration tool on it without reading the diff first.
  `tests/code-map.test.js` enforces exact ranges, per-file test counts and the
  userscript's line count.
- **Do not widen the security surface.** One `@match`, exactly `GM_setValue` and
  `GM_getValue`, no `@connect`. `@downloadURL`/`@updateURL` are post-launch and
  deliberately absent; `tests/metadata.test.js` fails if they appear.
- **`@version`, `SCRIPT_VERSION`, `package.json` and the newest `CHANGELOG.md`
  heading all read `0.3.0`** and must move together if anything bumps them again.
- **The tag goes on the merge commit, not the branch head.** v0.1.0 and v0.2.0
  were both tagged that way; tagging the branch head would orphan the tag if the
  PR is squashed.
- **Zero dependencies, no lockfile, no build step.** Tests are `node --test` only.
- **Never commit `tests/fixtures/raw/` or `tests/fixtures/*.html`** — both are
  gitignored and the saved page carries a `logoutHash` and a signed JWT.
- **No attribution footers** in commit messages, PR bodies or release notes.
- If a QA fix moves declarations, **`docs/code-map.md` must be updated in the
  same commit**.

## Exit criteria

- `npm test` green (suite is at 476 now)
- `npm run test:syntax` exits 0
- Every defect the owner's QA reported is either fixed on this branch or
  recorded in `docs/designs/v0.2.0-scope.md` with the reason it was deferred
- A PR from this branch is merged into `main`
- A `v0.3.0` git tag exists and points at the merge commit
- `docs/designs/v0.2.0-scope.md`'s handoff log contains a dated entry recording
  the QA outcome and the merge
- This file is deleted

## Unknowns and risks

- **Browser QA has never been run on any of this.** 41 commits, 476 automated
  tests, and not one minute against a live Torn account. The highest-value
  checks are § B3 (block the education endpoint and confirm the React fiber
  fallback fires — still the most under-tested code in the repo), § A2
  (`#tes-fallback-mount` must be `null`, or the panel pinned itself to the
  viewport), and the TCT confirmation, which only a real account can prove.
- **The design-token pass changes three visible things, not one** — greys shift
  to Bookie's values, sections gain spacing, and type sizes move (base
  13px → 14px, several rules gaining an explicit 12px). The checklist says so.
  Without that, a tester reads the size change as an unexplained regression.
- **macOS players see no bachelor marker at all.** Colour replaced the
  `[bachelor]` prefix and macOS draws its own `<select>` menus, ignoring option
  colour. Owner-agreed trade, covered by checklist case C1a. It is the one place
  a player on one platform gets less information than another, and worth a line
  in the release notes.
- **`MAX_MOUNT_ATTEMPTS = 20` still has the wrong shape**, carried unchanged
  from v0.2.0. The counter never decays, so the realistic exhaustion path is a
  long dwell on the education page, not a render burst. QA watch item, not fixed.
- **Two defensive branches cannot be exercised by real data** — `focusScores`'
  summing path and `focusTotals`' by-course dedupe, because no
  `(category, selection, courseId)` triple repeats in the taxonomy. Canary tests
  fail the day one appears. Do not "fix" this by deleting the branches.
- **The mockup round of the design review is specified and deliberately not
  run** — see § H6's "The remaining design work". The high-ROI token pass ran
  first on purpose; mocking up a baseline that pass was about to change would
  have wasted the mockups.
- Working tree is clean; nothing is uncommitted.
