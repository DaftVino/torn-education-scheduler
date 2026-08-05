# Manual browser QA checklist

The one gate the harness cannot run. `/qa` and `/browse` are off for this repo
(`CLAUDE.md`): the app under test is a third-party site behind a real login, so
every case here is run by hand, in a real browser, signed into a real account.

476 automated tests pass against a scrubbed fixture. Everything below exists
because a fixture cannot prove it: the live DOM, Torn's real React tree,
Tampermonkey's sandbox, and whether the words on screen are true.

Work top to bottom. **§ A, § B, § F1, § M and § N are the highest-value
cases** — the first three cover the things most likely to be wrong and least
likely to be caught by the suite; § M (Focus view) and § N (reset controls)
are two whole features that shipped this release with **zero** live-browser
coverage of any kind.

## Before you start: three visible changes, not one

This release also retouched the panel's whole visual surface — colour,
spacing, type — adopting Torn Bookie Live Scores' tokens. Expect **three**
distinct, independent differences from earlier screenshots. A tester who
notices only one of these may wrongly file the other two as new regressions:

1. **Greys shift slightly** — panel background, borders and hover states move
   to Bookie's exact values. A few points of luminance; near-invisible on its
   own.
2. **Sections sit visibly further apart.** The gap between grouped sections
   (`--tes-gap-lg`) grew from 8px to 14px — the panel should now read as
   grouped, where before every line sat equally far from every other line.
3. **Body text is a point larger, and several notes gained an explicit
   smaller size.** Base text moved 13px → 14px. Several previously
   relative-sized lines — `.tes-note`, `.tes-cell-detail`, `.tes-foot`, and
   the new queue bonus line — now carry an explicit 12px instead of an
   inherited or `em`-based size.

None of the three is a bug. Confirm all three are present, together, rather
than reporting the first one you notice and moving on.

## Setup

- Install the raw `torn-education-scheduler.user.js` in Tampermonkey.
- Storage is two keys, `tes:plan` and `tes:settings`. The script holds only
  `GM_setValue`/`GM_getValue` — there is no `GM_deleteValue` — so **reset state
  from Tampermonkey's dashboard → the script → Storage tab**, not the console.
- Keep devtools open on Console throughout. A thrown error that the panel
  swallows is still a defect.
- Panel is `#tes-panel`. The fixed-position fallback container is
  `#tes-fallback-mount` — worth a `$('#tes-fallback-mount')` check in § A2.

---

## A. Mount and lifecycle

| # | Steps | Expected |
|---|---|---|
| A1 | Load `torn.com/page.php?sid=education` directly | Panel appears. No console errors. |
| A2 | With the panel up, run `document.querySelector('#tes-fallback-mount')` | **`null`.** A hit means the panel gave up finding a real mount point and pinned itself to the viewport — it will work but look wrong, and this is the single likeliest visual defect. |
| A3 | Note *where* the panel sits relative to Torn's own education content | Somewhere sensible — near the course list, in the page flow. Screenshot it. |
| A4 | From the education page, click into another Torn page (gym, city) via the sidebar | Panel unmounts cleanly. No orphan `#tes-panel` left behind: `document.querySelectorAll('#tes-panel').length === 0`. |
| A5 | Navigate *back* to education from elsewhere, without a reload | Panel remounts with no page refresh. This is the `pushState` interception path. |
| A6 | Repeat A4/A5 five or six times | Exactly one `#tes-panel` each time — never two stacked. |
| A7 | Sit on the education page for 5+ minutes without navigating | Panel stays. `MAX_MOUNT_ATTEMPTS = 20` never decays, so a long dwell while Torn re-renders is the realistic exhaustion path — a panel that vanishes after minutes of idling is this bug, and it is a **known watch item, not yet fixed**. |
| A8 | Collapse the panel, reload the page | Still collapsed. `collapsed` is a standing preference and does persist. |
| A9 | Switch to Degrees, reload the page | Back on **Schedule**. The view is deliberately *not* persisted — Schedule after a reload is correct, not a bug. |

## B. Data acquisition and the fiber fallback

