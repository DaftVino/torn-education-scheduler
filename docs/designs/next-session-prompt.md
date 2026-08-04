# Next session — paste this into a fresh chat

> Delete this file once v0.2.0 is underway; it is a launch pad, not a document.

## Start here

Run `/orient` before anything else, including clarifying questions. Then build
**the whole of section v0.2.0** in `docs/designs/v0.2.0-scope.md` — workstreams A
through G — taking each item the full route: `superpowers:brainstorming` →
`superpowers:writing-plans` → `superpowers:subagent-driven-development` → tests
green. Work the workstreams in their documented order (A first; they are ordered
by dependency) and do not stop between them. The section is done when every item
A1 through G2 is implemented, tested and committed.

**Do not block on me.** If something needs my input, my judgement, or a live
browser probe, write it into the v0.3.0 section of
`docs/designs/v0.2.0-scope.md` as a numbered task with what is blocked and why,
then carry on with the rest of v0.2.0. The one exception is the browser QA gate
at the end of the release, which is mine to run.

## Read first

Read nothing else until you have these, in order:

1. `docs/designs/v0.2.0-scope.md` (31.1K) — the phase contract. § "v0.2.0" is the
   work; § "How this is grouped" says why v0.3.0 is where blocked items go; the
   Handoff log at the end lists six corrections marked do-not-revert.
2. `docs/code-map.md` (9.9K) — symbol index with line anchors for the userscript.
   Grep it for a symbol and read that slice; the file is 811 lines and a repo rule
   forbids opening it whole.
3. `tests/load-userscript.js` (7.5K) — the vm harness every test runs through. Its
   `EXPORT_NAMES` array is the gate: a function absent from it is invisible to
   tests and fails with "is not a function". Add names here and change nothing
   else in this file.
4. `tests/purity.test.js` (1.4K) — scans the engine section as raw text and fails
   on `document`, `window`, `location`, `GM_*`, `fetch`, `Date.now`, timers or
   `Math.random`, **including inside comments**. It decides which section your new
   code may live in.
5. `docs/superpowers/plans/2026-08-03-v0.1.0-core-scheduler.md` (76.3K) — precedent
   for plan shape and task granularity. **Read in slices** — open its header and
   one or two `### Task` blocks for the format; do not read it end to end.

## Branch

`main` — clean, up to date with origin, v0.1.0 merged and tagged. Branch from
`main` for the v0.2.0 work and do not commit implementation directly to it. The
v0.1.0 feature branch was deleted on merge, so `main` is the only starting point.

## Constraints

- **Six corrections from v0.1.0 are marked do-not-revert** in the Handoff log.
  The load-bearing ones: prerequisites are summed into the schedule rather than
  merely validated; the finish date is withheld whenever `problems` is non-empty;
  `unmetPrerequisites` walks the full ancestor chain with a cycle guard;
  `fetchEducationData` sends `rfcv` and never echoes a response body. Read all six
  before touching the engine.
- **Never read `torn-education-scheduler.user.js` whole.** Use `docs/code-map.md`
  anchors and read slices. Refresh the map whenever you move declarations — a
  stale anchor is worse than none, because it is trusted.
- **Engine section is pure.** No DOM, network, `GM_*`, clock or randomness between
  the `ENGINE START` and `ENGINE END` markers, comments included. Runtime code goes
  after the `RUNTIME` marker.
- **Do not widen the security surface.** One `@match`, exactly `GM_setValue` and
  `GM_getValue`, no `@connect`. A test asserts this. `@downloadURL`/`@updateURL`
  are post-launch, not now.
- **Never commit `tests/fixtures/raw/` or `tests/fixtures/*.html`.** Both are
  gitignored; the saved page carries a `logoutHash` and a signed JWT.
- **No dependencies.** Zero runtime and zero dev dependencies, no lockfile, no
  build step. Tests are `node --test` only.
- **No attribution trailers** in commit messages — no "Generated with Claude
  Code", no "Co-Authored-By: Claude", no session URL.
- The debug report (§ B3) is built by **allowlist, never blocklist**, and must
  never carry the `rfcv` token, a raw payload, or the player's completed-course
  set. Assert the exclusions in tests.
- `GREASY_FORK_URL` and `FORUM_POST_URL` stay as placeholders and render nothing
  until resolved post-launch. Do not invent URLs.

## Exit criteria

- `npm test` green, with tests added for every workstream (suite is at 116 now)
- `npm run test:syntax` exits 0
- Every item A1 through G2 in `docs/designs/v0.2.0-scope.md` is implemented and
  committed, or recorded as a numbered task in that file's v0.3.0 section with
  the reason it could not be finished
- `docs/code-map.md` regenerated, and every line anchor in it verified against
  `torn-education-scheduler.user.js`
- `CHANGELOG.md` contains a v0.2.0 entry, and `@version`, `SCRIPT_VERSION` and
  `package.json` all agree
- A PR exists against `main` and the branch is pushed
- Browser QA handed back to me with a numbered checklist of what to verify

## Unknowns and risks

- v0.2.0 is seven workstreams and will not fit one review pass comfortably. The
  scope doc sanctions cutting it into staged tags at workstream boundaries —
  decide that before planning, not mid-build.
- Fixture-based tests cannot see the HTTP contract. The `rfcv` requirement
  survived 105 passing tests because the fixture was captured through an
  already-authenticated request. Anything touching the network needs a live check
  from me, not just a fixture.
- Nothing in the automated loop looks at the page. v0.1.0 passed a clean final
  review with no CSS whatsoever. Assume visual defects survive review.
- § C3's degree-grid boxes will not sum to the all-courses figure, because degrees
  share prerequisites. The UI has to say so or it reads as a bug.
- § B2's perk inference is only determinate outside 10–30%; most players sit
  inside that band. Prefill only where unique, and mark it inferred.
- Additive perk stacking and "consumables do not perturb `actualDuration`" both
  rest on a single account's capture. Treat them as evidence, not proof, and keep
  the non-constant-ratio guard.
- The row-marker probe (§ H1) is already parked in v0.3.0 and needs me. Do not
  attempt to derive the course-id-to-row mapping from the payload or the saved
  page — it is not in either.
