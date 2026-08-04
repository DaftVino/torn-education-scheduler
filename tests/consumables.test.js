'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');
// The shared fake DOM (tests/fake-document.js). The rule this feature turns on
// — the floor date never appears without its cost — is a property of the
// rendered view, so the view is what the render tests below read.
const { makeFakeDocument } = require('./fake-document');

const HOUR = 3600;
const DAY = 86400;

test('booksCeiling reproduces the worked example exactly', () => {
  const { exports: x } = loadUserscript();
  // 197 days of course time, a 24-hour maximum cooldown.
  const ceiling = x.booksCeiling({ baseSeconds: 197 * DAY, maxCooldownSeconds: 24 * HOUR });
  assert.strictEqual(ceiling, 396, 'the closed form does not give 396 books');

  // 396 books at 6h each halves the path to about 98 days.
  const floorSeconds = 197 * DAY - 396 * 6 * HOUR;
  assert.strictEqual(floorSeconds / DAY, 98, 'the floor is not 98 days');
});

test('booksCeiling refuses nonsense rather than returning a negative count', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(x.booksCeiling({ baseSeconds: 0, maxCooldownSeconds: 0 }), 0);
  assert.strictEqual(x.booksCeiling({ baseSeconds: -1, maxCooldownSeconds: 24 * HOUR }), 0);
  assert.strictEqual(x.booksCeiling({ baseSeconds: 197 * DAY, maxCooldownSeconds: -1 }), 0);
  assert.strictEqual(x.booksCeiling({ baseSeconds: 1.5, maxCooldownSeconds: 0 }), 0);
  assert.strictEqual(x.booksCeiling({}), 0);
  assert.strictEqual(x.booksCeiling(null), 0);
});

test('planConsumables prints the floor with its cost', () => {
  const { exports: x } = loadUserscript();
  const out = x.planConsumables({
    baseSeconds: 197 * DAY, maxCooldownSeconds: 24 * HOUR,
    booksOwned: 0, bookPrice: 13500000,
  });
  assert.strictEqual(out.ceiling, 396);
  assert.strictEqual(out.floorBooks, 396);
  assert.strictEqual(out.floorSeconds, 98 * DAY);
  assert.strictEqual(out.floorCost, 396 * 13500000);
  assert.strictEqual(out.plannedBooks, 0, 'owning no books should plan no books');
  assert.strictEqual(out.plannedSeconds, 197 * DAY, 'the planned path shrank with no books');
});

test('planned use is capped at the ceiling and never inflates the saving', () => {
  const { exports: x } = loadUserscript();
  const out = x.planConsumables({
    baseSeconds: 197 * DAY, maxCooldownSeconds: 24 * HOUR,
    booksOwned: 10000, bookPrice: 13500000,
  });
  assert.strictEqual(out.plannedBooks, 396, 'owning more than the ceiling was not capped');
  assert.strictEqual(out.plannedSeconds, out.floorSeconds, 'capped planning should reach the floor');
});

test('the floor is computed from the ceiling, not from the planned date', () => {
  const { exports: x } = loadUserscript();
  const a = x.planConsumables({ baseSeconds: 197 * DAY, maxCooldownSeconds: 24 * HOUR, booksOwned: 0, bookPrice: 1 });
  const b = x.planConsumables({ baseSeconds: 197 * DAY, maxCooldownSeconds: 24 * HOUR, booksOwned: 50, bookPrice: 1 });
  assert.strictEqual(a.floorSeconds, b.floorSeconds, 'the floor moved with the number of books owned');
  assert.notStrictEqual(a.plannedSeconds, b.plannedSeconds, 'the planned path did not move');
});

test('a short path cannot be reduced below zero', () => {
  const { exports: x } = loadUserscript();
  const out = x.planConsumables({ baseSeconds: HOUR, maxCooldownSeconds: 24 * HOUR, booksOwned: 9999, bookPrice: 1 });
  assert.ok(out.floorSeconds >= 0, 'the floor went negative');
  assert.ok(out.plannedSeconds >= 0, 'the planned path went negative');
});

test('formatMoney reads the way players write money', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(x.formatMoney(396 * 13500000), '$5.35b');
  assert.strictEqual(x.formatMoney(13500000), '$13.5m');
  assert.strictEqual(x.formatMoney(900), '$900');
  assert.strictEqual(x.formatMoney(0), '$0');
});

// ─── the model and the rendered view ────────────────────────────────
//
// A model flag nothing renders is how a feature fails silently — earlier in
// this release something shipped unreachable in the state it existed for, and
// every test asserting the model passed. So the tests below read the DOM the
// player actually sees, and specifically that the floor date and its cost
// arrive in the same rendered line. "98 days for 5.35b" is actionable;
// "98 days" alone would mislead every player who read it.

const NOW = 1767225600;