| # | Steps | Expected |
|---|---|---|
| B1 | Normal load, Network tab open | The education data request carries an `rfcv` token. Panel populates with **your** real courses. |
| B2 | Cross-check 3–4 course durations and your in-progress course's finish time against Torn's own page | They agree. A mismatch here invalidates every date the panel prints. |
| B3 | Block the education data endpoint (devtools → Network → right-click the request → Block request URL), then reload | **The fallback fires**: the panel still shows real course data, read out of Torn's React tree. This path has never been seen against a real component tree — it is the most under-tested code in the release. |
| B4 | While blocked, confirm the data is right | Same courses and durations as B1/B2. Wrong-but-plausible data is worse than the failure line. |
| B5 | Block the endpoint **and** confirm the fallback fails (e.g. on a Torn layout with no matching fiber) | A visible failure line naming the failure. Never a blank panel, never a silent `undefined`. |
| B6 | Unblock, reload | Recovers on its own. |
| B7 | Open Torn's own in-game clock (or any page that shows Torn City Time) next to the panel's finish line, e.g. `2026-08-04 · 21:00 TCT` | The two agree. This is the one thing only a live account can prove — a fixture has no live clock to check against — and the spec that introduced the split date/time/TCT label explicitly demands this comparison. |

## C. Schedule view

| # | Steps | Expected |
|---|---|---|
| C1 | Open the course picker | ~115 options, no `[bachelor]` text anywhere. Tier-3 courses render in green (`#7ee081`, the same green as the finish-line total), not as plain text. |
| C1a | Same picker, on macOS specifically | The OS draws the `<select>` menu itself and commonly ignores an option's colour, so bachelor courses show **no green marker at all** there — no prefix either, since none is kept as a fallback. This is expected on macOS, not a defect: confirm the picker still works (count, selection, add) even though the marker is invisible. On Windows/Linux Chrome or Firefox, confirm the green **is** visible — that is the platform the colour is for. |
| C2 | Look at the picker's **first** option before touching anything | The "all remaining courses" sentinel must not be sitting there as the browser's default selection — a stray `add` click would queue everything with no bulk undo. This was a real bug; confirm the fix held in a real `<select>`. |
| C3 | Add a single tier-1 course | Appears in the queue **as two lines sharing one row**: the main line (`prefix name — duration — fin <date>`) and, below it, a second, smaller, indented line naming what the course actually gives. A finish date and a total print in the summary above. |
| C3a | Read the second line for a course whose payload carries a `learningOutcomes` entry | Names the real benefit, in Torn's own words — never inferred or guessed from the course's name. |
| C3b | Add one of the **31 courses with no `learningOutcomes` at all** | The second line reads `Bonus: not listed by Torn` (or, if the course also grants a working stat, the stat figure plus `· other bonus not listed by Torn`) — never blank, never a made-up benefit. |
| C3c | Click `remove` on a two-line row | The whole row — both lines — disappears from one click. The button visually spans the row rather than sitting beside only the top line. |
| C4 | Sanity-check that date by hand against the course duration and your reduction | Agrees. |
| C5 | Add "all remaining courses" | Everything queues, appended *after* what you already had — your hand-built order is not reordered or discarded. |
| C6 | Add a course already in the queue | No duplicate. |
| C7 | Reload | Queue survives. |
| C8 | On a clean, followable queue, look at the summary block above the queue rows | Exactly **two** parts: a perk-reduction line, then a bordered total-time line below it (a visible top border on that second line only). |
| C9 | Build a queue that drops a stale entry or carries a missing prerequisite (see § D) | A **third** part appears below the bordered line, naming the problem(s). The border stays on the total-time line — it does not move to the new bottom line. |

## D. Prerequisites and the withheld date

| # | Steps | Expected |
|---|---|---|
| D1 | Add a tier-3 bachelor with nothing else queued | Its **whole prerequisite chain** queues with it, not just the bachelor. The date reflects the full chain — this is the v0.1.0 bug where a 197-day path printed 54 days. |
| D2 | Manually construct a queue with an unmet prerequisite (add a bachelor, then remove one of its chain) | **Both the finish date and the total disappear**, and the problem is named. A date for a plan you cannot follow is worse than no date — if either label still prints, that is a regression against an explicit do-not-revert. |
| D3 | Add a course gated on the course you are **currently taking** | It is *followable* — the active course finishes before the queue starts — so a date **does** print. This is the two-notions-of-completed fix; withholding here would be the regression in the other direction. |
| D4 | Re-add the missing prerequisite from D2 | Date and total come back. |

## E. Degrees grid

