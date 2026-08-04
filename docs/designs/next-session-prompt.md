# Next session — paste this into a fresh chat

> Delete this file once the v0.2.0 merge is underway; it is a launch pad, not a document.

## Start here

Run `/orient` before anything else, including clarifying questions. Then take
v0.2.0 through its browser QA gate to merge: fix whatever the owner's QA found,
then merge PR #2 and tag `v0.2.0`.

**Ask the owner for their QA results before touching code.** The build is
finished and reviewed; nothing is known to be wrong. If QA found nothing, the
whole job is merge and tag. If QA found defects, fix them on the existing branch
— do not open a new one, and do not re-plan the release.

## Read first

Read nothing else until you have these, in order:

1. `docs/designs/v0.2.0-scope.md` (44.0K) — the phase contract. **Read in
   slices, not whole.** Start at the `## Handoff log` heading and read the
   2026-08-04 v0.2.0 entry to its end: it carries the do-not-revert list, the
   eight corrections the build made to its own plan, and what is still open. Read
   § H1 and § H2 only if the conversation turns to v0.3.0.
2. `docs/code-map.md` (79.3K) — the symbol index for the userscript. **Read in
   slices, not whole:** grep it for the symbol you need, then read only that
   row's anchors. It is 60% the size of the file it exists to let you avoid
   opening, which is itself a recorded finding — see "still open" in the handoff
   entry.
3. `tests/metadata.test.js` (2.3K) — small, read whole. It is the gate the merge
   and tag must not break: it asserts `@version`, `SCRIPT_VERSION` and
   `package.json` agree, that the security surface is exactly one `@match` plus
   `GM_setValue`/`GM_getValue` with no `@connect`, and that no `@downloadURL` or
   `@updateURL` has appeared.
4. `torn-education-scheduler.user.js` (134.5K) — the release artifact. **Never
   open it whole; a repo rule forbids it.** Grep `docs/code-map.md` for the
   symbol, then `Read` with `offset`/`limit` around that anchor.

## Branch

`feat/v0.2.0-planner-expansion` — 39 commits on top of `main`, which sits at
commit 075f3fd. Pushed, with **PR #2 open against `main`**. All thirteen build
tasks are complete and reviewed, and a final whole-branch review returned
ready-with-fixes which have landed.

**Work on this branch.** Do not branch from `main` — `main` is at v0.1.0 and does
not contain any of this release. Do not open a second branch for QA fixes; they
belong in this PR.

## Constraints

- **Six v0.1.0 corrections are marked do-not-revert** in the handoff entry, and
  the build added more. The load-bearing ones: prerequisites are summed into the
  schedule rather than merely validated; `finishLabel` **and** `totalLabel` are
  both withheld whenever `problems` is non-empty; `fetchEducationData` sends
  `rfcv` and never echoes a response body; and there are **two distinct notions of
  "completed"** — `completedIds` for "can this start today", `plannedCompletions`
  for "is this plan followable". Collapsing those two is the v0.1.0 bug this
  release fixed.
- **Do not widen the security surface.** One `@match`, exactly `GM_setValue` and
  `GM_getValue`, no `@connect`. `@downloadURL`/`@updateURL` are post-launch and
  deliberately absent; `tests/metadata.test.js` now fails if they appear.
- **`@version`, `SCRIPT_VERSION`, `package.json` and the newest `CHANGELOG.md`
  heading all read `0.2.0` and must move together** if anything bumps them again.
- **The tag goes on the merge commit, not the branch head.** v0.1.0 was tagged
  that way; tagging the branch head would orphan the tag if the PR is squashed.
- **Zero dependencies, no lockfile, no build step.** Tests are `node --test` only.
- **Never commit `tests/fixtures/raw/` or `tests/fixtures/*.html`** — both are
  gitignored and the saved page carries a `logoutHash` and a signed JWT.
- **No attribution footers** in commit messages, PR bodies or release notes.
- If a QA fix moves declarations, **`docs/code-map.md` must be updated in the same
  commit** — `tests/code-map.test.js` enforces exact ranges, every backticked
  symbol per row, the file's line count and per-file test counts.

## Exit criteria

- `npm test` green (suite is at 342 now)
- `npm run test:syntax` exits 0
- Every defect the owner's QA reported is either fixed on this branch or recorded
  in `docs/designs/v0.2.0-scope.md` with the reason it was deferred
- PR #2 is merged into `main`
- A `v0.2.0` git tag exists and points at the merge commit
- `docs/designs/v0.2.0-scope.md`'s handoff log contains a dated entry recording
  the QA outcome and the merge
- This file is deleted

## Unknowns and risks

- **Browser QA has never been run.** The panel has not been seen against a live
  Torn account. v0.1.0 passed a clean automated review with no CSS whatsoever, so
  assume visual defects survived review here too. The highest-value checks are the
  fiber fallback against a real React tree, `pushState` interception under
  Tampermonkey's `@grant` sandbox, and whether the panel mounts somewhere sensible
  rather than in the fixed-position `#tes-fallback-mount`.
- **The finding a player is most likely to hit on day one:** four of the settings
  view's eight fields drive no arithmetic. That is correct behaviour — job points
  are already reflected in `activeCourse.completedAt`, and the reduction is read
  from the payload rather than reconstructed from perks — but confirm the
  on-screen copy reads honestly, because the release notes originally claimed the
  opposite.
- **`MAX_MOUNT_ATTEMPTS = 20` has the wrong shape.** The counter never decays, so
  the realistic exhaustion path is a long dwell on the education page while Torn
  reconciles, not a render burst. A rate-windowed budget is the right design. QA
  watch item; not fixed.
- **`days-per-bonus` needs one line from the owner** — v0.3.0 § H2. Working-stat
  gain per day, a hand-scored value per learning outcome, or rename the mode.
  Nothing else is blocked on it.
- **§ H1 needs a live console probe the script cannot run for itself.** The
  course-id-to-row mapping is not in the payload or the saved page.
- **`docs/code-map.md` has outgrown its purpose** — 79.3K against the userscript's
  134.5K, with single rows over 3.5K. Targeted grep still works, which is the
  documented workflow, but `/orient` reads this file. Worth a dedicated trimming
  pass before v0.3.0, not before this merge.
- Working tree is clean; nothing is uncommitted.
