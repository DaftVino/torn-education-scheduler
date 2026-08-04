# Torn Education Scheduler

A Tampermonkey userscript that turns Torn's education page into a live planner.
Queue the courses you intend to take and it tells you the exact date and time
you finish — reading your own progress and perk reduction straight from the
page. No API key.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `torn-education-scheduler.user.js` from this repo and install it.
3. Visit <https://www.torn.com/page.php?sid=education>.

## Notes

- Your plan is stored locally in Tampermonkey storage. Nothing leaves your browser.
- The script makes no third-party requests and needs no API key.
- Ordering a queue does not change the finish date — courses run one at a time,
  so the total is a sum. Ordering changes how early each perk starts paying off.

## Development

```
npm test           # unit tests, Node only, no browser
npm run test:syntax
```

Tests never modify the userscript on disk; see `tests/load-userscript.js`.