| # | Steps | Expected |
|---|---|---|
| E1 | Open Degrees | **Twelve boxes, one per category — no all-courses box among them.** Above the grid, before it in reading order, a full-width banner titled **"all remaining courses"** carries the same count, duration and finish date the old thirteenth box used to. `document.querySelectorAll('.tes-cell-all').length` must be `0` — that class was retired; count the on-screen boxes yourself rather than trusting a stale memory of "one per category plus one more." |
| E1a | Confirm the banner's position | It renders **before** `.tes-grid` in the DOM, visually above the grid of degree boxes, not sorted into the grid as a last cell. |
| E2 | Read the dates across boxes | Every box starts from **today**, independently. Eleven degrees finishing in 2026 beside an all-courses banner in 2029 is **expected**, not a bug — confirm the on-screen caveat says so clearly. |
| E3 | Read the note about durations summing | It claims the boxes add up. Against today's catalogue that is true; confirm the sentence is present and reads honestly. |
| E4 | Check a box for a category holding two tier-3 courses | No degree name in the title (it would be false of both). A missing label here is correct. |
| E5 | Check a box for a category you have already finished | No phantom "missing prerequisite". |

## F. Settings, and the honest-copy check

| # | Steps | Expected |
|---|---|---|
| **F1** | Open ⚙ settings and read the copy around **Job points available**, **Merits reduction (%)**, **Principal rank (10%)** and **WSU stock block (10%)** | **These four drive no arithmetic, by design** — Torn already applies job points to the course in progress, and the reduction is read from the payload rather than reconstructed from perks. That is correct behaviour. **The question is whether the screen says so.** The release notes originally claimed the opposite. A player who types their merits in and sees no number move will file a bug unless the copy already told them. This is the finding most likely to be hit on day one. |
| F2 | Change **Max booster cooldown (hours)**, **Books of Carols owned**, **Book of Carols price** | Each visibly moves the arithmetic. These four (with Queue order) are the ones that do. |
| F3 | Read the perk-inference note at the top of Education perks | It names itself **as an inference** from your observed reduction — not as something read off your account. If any perk field is prefilled, the note must be present and unambiguous. |
| F4 | Set a perk field by hand, reload, check it | Your typed value is never overwritten by inference. Inference fills only fields you have left at "Not set". |
| F5 | Check the tri-state selects (Principal rank, WSU stock block) | **Not set / Yes / No.** "Not set" is a real, distinct state — not a blank, not an unticked box implying "no". |
| F6 | Type nonsense into a number field (`-5`, `abc`, `99999999`) | Falls back to its default rather than storing garbage or taking the panel down. |
| F7 | Compare the inferred total reduction against your actual Torn perks | Reductions stack **additively** (20 + 10 + 10 = 60%), not multiplicatively. Several community guides say `.648`; they are wrong. |

## G. Books of Carols / the floor date

| # | Steps | Expected |
|---|---|---|
| G1 | With a queue and a cooldown budget set, read the ceiling and floor lines | A maximum Book count, a shortest-possible finish date, and a cost. |
| G2 | Leave **Book of Carols price** unset or `0` | Reads **"cost unknown, no Book price set"** — never `$0`. "$0" would tell the player the floor is free. |
| G3 | Set a real price | A real cost appears. Check the Book count is plausible against your cooldown — an overstated count was a caught bug (up to 43×). |
| G4 | Queue a plan with an unmet prerequisite | The Book lines disappear too, on the same rule as the finish date. |

## H. Ordering

| # | Steps | Expected |
|---|---|---|
| H1 | With a multi-course queue, cycle Queue order: As listed → Shortest first → Unlocks the most first | The rendered order changes. |
| H2 | Watch the **finish date** while doing H1 | **It does not change.** Ordering changes when each bonus starts paying off, never the total. |
| H3 | Read the note under the control | It must say exactly that, in words. Several community guides present ordering as a way to finish sooner; this note is the only thing standing between that belief and the panel appearing to confirm it. |

## I. Share and import

| # | Steps | Expected |
|---|---|---|
| I1 | Build a plan, open the share box | The string describes the plan **on screen right now**, in the order shown. |
| I2 | Copy it, reset storage, paste it back, import | Same queue and settings restored. |
| I3 | Import under a non-default order mode, then export again | Round-trips without drift. |
| I4 | Import garbage (`hello`, truncated string, a valid string with an invalid course id) | Refused with a reason on screen. **Your existing plan and settings are untouched** — a refusal must commit nothing. |
| I5 | Import a string containing `<img src=x onerror=alert(1)>` | Renders as **text**. No alert, no injected node. |
| I6 | Edit the textarea by hand, then click import | It imports what is *in the box*, not what the panel was showing. |
| I7 | Pick two or three focuses on the Focus view (§ M), with priorities set, then open the share box, copy it, reset storage, and import it back | The same focuses return, in the same category/selection pairs, **with the same priority numbers** — not just the queue and the four settings fields I2 already checks. |

