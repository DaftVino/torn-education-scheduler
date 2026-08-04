# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-03

### Added

- Reads education data from Torn's `educationInitData` endpoint — no API key, no HTML parsing.
- Course queue with prerequisite validation over the `parentId` graph, including tier-3 bachelor gating.
- Exact finish date and time for the queue, and a projected finish per course.
- Perk reduction read from the payload and reported as a single figure.
- Plan persistence in Tampermonkey storage, surviving a site-data clear.
- Collapsible panel with a persisted hide/show state.
