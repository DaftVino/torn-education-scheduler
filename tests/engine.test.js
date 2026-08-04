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
  const base = [38, 39, 40, 41];
  const expected = exports.schedule({
    courses: parsed.courses, activeCourse: parsed.activeCourse, queue: base, now: NOW,
  }).finishesAt;
  const permutations = [
    [41, 40, 39, 38], [39, 41, 38, 40], [40, 38, 41, 39], [38, 41, 39, 40],
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
