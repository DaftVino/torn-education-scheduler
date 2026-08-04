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

// A minimal fake DOM for exercising renderPanel/init directly. Unlike the
// harness's default document stub (querySelector always null, appendChild a
// no-op), this one tracks created elements well enough to answer '#id'
// lookups and record what got appended where — just enough to assert on
// renderPanel's actual output rather than only on buildPanelModel's data.
function makeFakeDocument() {
  const registry = [];
  function makeElement(tag) {
    const el = {
      tagName: tag,
      id: '',
      className: '',
      textContent: '',
      value: '',
      style: {},
      dataset: {},
      children: [],
      listeners: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, val) { this[name] = val; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      remove() { this.removed = true; },
    };
    registry.push(el);
    return el;
  }
  const body = makeElement('body');
  return {
    createElement: makeElement,
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('#')) {
        const id = sel.slice(1);
        return registry.find((el) => el.id === id && !el.removed) || null;
      }
      return null;
    },
    body: body,
  };
}

const noopHandlers = { onToggle() {}, onAdd() {}, onRemove() {}, onPickerChange() {} };

test('renderPanel injects the style element once and does not duplicate it across draws', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = exports.buildPanelModel(state);
  exports.renderPanel(doc, mount, model, noopHandlers);
  exports.renderPanel(doc, mount, model, noopHandlers);
  const styleElements = doc.body.children.filter((c) => c.id === 'tes-style');
  assert.strictEqual(styleElements.length, 1, 'style element must be injected exactly once');
});

test('renderPanel renders a visible message for an error model', () => {
  const { exports } = loadUserscript();
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = exports.buildPanelModel({
    fetchResult: { ok: false, reason: 'http', detail: 'status 503' },
    plan: { queue: [], collapsed: false },
    now: NOW,
  });
  const panel = exports.renderPanel(doc, mount, model, noopHandlers);
  const body = panel.children[1];
  assert.ok(body, 'error body element missing');
  assert.match(body.textContent, /503/);
  assert.ok(mount.children.includes(panel), 'panel must be mounted');
});

test('the add button does not queue a course when the picker has no real selection', () => {
  const { exports } = loadUserscript();
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = {
    status: 'ok', message: null, reductionLabel: '40% off',
    queue: [], addable: [], stale: [], problems: [],
    finishLabel: null, totalLabel: null, collapsed: false,
    saveError: false, selectedCourseId: null,
  };
  let added = null;
  const handlers = { onToggle() {}, onAdd: (id) => { added = id; }, onRemove() {}, onPickerChange() {} };
  const panel = exports.renderPanel(doc, mount, model, handlers);
  const body = panel.children[1];
  const addButton = body.children.find((c) => c.textContent === 'add');
  assert.ok(addButton, 'add button missing');
  for (const fn of (addButton.listeners.click || [])) fn();
  assert.strictEqual(added, null, 'onAdd must not fire when nothing is selected');
});

