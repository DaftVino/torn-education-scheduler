# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-03

### Added

- Reads education data from Torn's `educationInitData` endpoint — no API key, no HTML parsing.
- Adding a course queues its whole prerequisite chain, ordered so the plan can
  actually be followed, so the finish date covers the real path rather than one
  course of it.
- Exact finish date and time for the queue, and a projected finish per course.
- Perk reduction read from the payload and reported as a single figure.
- Plan persistence in Tampermonkey storage, surviving a site-data clear.
- Collapsible panel with a persisted hide/show state.

### Notes

- The finish date is withheld whenever the queue has unmet prerequisites. A
  date for a plan that cannot be followed is worse than no date, so the panel
  names what is missing instead.
- Queue order does not change the finish date — courses run one at a time, so
  the total is a sum. Ordering changes how early each perk starts paying off,
  which is a later release.
- Entries in a stored plan that have since been completed, started, or removed
  from the game are dropped from the queue and reported, never silently counted.