## J. Debug report and privacy

| # | Steps | Expected |
|---|---|---|
| J1 | Settings → build the debug report | The report renders **on screen before any copy button exists**. A copy button that hides its payload is how people leak things they did not know they had. |
| J2 | Read the whole report | Version, manager, acquisition source, payload shape, settings, queue codes. Absent fields read `not recorded`, never `undefined`. |
| J3 | Search the report for your session token, `logoutHash`, your user ID, any JWT, any course timestamps | **None present.** The report is built from an allowlist. |
| J4 | Check the contact line | Names Greasy Fork in prose. No URL renders — `GREASY_FORK_URL` and `FORUM_POST_URL` are both `null` until launch, so **no `<a>` should appear anywhere**, here or in Help. |
| J5 | Trigger the failure state (§ B5), then build a report from it | The Failure block carries a **real reason and detail**, not "not recorded". This is the only path that populates them, and it regressed once already. |
| J6 | Toggle the report off | Report and copy button both go away. |

## K. Persistence and failure paths

| # | Steps | Expected |
|---|---|---|
| K1 | Corrupt `tes:plan` from the Storage tab (set it to `{`), reload | Falls back to a default plan. Panel loads. No throw. |
| K2 | Corrupt `tes:settings` the same way | Same. The two keys fail **independently** — a broken settings blob must not lose your plan. |
| K3 | Fresh install, no storage | Sensible defaults, no errors. |

## L. Security surface (confirm, do not change)

- One `@match`, exactly `GM_setValue` and `GM_getValue`, **no `@connect`**.
- No `@downloadURL`/`@updateURL` — deliberately absent until launch.
- `@version`, `SCRIPT_VERSION`, `package.json` and the top `CHANGELOG.md`
  heading all read the same version.

`tests/metadata.test.js` asserts all of this, so it should never fail here — but
eyeball the installed header once, because what Tampermonkey actually loaded is
the thing users get.

## M. Focus view

Brand new this release: pick what you want out of education and the queue
re-sorts to deliver it first. Ten categories, 79 selections. **Zero automated
browser coverage** — the model and ranking are unit-tested against a fixture,
but nobody has watched a real queue re-sort in a real browser yet.

| # | Steps | Expected |
|---|---|---|
| M1 | On a **fresh install**, look at the nav row before touching Settings | The `focus` button is present and **enabled**. Focus is now the default Queue order, so the feature is available out of the box. The queue itself is unchanged from as-listed, because focus ordering degrades to as-listed until you pick a focus — confirm the queue order matches what as-listed gives. |
| M1a | In Settings, change Queue order to anything other than "My focus first", then look at the nav row | The `focus` button is **gone** — not greyed out, absent. Changing it back makes the button reappear. This replaced the disabled-button-with-a-title behaviour: the button is present by default now, so there is no longer a discoverability problem for a disabled state to solve. |
| M2 | Click the `focus` button | The Focus view opens. **All ten category sections are collapsed**, each an outlined box using the same border as the degrees-page cards. No selection names are visible yet. |
| M2a | Read the collapsed section headings | Each names its category and how many selections in it you have chosen — so you can see where your focuses are without opening all ten. Each heading is a real button and responds to a click; opening one leaves the other nine closed. |
| M2b | Open a section, leave the Focus view, come back | Sections are collapsed again. Open/closed state is deliberately not remembered — it is transient, like which view you were last on, not a standing preference like the panel's own collapsed state. |
| M3 | Open a section and tick one selection's checkbox | It shows priority `1`, and a remaining-out-of-total figure specific to that selection — e.g. `12 of 40 left`, `35% left of 60%` for a percent-based one, or `N courses left, no fixed total` for a selection (like weapon experience) with no stated ceiling. |
| M3a | Watch the row as you tick and untick the box | **Nothing else in the row moves.** The priority box sits in a fixed slot at the *start* of the row, before the checkbox, and that slot holds its width whether or not a priority exists. It used to appear at the end of the row and shove everything left. |
| M3b | Compare rows across two different sections — Working Stats against any other | The checkbox, the selection name and the remaining figure each start at the same horizontal position in every row of every section. Working Stats' long figures (`6500 left of 8560`) must not push its rows out of line with the shorter ones below. |
| M4 | Tick a second selection under any category, then type `1` into its priority field | The two swap priorities. Numbers are never duplicated and never skip — always a dense 1..N over however many you have chosen. |
| M5 | With two focuses chosen at different priorities, watch the Schedule queue re-sort | Courses serving the priority-1 focus move earliest. A course that serves only the priority-2 focus never jumps ahead of a priority-1 course purely by having a bigger secondary score — **ranking is lexicographic, never summed.** Picking two selections that visibly disagree (a course with a huge secondary score but a lower primary one) is the case that actually proves this; a queue where the two never conflict cannot. |
| M6 | Watch the **finish date** while doing M5 | It does not move — same rule as § H: focus changes order, never the total. |
| M7 | While standing on the Focus view, go to Settings and change Queue order to anything else | The panel falls back to **Schedule** — there is no dead end where a disabled nav button strands you on a view its own switch just turned off. |
| M8 | Complete a course that fed a selection you have chosen (or check the panel again after Torn credits one) | That selection's remaining figure decreases by exactly that course's own contribution — never by more than one course's worth, even for a course whose Torn-given outcome text splits across two selections (e.g. "...to speed and strength" counts once per selection, not once total). |
| M9 | Read the note under the focus controls, and the separate note about outcome-less courses | The first states plainly that focus reorders and never changes the finish date. The second says that 31 courses grant no learning outcome at all, and that Working Stats is the only focus category that can still reach them. |

