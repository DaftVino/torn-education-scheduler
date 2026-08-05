'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

const NOW = 1767000000; // before the fixture's activeCourse.completedAt

function setup() {
  const { exports } = loadUserscript();
  const parsed = exports.parsePayload(loadFixture());
  return { exports: exports, parsed: parsed };
}

test('an empty queue finishes when the active course does', () => {
  const { exports, parsed } = setup();
  const result = exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: [], now: NOW,
  });
  assert.strictEqual(result.startsAt, 1767225600);
  assert.strictEqual(result.finishesAt, 1767225600);
  assert.strictEqual(result.totalSeconds, 0);
  assert.deepStrictEqual(result.items, []);
});

test('a single queued course starts when the active one ends', () => {
  const { exports, parsed } = setup();
  const result = exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: [38], now: NOW,
  });
  assert.strictEqual(result.totalSeconds, 1088640);
  assert.strictEqual(result.finishesAt, 1768314240);
  assert.deepStrictEqual(result.items, [
    { courseId: 38, startsAt: 1767225600, finishesAt: 1768314240 },
  ]);
});

test('queued courses run back to back', () => {
  const { exports, parsed } = setup();
  const result = exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: [38, 39], now: NOW,
  });
  assert.strictEqual(result.totalSeconds, 1814400);
  assert.strictEqual(result.finishesAt, 1769040000);
  assert.deepStrictEqual(result.items, [
    { courseId: 38, startsAt: 1767225600, finishesAt: 1768314240 },
    { courseId: 39, startsAt: 1768314240, finishesAt: 1769040000 },
  ]);
});

test('the finish date is independent of queue order', () => {
  const { exports, parsed } = setup();
  const args = { courses: parsed.courses, activeCourse: parsed.activeCourse, now: NOW };
  const forward = exports.schedule({ ...args, queue: [38, 39] });
  const reverse = exports.schedule({ ...args, queue: [39, 38] });
  assert.strictEqual(forward.finishesAt, reverse.finishesAt);
  assert.strictEqual(forward.totalSeconds, reverse.totalSeconds);
});

test('order-independence holds across many permutations', () => {
  const { exports, parsed } = setup();
  // All four durations are distinct — 1088640, 725760, 1451520, 1814400 — so a
  // position-dependent bug cannot hide behind two courses of equal length.
  const base = [38, 39, 40, 42];
  const expected = exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: base, now: NOW,
  }).finishesAt;
  assert.strictEqual(expected, 1772305920);
  const permutations = [
    [42, 40, 39, 38], [39, 42, 38, 40], [40, 38, 42, 39], [38, 42, 39, 40],
  ];
  for (const queue of permutations) {
    const result = exports.schedule({
      courses: parsed.courses, activeCourse: parsed.activeCourse, queue: queue, now: NOW,
    });
    assert.strictEqual(result.finishesAt, expected, `queue=${queue}`);
  }
});

test('with no active course the schedule starts now', () => {
  const { exports, parsed } = setup();
  const result = exports.schedule({
    courses: parsed.courses, activeCourse: null, queue: [38], now: NOW,
  });
  assert.strictEqual(result.startsAt, NOW);
  assert.strictEqual(result.finishesAt, NOW + 1088640);
});

test('an already-finished active course starts the queue now, not in the past', () => {
  const { exports, parsed } = setup();
  const late = 1767225600 + 10000;
  const result = exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: [38], now: late,
  });
  assert.strictEqual(result.startsAt, late);
});

test('an unknown course id in the queue is rejected loudly', () => {
  const { exports, parsed } = setup();
  assert.throws(() => exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: [999999], now: NOW,
  }), /unknown course/);
});

test('a missing now is rejected rather than defaulted', () => {
  const { exports, parsed } = setup();
  assert.throws(() => exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: [],
  }), /now is required/);
});

test('formatDate is an ISO calendar date and formatTime is HH:MM', () => {
  const { exports: x } = loadUserscript();
  const t = Date.UTC(2026, 7, 4, 21, 0, 0) / 1000;
  assert.strictEqual(x.formatDate(t), '2026-08-04');
  assert.strictEqual(x.formatTime(t), '21:00');
});

test('single-digit months, days, hours and minutes are zero padded', () => {
  const { exports: x } = loadUserscript();
  const t = Date.UTC(2026, 0, 5, 3, 7, 0) / 1000;
  assert.strictEqual(x.formatDate(t), '2026-01-05');
  assert.strictEqual(x.formatTime(t), '03:07');
});

test('no seconds, no milliseconds, no T, no Z', () => {
  const { exports: x } = loadUserscript();
  const t = Date.UTC(2026, 7, 4, 21, 0, 45) / 1000;
  assert.strictEqual(x.formatTime(t), '21:00');
  assert.ok(!/[TZ:]/.test(x.formatDate(t)));
});

test('durations are abbreviated', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(x.formatDuration(0), '0 hrs');
  assert.strictEqual(x.formatDuration(3600), '1 hrs');
  assert.strictEqual(x.formatDuration(8 * 3600), '8 hrs');
  assert.strictEqual(x.formatDuration(86400 + 3 * 3600), '1 day 3 hrs');
  assert.strictEqual(x.formatDuration(2 * 86400), '2 days');
});

// One formatter, not two (owner decision 2): formatDuration itself
// abbreviates, on the strength that no duration ever reaches the share
// string or the debug report. If a future change routes one into either,
// this is the test that reopens the two-formatter question — deliberately.
test('the share string and the debug report carry no duration at all', () => {
  const { exports: x, parsed } = setup();
  const share = x.encodePlan({ queue: [38, 39] }, x.normaliseSettings(null));
  assert.ok(!/hrs|hours|days?\b/.test(share), 'a duration in the share string reopens the one-formatter decision');
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: true, data: parsed, source: 'fetch' },
    plan: { queue: [38, 39], collapsed: false },
    settings: x.freshSettings(),
  });
  const report = x.buildDebugReport(ctx);
  assert.ok(!/\d+\s*(hrs|hours|days?)\b/.test(report), 'a duration in the debug report reopens the one-formatter decision');
});