test('init falls back to a fixed-position container when no mount point is found', async () => {
  const doc = makeFakeDocument();
  const { exports } = loadUserscript({
    location: { search: '' }, // keeps the bootstrap from auto-running init()
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await exports.init();
  const fallback = doc.body.children.find((c) => c.id === 'tes-fallback-mount');
  assert.ok(fallback, 'no fallback mount was appended to document.body');
  assert.ok(fallback.children.some((c) => c.id === 'tes-panel'), 'panel was not drawn into the fallback mount');
});

test('a queue with unmet prerequisites withholds the finish date rather than stating it confidently', () => {
  // Regression guard for the exact QA failure: PSY3690 (69) needs six
  // Psychology tier-2 courses that were never queued (here we exercise the
  // simpler MTH2320-alone case that prereq.test.js already characterizes:
  // missing 22 and 26). A wrong date stated confidently is worse than no
  // date, so both labels must go to null, not just get computed anyway.
  const { exports, state } = okState([32]);
  const model = exports.buildPanelModel(state);
  assert.strictEqual(model.problems.length, 1);
  assert.strictEqual(model.finishLabel, null);
  assert.strictEqual(model.totalLabel, null);
});

test('renderPanel surfaces a visible message naming what is missing when the plan cannot be followed', () => {
  const { exports, state } = okState([32]);
  const model = exports.buildPanelModel(state);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const panel = exports.renderPanel(doc, mount, model, noopHandlers);
  const body = panel.children[1];
  const summary = body.children.find((c) => c.className === 'tes-summary');
  assert.match(summary.textContent, /cannot be followed/i);
  assert.match(summary.textContent, /MTH1220/);
  assert.match(summary.textContent, /MTH2260/);
  // No "Queue finishes" line and no "Total queued time" line — a stale
  // problems-free wording would misleadingly imply a real date exists.
  assert.doesNotMatch(summary.textContent, /Total queued time/);
});

test('adding a tier-3 course to an empty queue auto-queues its whole prerequisite chain and validates clean', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm'; // fetchEducationData needs a session token to attempt the fetch
  const { exports, gmStore } = loadUserscript({
    location: { search: '' }, // keeps the bootstrap from auto-running init()
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await exports.init();

  const fallback = doc.body.children.find((c) => c.id === 'tes-fallback-mount');
  const panel = doc.querySelector('#tes-panel');
  assert.ok(panel && fallback.children.includes(panel), 'panel was not drawn');
  const body = panel.children[1];
  const picker = body.children.find((c) => c.tagName === 'select');
  const addButton = body.children.find((c) => c.textContent === 'add');
  picker.value = '69'; // PSY3690, a tier-3 bachelor
  for (const fn of addButton.listeners.click) fn();

  const stored = JSON.parse(gmStore.get(exports.STORAGE_KEY));
  // Every Psychology tier-2 course plus their shared tier-1 parent, 69 last —
  // matches requiredCoursesFor(69, ...) directly (see prereq.test.js).
  assert.deepStrictEqual(stored.queue, [63, 64, 65, 66, 67, 68, 132, 69]);

  const data = exports.parsePayload(loadFixture());
  assert.deepStrictEqual(exports.validateQueue(stored.queue, data.completedIds, data.courses), []);
});

test('adding a course already in the queue does not duplicate it or its prerequisites', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const { exports, gmStore } = loadUserscript({
    location: { search: '' },
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await exports.init();

  function clickAdd(courseId) {
    const panel = doc.querySelector('#tes-panel');
    const body = panel.children[1];
    const picker = body.children.find((c) => c.tagName === 'select');
    const addButton = body.children.find((c) => c.textContent === 'add');
    picker.value = String(courseId);
    for (const fn of addButton.listeners.click) fn();
  }

  clickAdd(69); // queues [63, 64, 65, 66, 67, 68, 132, 69]
  const afterFirst = JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue;
  clickAdd(69); // already queued — must be a no-op, not a second copy
  const afterSecond = JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue;

  assert.deepStrictEqual(afterSecond, afterFirst);
  assert.strictEqual(new Set(afterSecond).size, afterSecond.length);
});

test('the shell renders the requested view and offers nav to the other two', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();

  function draw(view) {
    const mount = doc.createElement('div');
    const model = exports.buildPanelModel({ ...state, view: view });
    const panel = exports.renderPanel(doc, mount, model, noopHandlers);
    const body = panel.children[1];
    return { panel: panel, body: body, nav: body.children.find((c) => c.className === 'tes-nav') };
  }

  // Default: no view on the state at all still yields the schedule view.
  const fallback = draw(undefined);
  assert.match(fallback.panel.children[0].textContent, /^Education Scheduler/);
  assert.ok(fallback.body.children.some((c) => c.tagName === 'select'), 'the schedule view did not render');

  const settings = draw('settings');
  assert.match(settings.panel.children[0].textContent, /^Settings/);
  assert.ok(
    settings.body.children.some((c) => c.className === 'tes-summary' && c.textContent.length > 0),
    'the settings view rendered nothing — an empty view reads as a broken panel'
  );

  const grid = draw('grid');
  assert.match(grid.panel.children[0].textContent, /^Degrees/);
  assert.ok(
    grid.body.children.some((c) => c.className === 'tes-summary' && c.textContent.length > 0),
    'the grid view rendered nothing'
  );

  // The nav always offers exactly the two views you are not looking at, so
  // there is no button that redraws the view already on screen.
  for (const { nav } of [fallback, settings, grid]) {
    assert.strictEqual(nav.children.length, 2);
  }
  assert.ok(!fallback.nav.children.some((b) => b.textContent === 'schedule'), 'the current view is offered as a target');
});

test('switching view redraws the panel without persisting the choice', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const { exports, gmStore } = loadUserscript({
    location: { search: '' },
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await exports.init();

  const nav = doc.querySelector('#tes-panel').children[1].children.find((c) => c.className === 'tes-nav');
  const toSettings = nav.children.find((b) => /settings/.test(b.textContent));
  for (const fn of toSettings.listeners.click) fn();

  assert.match(doc.querySelector('#tes-panel').children[0].textContent, /^Settings/);
  // view lives in init()'s closure, never in storage: a player who opened
  // settings once does not want settings every visit.
  assert.strictEqual(gmStore.get(exports.STORAGE_KEY), undefined, 'switching view wrote to storage');
  assert.strictEqual(gmStore.get(exports.SETTINGS_KEY), undefined);
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
