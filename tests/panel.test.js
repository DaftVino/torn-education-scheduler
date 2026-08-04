'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

const NOW = 1767000000;

function okState(queue, collapsed) {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  return {
    exports: exports,
    state: {
      fetchResult: { ok: true, data: data },
      plan: { queue: queue || [], collapsed: collapsed === true },
      now: NOW,
    },
  };
}

test('formats a timestamp as an unambiguous UTC string', () => {
  const { exports } = loadUserscript();
  assert.strictEqual(exports.formatTimestamp(1767225600), 'Thu, 01 Jan 2026 00:00:00 UTC');
});

test('formats durations in days and hours', () => {
  const { exports } = loadUserscript();
  assert.strictEqual(exports.formatDuration(0), '0 hours');
  assert.strictEqual(exports.formatDuration(3600), '1 hour');
  assert.strictEqual(exports.formatDuration(86400), '1 day');
  assert.strictEqual(exports.formatDuration(1088640), '12 days 14 hours');
});

test('an error result produces an error model with a readable message', () => {
  const { exports } = loadUserscript();
  const model = exports.buildPanelModel({
    fetchResult: { ok: false, reason: 'http', detail: 'status 503' },
    plan: { queue: [], collapsed: false },
    now: NOW,
  });
  assert.strictEqual(model.status, 'error');
  assert.match(model.message, /503/);
  assert.deepStrictEqual(model.queue, []);
});

test('an empty queue still reports the reduction it read', () => {
  const { exports, state } = okState([]);
  const model = exports.buildPanelModel(state);
  assert.strictEqual(model.status, 'ok');
  assert.strictEqual(model.reductionLabel, '40% off');
});

test('a non-constant reduction says so rather than showing a number', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  raw.categories[0].courses[1].actualDuration = 1000000;
  const model = exports.buildPanelModel({
    fetchResult: { ok: true, data: exports.parsePayload(raw) },
    plan: { queue: [], collapsed: false },
    now: NOW,
  });
  assert.strictEqual(model.reductionLabel, 'varies by course');
});

test('a queued course carries its name and projected finish', () => {
  const { exports, state } = okState([38]);
  const model = exports.buildPanelModel(state);
  assert.strictEqual(model.queue.length, 1);
  assert.strictEqual(model.queue[0].prefix, 'BIO2380');
  assert.strictEqual(model.queue[0].finishesAt, 1768314240);
  assert.strictEqual(model.finishLabel, exports.formatTimestamp(1768314240));
  assert.strictEqual(model.totalLabel, '12 days 14 hours');
});

test('an illegal queue order is reported with readable course codes', () => {
  const { exports, state } = okState([32]);
  const model = exports.buildPanelModel(state);
  assert.strictEqual(model.problems.length, 1);
  assert.strictEqual(model.problems[0].prefix, 'MTH2320');
  // MTH1220 (22) -> MTH2260 (26) -> MTH2320 (32); queuing 32 alone reports
  // the full uncompleted ancestor chain, ascending by id (confirmed against
  // tests/prereq.test.js's "earlier queue entries satisfy later ones" and
  // "a queue whose head has an unmet prerequisite reports it").
  assert.deepStrictEqual(model.problems[0].missing, [
    { id: 22, prefix: 'MTH1220' },
    { id: 26, prefix: 'MTH2260' },
  ]);
});

test('a queue entry that is no longer in the catalogue is dropped, not crashed on', () => {
  const { exports, state } = okState([999999, 38]);
  const model = exports.buildPanelModel(state);
  assert.deepStrictEqual(model.queue.map((q) => q.courseId), [38]);
  assert.deepStrictEqual(model.stale, [{ courseId: 999999, why: 'no longer in the catalogue' }]);
});

test('a queued course finished since the plan was saved adds no time', () => {
  const { exports, state } = okState([34, 38]);
  const model = exports.buildPanelModel(state);
  // 34 (BIO1340) is completed in the fixture. Counting it would push the
  // finish date out by weeks the player has already served.
  assert.deepStrictEqual(model.queue.map((q) => q.courseId), [38]);
  assert.strictEqual(model.totalLabel, '12 days 14 hours');
  assert.deepStrictEqual(model.stale, [
    { courseId: 34, prefix: 'BIO1340', why: 'already completed' },
  ]);
});

test('the in-progress course is dropped from the queue, not double counted', () => {
  const { exports, state } = okState([37, 38]);
  const model = exports.buildPanelModel(state);
  // 37 (BIO2370) is the active course; activeCourse.completedAt already
  // accounts for it, so queueing it too would count it twice.
  assert.deepStrictEqual(model.queue.map((q) => q.courseId), [38]);
  assert.strictEqual(model.finishLabel, exports.formatTimestamp(1768314240));
  assert.deepStrictEqual(model.stale, [
    { courseId: 37, prefix: 'BIO2370', why: 'currently in progress' },
  ]);
});

test('the collapsed flag reaches the model', () => {
  const { exports, state } = okState([], true);
  assert.strictEqual(exports.buildPanelModel(state).collapsed, true);
});

test('addable offers every course still takeable', () => {
  const { exports, state } = okState([]);
  const model = exports.buildPanelModel(state);
  // 131 total, 15 completed, 1 inProgress.
  assert.strictEqual(model.addable.length, 115);
  assert.ok(!model.addable.some((c) => c.courseId === 34), 'completed course offered');
  assert.ok(!model.addable.some((c) => c.courseId === 37), 'in-progress course offered');
});

test('addable excludes what is already queued', () => {
  const { exports, state } = okState([38]);
  const model = exports.buildPanelModel(state);
  assert.strictEqual(model.addable.length, 114);
  assert.ok(!model.addable.some((c) => c.courseId === 38));
});

test('addable is sorted by course code and carries a duration label', () => {
  const { exports, state } = okState([]);
  const codes = exports.buildPanelModel(state).addable.map((c) => c.prefix);
  assert.deepStrictEqual(codes, [...codes].sort());
  const { state: s2 } = okState([]);
  const entry = exports.buildPanelModel(s2).addable.find((c) => c.courseId === 38);
  assert.strictEqual(entry.durationLabel, '12 days 14 hours');
});

test('an error model still has an addable array', () => {
  const { exports } = loadUserscript();
  const model = exports.buildPanelModel({
    fetchResult: { ok: false, reason: 'network', detail: 'offline' },
    plan: { queue: [], collapsed: false },
    now: NOW,
  });
  assert.deepStrictEqual(model.addable, []);
});

test('findMountPoint uses prefix matching and tolerates absence', () => {
  const { exports } = loadUserscript();
  assert.strictEqual(exports.findMountPoint({ querySelector: () => null }), null);
  const el = { tag: 'found' };
  const selectors = [];
  const found = exports.findMountPoint({
    querySelector: (sel) => { selectors.push(sel); return sel.includes('___') ? el : null; },
  });
  assert.strictEqual(found, el);
  assert.ok(selectors.some((s) => s.includes('___')), 'must query by hash prefix');
  assert.ok(!selectors.some((s) => /___[A-Za-z0-9]{4,}/.test(s)), 'must not use a full hashed class name');
});