function descendants(el) {
  const out = [];
  (function walk(node) {
    out.push(node);
    for (const child of (node.children || [])) walk(child);
  })(el);
  return out;
}

// A real handler set, not noopHandlers: renderPanel tests that one by identity
// and drops the nav row, so using it here would render a panel no player sees.
const handlers = {
  onToggle() {}, onViewChange() {}, onAdd() {}, onAddAll() {},
  onRemove() {}, onPickerChange() {},
};

// A queue long enough that the ceiling is not zero, built the way the panel
// builds one: through the real payload, so the model under test is the one
// init() produces rather than a hand-shaped stand-in.
function schedulePanel(options) {
  const opts = options || {};
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  const queue = exports.allRemainingCourses(
    data.completedIds, data.courses, data.activeCourse,
  );
  const model = exports.buildPanelModel({
    fetchResult: { ok: true, data: data },
    plan: { queue: opts.queue || queue, collapsed: false },
    settings: opts.settings || {},
    view: 'schedule',
    now: NOW,
  });
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const panel = exports.renderPanel(doc, mount, model, handlers);
  const nodes = descendants(panel);
  const text = nodes.map((n) => n.textContent || '').join('\n');
  return { exports: exports, model: model, nodes: nodes, text: text };
}

test('the schedule model carries the consumables block with both dates', () => {
  const { model } = schedulePanel();
  assert.ok(model.consumables, 'the ok model carries no consumables block');
  const c = model.consumables;
  assert.ok(c.ceiling > 0, 'the ceiling is zero on a 115-course queue');
  assert.strictEqual(c.floorBooks, c.ceiling);
  assert.match(c.floorFinishLabel, /UTC/);
  assert.match(c.floorCostLabel, /^\$/);
  // The floor is genuinely shorter than the unaided path, or the block says
  // nothing worth printing.
  assert.notStrictEqual(c.floorFinishLabel, model.finishLabel);
});

test('the rendered floor date never appears without its cost', () => {
  const { model, text } = schedulePanel();
  const c = model.consumables;
  const line = text.split('\n').find((l) => l.includes(c.floorFinishLabel) && l.includes('Floor'));
  assert.ok(line, `the floor date is not on screen: ${text}`);
  // The rule this feature turns on: the two arrive together, in one line, or
  // the panel is quoting a date nobody can act on.
  assert.ok(
    line.includes(c.floorCostLabel),
    `the floor date rendered without its cost: ${line}`,
  );
  assert.ok(line.includes(String(c.floorBooks)), `the floor line does not say how many Books: ${line}`);
});

test('the rendered panel says Books do not touch the running course', () => {
  const { text } = schedulePanel();
  assert.match(text, /Time already running on your current course is not affected/);
});

test('owning Books adds a planned line without moving the floor', () => {
  const none = schedulePanel({ settings: { booksOwned: 0 } });
  const some = schedulePanel({ settings: { booksOwned: 20 } });
  assert.strictEqual(none.model.consumables.plannedBooks, 0);
  assert.strictEqual(some.model.consumables.plannedBooks, 20);
  assert.strictEqual(
    none.model.consumables.floorFinishLabel,
    some.model.consumables.floorFinishLabel,
    'the floor moved when the player said they owned more Books',
  );
  assert.ok(!/With 0 Books of Carols/.test(none.text), 'a zero-Book plan rendered a planned line');
  assert.match(some.text, /With 20 Books of Carols: /);
});

test('a queue that cannot be followed gets no consumables block at all', () => {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  // A tier-3 bachelor with none of its prerequisites queued: problems is
  // non-empty, so the finish date is withheld, and there is no honest total
  // for Books to reduce either.
  const bachelor = Array.from(data.courses.values())
    .find((c) => c.tier === 3 && c.status !== 'completed' && c.status !== 'inProgress');
  const model = exports.buildPanelModel({
    fetchResult: { ok: true, data: data },
    plan: { queue: [bachelor.id], collapsed: false },
    view: 'schedule',
    now: NOW,
  });
  assert.ok(model.problems.length > 0, 'the fixture queue was followable after all');
  assert.strictEqual(model.finishLabel, null);
  assert.strictEqual(model.consumables, null, 'an unfollowable queue was given a floor date');
});

test('an empty queue and a failed fetch both carry a null consumables block', () => {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  const emptyQueue = exports.buildPanelModel({
    fetchResult: { ok: true, data: data },
    plan: { queue: [], collapsed: false },
    view: 'schedule',
    now: NOW,
  });
  assert.strictEqual(emptyQueue.consumables, null);
  const failed = exports.buildPanelModel({
    fetchResult: { ok: false, reason: 'network', detail: 'nope' },
    plan: { queue: [], collapsed: false },
    view: 'schedule',
    now: NOW,
  });
  assert.strictEqual(failed.consumables, null);
  assert.strictEqual(exports.errorModel('broken').consumables, null);
});
