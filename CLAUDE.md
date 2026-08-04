# CLAUDE.md

## Project

A Tampermonkey userscript that turns Torn's education page into a live planner: it reads your own course progress and time-reduction perks, lets you pick a set of courses, and computes the exact finish date for the whole path. Runs only on torn.com's education page, with a collapsible themed panel modelled on Torn Bookie Live Scores.

## Key docs

- Architecture: `docs/architecture.md`
- Conventions: `engineering-standards/repo-standards.md` in the `daftplate` repo — canonical, never copied here (its ADR 0001). Your local checkout path is recorded in `~/.claude/CLAUDE.md`.
- Workflow quick reference: `docs/quick-ref-workflow.md`
- Decisions: `docs/adr/` — read before proposing architectural changes
- Active plans: `docs/designs/` — start with `docs/designs/v0.2.0-scope.md`, the
  single home for all unshipped work. It takes precedence over the design spec
  where they disagree.

## Commands

```
verify:  npm test
test:    npm test
deploy:  n/a
```

Run verify before every push. Never deploy without being asked.

## Workflow rules

The non-negotiable gates live in `~/.claude/CLAUDE.md` and govern this repo. Repo-specific additions only below.

Deviating from a standard requires an ADR here **and** a note queued to `~/.daftplate/outbox/` so the rule itself gets revisited upstream. Silent deviation is the one unforgivable move. Tasks live on this repo's GitHub Project (repo-standards §6.5) — never as draft cards, which agents cannot see.

## Repo-specific constraints

1. **The userscript is one large file and must never be read whole.** Grep `docs/code-map.md` for the symbol, then read only the lines around the anchor. A session that opens it wholesale has failed regardless of what it produced.
2. **Selectors against the host site are fragile by nature.** Every DOM query needs a null guard and a visible failure path; a silent `undefined` in a userscript looks like the host site broke. Record the selector's purpose next to it, so the repair is possible when the site changes.
3. **`@version`, the newest `CHANGELOG.md` heading, and the git tag move together in one commit.** Users update by version string; a bumped script with an unbumped header ships invisibly.
4. **`@match`, `@grant`, and `@connect` are the security surface.** Widening any of them needs a stated reason in the PR description. `@grant none` is the default to argue against, not for.
5. **No secret reaches the script.** Everything in a userscript is readable by every user. API keys are entered by the user and held in script storage, never committed — `api-key-setup-readme.md` is the pattern.

## Pipeline

`brainstorming` → `writing-plans` → `/plan-eng-review` → `using-git-worktrees` → `test-driven-development` → `/code-map` (the file grew) → `/review` → `/ship`.

## Off

- `/land-and-deploy` and `/canary` — there is no deploy target. The release is a tag plus the raw file URL.
- `/gas-deploy` — wrong platform.
- `/qa` and `/browse` — the app under test is a third-party site the harness cannot log into. QA is manual, in a real browser, signed into a real account.

## Context budget

- The userscript is the repo. **Never read it whole**, at any size, for any reason. `docs/code-map.md` (from `/code-map`) is the index; grep it for the symbol, then `Read` with `offset`/`limit` around the anchor.
- Regenerate the map with `/code-map` whenever a session moves declarations; a stale anchor is worse than none, because it is trusted.
- Session start: `/orient`. Phase or session end: `/handoff`.

## Subagent defaults

- "Where is X handled?" → an Explore subagent over the script; take its answer, not its file dumps.
- Mechanical batch edits (renames, repeated call-site changes) → a cheaper-model subagent, one task per anchor region from the map.