See § I7 for the focus share/import round-trip.

## N. Reset controls

Brand new this release, and — because there is no undo anywhere in this
panel — the two-click arm/confirm is the only thing standing between a
misclick and a lost queue or lost focus selections.

| # | Steps | Expected |
|---|---|---|
| N1 | On Schedule, with a non-empty queue, click `reset` once | The button changes to a warning-coloured **`reset — sure?`** state rather than acting immediately. |
| N2 | With it armed, click any **other** control instead — add a course, switch views, collapse the panel, change a setting | The button reverts to plain `reset`, unarmed. **Nothing was cleared.** Confirm this for at least two different kinds of "other click," not just one — the arm has to disarm on any redraw, not on a specific button. |
| N3 | Arm `reset` again, then click it a second time | The queue empties. Settings, Focus selections and everything else are untouched. |
| N4 | Repeat N1–N3 on the Focus view (its button also reads `reset`) | Only your focus selections and priorities clear. The queue you built on Schedule is untouched. |
| N5 | Repeat N1–N3 on Settings, where the button reads `defaults` | Every setting — cooldown, Books owned/price, perk fields, Queue order — returns to its shipped default. **Queue order returns to "My focus first"**, which is the default as of v0.3.0 — so if you had switched it away and lost the `focus` nav button, `defaults` brings the button back. **Your chosen focuses survive this reset** — `defaults` deliberately does not touch `focuses`, since a focus is what you are building toward, not a setting to reset. |
| N6 | Open Degrees and look for a reset button | **None renders.** Degrees owns no player-editable state, so nothing there is arm-able. |

## O. The permanent settings landmark and the header

| # | Steps | Expected |
|---|---|---|
| O1 | Visit Schedule, Degrees, Focus and Settings in turn, and look at the nav row each time | `⚙ settings` sits in the **same right-aligned position** on all four, always enabled — never greyed out, absent, or shifted by how many other buttons sit to its left. |
| O2 | While on Settings, inspect the gear button in devtools | It carries `aria-current="page"`, but is **not visually restyled** to look different from the other three views' gear button — it stays a landmark, not a fourth toggle target that happens to be selected. |
| O3 | Click the panel's header title — the text naming the current view, to the left of `hide`/`show` | **Nothing happens.** Only the real button on the right (labelled `hide` or `show`) toggles the panel. This used to be a single clickable header; it is now two elements and only one of them responds. |

---

## Recording results

A defect found here is fixed on a branch off `main`, with a note in
`docs/designs/`'s handoff log. A defect **deferred** goes in the same log with
the reason. Anything in § A2, § A7, § B3 or § F1 is worth writing up even when
it passes — those four are the cases with the least automated cover behind
them. § M (Focus view) and § N (reset controls) join that list this release:
both are whole features with no live-browser coverage of any kind, so a pass
there is itself new information worth recording, not just a defect to avoid.
