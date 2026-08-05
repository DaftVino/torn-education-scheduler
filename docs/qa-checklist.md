# Manual browser QA checklist

The one gate the harness cannot run. `/qa` and `/browse` are off for this repo
(`CLAUDE.md`): the app under test is a third-party site behind a real login, so
every case here is run by hand, in a real browser, signed into a real account.

342 automated tests pass against a scrubbed fixture. Everything below exists
because a fixture cannot prove it: the live DOM, Torn's real React tree,
Tampermonkey's sandbox, and whether the words on screen are true.

Work top to bottom. **§ A, § B and § F1 are the highest-value cases** — they
cover the three things most likely to be wrong and least likely to be caught by
the suite.

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

## C. Schedule view

| # | Steps | Expected |
|---|---|---|
| C1 | Open the course picker | ~115 options. Tier-3 courses carry a `[bachelor]` prefix in their label. |
| C2 | Look at the picker's **first** option before touching anything | The "all remaining courses" sentinel must not be sitting there as the browser's default selection — a stray `add` click would queue everything with no bulk undo. This was a real bug; confirm the fix held in a real `<select>`. |
| C3 | Add a single tier-1 course | Appears in the queue. A finish date and a total print. |
| C4 | Sanity-check that date by hand against the course duration and your reduction | Agrees. |
| C5 | Add "all remaining courses" | Everything queues, appended *after* what you already had — your hand-built order is not reordered or discarded. |
| C6 | Add a course already in the queue | No duplicate. |
| C7 | Reload | Queue survives. |

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
| E1 | Open Degrees | One box per category, plus an all-courses box that sorts **last**. |
| E2 | Read the dates across boxes | Every box starts from **today**, independently. Eleven degrees finishing in 2026 beside an all-courses box in 2029 is **expected**, not a bug — confirm the on-screen caveat says so clearly. |
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

---

## Recording results

A defect found here is fixed on a branch off `main`, with a note in
`docs/designs/`'s handoff log. A defect **deferred** goes in the same log with
the reason. Anything in § A2, § A7, § B3 or § F1 is worth writing up even when
it passes — those four are the cases with the least automated cover behind them.
