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

  // The pair above does not actually discriminate: on an unclamped path
  // `plannedSeconds − (ceiling − plannedBooks)·6h` equals `base − ceiling·6h`
  // algebraically, so a planned-minus-leftovers implementation passes it. The
  // two differ only where the clamp bites, so the clamped case is the one that
  // bites back — subtracting 729 leftover Books from a one-hour path lands far
  // below zero.
  const shortA = x.planConsumables({ baseSeconds: HOUR, maxCooldownSeconds: 8760 * HOUR, booksOwned: 0, bookPrice: 1 });
  const shortB = x.planConsumables({ baseSeconds: HOUR, maxCooldownSeconds: 8760 * HOUR, booksOwned: 3, bookPrice: 1 });
  assert.strictEqual(shortA.ceiling, 730, 'the cooldown budget allows a different number of books than expected');
  assert.strictEqual(shortA.floorSeconds, 0, 'a one-hour path with 730 books available does not reach zero');
  assert.strictEqual(shortB.floorSeconds, 0, 'the clamped floor moved with the number of books owned');
});

// The bug this pins: `floorSaving` was clamped to the path length while
// `floorBooks` and `floorCost` were still the raw cooldown ceiling, so the
// floor date was right and the price beside it was inflated — on the one line
// whose entire purpose is that the two can be trusted together.
test('the floor is priced by the Books it takes, not the Books the cooldown allows', () => {
  const { exports: x } = loadUserscript();
  // One course of 100.8 hours, with the largest max cooldown the settings
  // bounds allow (8760 hours). Reachable through the panel with nothing out of
  // range: queue a single short course and mistype the cooldown.
  const out = x.planConsumables({
    baseSeconds: Math.round(100.8 * HOUR), maxCooldownSeconds: 8760 * HOUR,
    booksOwned: 0, bookPrice: 13500000,
  });
  assert.strictEqual(out.ceiling, 738, 'the cooldown budget is not the number this test was written against');
  // 100.8h needs ceil(100.8 / 6) = 17 Books, not 738.
  assert.strictEqual(out.floorBooks, 17, 'the floor is counted in Books the path cannot absorb');
  assert.strictEqual(out.floorSeconds, 0);
  assert.strictEqual(out.floorCost, 17 * 13500000, 'the floor was priced at the cooldown ceiling');
  assert.strictEqual(x.formatMoney(out.floorCost), '$229.5m');
  // A partial Book still has to be bought: 100.8h is 16.8 Books.
  assert.ok(out.floorBooks * 6 * HOUR >= Math.round(100.8 * HOUR), 'the counted Books do not cover the path');

  // The same clamp on the planned side.
  const owned = x.planConsumables({
    baseSeconds: Math.round(100.8 * HOUR), maxCooldownSeconds: 8760 * HOUR,
    booksOwned: 500, bookPrice: 13500000,
  });
  assert.strictEqual(owned.plannedBooks, 17, 'planned use was counted in Books the path cannot absorb');
  assert.strictEqual(owned.plannedSeconds, 0);
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

test('formatMoney does not invent a unit nobody writes', () => {
  const { exports: x } = loadUserscript();
  // Two decimal places can carry a value across a unit boundary. Both of these
  // used to print the carried number in the smaller unit: $1000m and $999999.
  assert.strictEqual(x.formatMoney(999999999), '$1b');
  assert.strictEqual(x.formatMoney(999999), '$1m');
  // But it must not promote EAGERLY. The promotion fires when the smaller unit
  // overflows, not when this one rounds to 1 — the latter triggers from ~0.995
  // and overstates: 74 Books at 13.5m is $999,000,000, and printing $1b there
  // is a 0.1% overstatement of the one figure this feature exists to make
  // trustworthy, where $999m was both available and exact.
  assert.strictEqual(x.formatMoney(74 * 13500000), '$999m');
  assert.strictEqual(x.formatMoney(73 * 13500000), '$985.5m');
  assert.strictEqual(x.formatMoney(995000001), '$995m');
  assert.strictEqual(x.formatMoney(995001), '$995k');
  assert.strictEqual(x.formatMoney(999000000), '$999m');
  assert.strictEqual(x.formatMoney(999000), '$999k');
  // But the promotion must not reach the bottom of the scale: below a thousand
  // the player is reading exact dollars.
  assert.strictEqual(x.formatMoney(999), '$999');
  assert.strictEqual(x.formatMoney(1), '$1');
  // The boundaries either side of each unit still read the way they should.
  assert.strictEqual(x.formatMoney(1000), '$1k');
  assert.strictEqual(x.formatMoney(1500), '$1.5k');
  assert.strictEqual(x.formatMoney(994000), '$994k');
  assert.strictEqual(x.formatMoney(1e6), '$1m');
  assert.strictEqual(x.formatMoney(1e9), '$1b');
  assert.strictEqual(x.formatMoney(5e9), '$5b');
  assert.strictEqual(x.formatMoney(NaN), '$0');
  assert.strictEqual(x.formatMoney(Infinity), '$0');
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
  const queue = opts.pickQueue
    ? opts.pickQueue(data, exports)
    : exports.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const model = exports.buildPanelModel({
    fetchResult: { ok: true, data: data },
    plan: { queue: queue, collapsed: false },
    settings: opts.settings || {},
    view: 'schedule',
    now: NOW,
  });
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const panel = exports.renderPanel(doc, mount, model, handlers);
  const nodes = descendants(panel);
  const text = nodes.map((n) => n.textContent || '').join('\n');
  return { exports: exports, data: data, model: model, nodes: nodes, text: text };
}

// The one short course the clamped-render tests below queue: 100.8 hours, so a
// large maximum cooldown offers hundreds of Books where the path absorbs 17.
function shortCourse(data) {
  return [Array.from(data.courses.values()).find((c) => c.prefix === 'BUS1100').id];
}

// The line the whole feature turns on, pulled out of the rendered text so
// every test below reads the same string the player does.
function floorLine(text) {
  return text.split('\n').find((l) => l.includes('Floor with maximum Books'));
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
  assert.ok(c.floorCostLabel, 'the default settings do not carry a Book price');
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

// "$0" satisfies the letter of "the floor ships with its cost" and defeats its
// entire purpose: it tells the player the floor is free.
//
// The reachable path is a TYPED zero, not a cleared field. That distinction is
// what makes this guard live code rather than dead, so the test below pins the
// mechanism rather than trusting a comment about it: clearing restores the
// 13.5m default (onSettingChange maps '' to null and boundedInt(null) returns
// the default), while a typed 0 is stored and survives a round trip.
test('a typed zero reaches bookPrice, where a cleared field does not', () => {
  const { exports: x } = loadUserscript();
  // What onSettingChange hands normaliseSettings for a cleared number input.
  assert.strictEqual(x.normaliseSettings({ bookPrice: null }).bookPrice, 13500000,
    'clearing the field no longer restores the default — the $0 guard may now be reachable another way');
  const typed = x.normaliseSettings({ bookPrice: 0 });
  assert.strictEqual(typed.bookPrice, 0, 'a typed zero is no longer storable, which would make the $0 guard dead code');
  assert.strictEqual(x.normaliseSettings(JSON.parse(JSON.stringify(typed))).bookPrice, 0,
    'a stored zero does not survive a round trip');
});

test('a floor date is never rendered beside $0', () => {
  const { model, text } = schedulePanel({ settings: { bookPrice: 0 } });
  const c = model.consumables;
  // One field, not a flag beside it: formatMoney never returns a falsy string,
  // so null is the absence, and the view tests the label it is about to print.
  assert.strictEqual(c.floorCostLabel, null, 'an unset price was formatted into a figure');

  const line = floorLine(text);
  assert.ok(line, 'the floor line vanished — the fix was to name the gap, not to hide the date');
  assert.ok(!/\$0\b/.test(line), `the floor date rendered beside $0: ${line}`);
  assert.ok(!/\$/.test(line), `an unset price still produced a money figure: ${line}`);
  assert.match(line, /cost unknown, no Book price set/);
  // The date itself must survive: the rule is that the cost accompanies it,
  // not that the line disappears when the cost cannot be stated.
  assert.ok(line.includes(c.floorFinishLabel), `the floor date is gone: ${line}`);
  assert.ok(line.includes(String(c.floorBooks)), `the Book count is gone: ${line}`);
  // And it must say how to close the gap, or it is a dead end.
  assert.match(text, /Set a Book price in settings to see what that floor would cost\./);
});

test('a real price puts no "cost unknown" wording anywhere near the floor line', () => {
  const { text } = schedulePanel({ settings: { bookPrice: 13500000 } });
  const line = floorLine(text);
  assert.ok(!/cost unknown/.test(line), line);
  assert.ok(!/Set a Book price in settings/.test(text), 'the prompt renders when a price is set');
  assert.match(line, /\$[0-9]/, `the floor line carries no money figure: ${line}`);
});

// Every other render test walks the unclamped 115-course path. The clamped
// path is where both review findings lived, so it gets its own render test
// rather than being asserted only at the pure-function level.
test('the clamped floor renders the Books it takes, not the Books the cooldown allows', () => {
  const { exports, data, model, text } = schedulePanel({
    pickQueue: shortCourse,
    settings: { maxCooldownHours: 8760, booksOwned: 500, bookPrice: 13500000 },
  });
  const c = model.consumables;
  assert.strictEqual(c.ceiling, 738, 'the cooldown budget is not what this test was written against');
  assert.strictEqual(c.floorBooks, 17);
  assert.strictEqual(c.floorDurationLabel, '0 hours');

  const line = floorLine(text);
  assert.ok(line.includes('(17 — $229.5m)'), `the floor line prices the ceiling rather than the path: ${line}`);
  assert.ok(!line.includes('738'), `the raw cooldown ceiling reached the screen: ${line}`);

  // A floor of zero remaining queued time finishes the instant the queue
  // starts — when the active course ends, which is the only anchor either
  // date is measured from.
  const startsAt = exports.schedule({
    courses: data.courses, activeCourse: data.activeCourse, queue: [], now: NOW,
  }).startsAt;
  assert.strictEqual(c.floorFinishLabel, exports.formatTimestamp(startsAt));
  assert.ok(line.includes(c.floorFinishLabel), line);

  // Owning 500 Books cannot spend more than the path can absorb either.
  assert.strictEqual(c.plannedBooks, 17);
  assert.match(text, /With 17 Books of Carols: .* \(0 hours\)/);
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
