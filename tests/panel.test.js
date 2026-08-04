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
  const nodes = descendants(body);
  const failure = nodes.find((c) => c.className === 'tes-error');
  assert.ok(failure, 'the failure line is missing');
  assert.match(failure.textContent, /503/);
  assert.ok(mount.children.includes(panel), 'panel must be mounted');
  // The error state no longer swallows the rest of the panel. It used to
  // return before the nav row, which put the settings view — and with it the
  // debug report, the whole reason a player contacts anyone — out of reach in
  // exactly the situation that produces it.
  const nav = nodes.find((c) => c.className === 'tes-nav');
  assert.ok(nav, 'the error state stranded the view controls');
  assert.ok(
    nav.children.some((c) => c.textContent === '⚙ settings'),
    'settings is unreachable from the error state',
  );
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

test('the picker leads with an all-remaining entry and marks the bachelors', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = exports.buildPanelModel(state);
  const panel = exports.renderPanel(doc, mount, model, noopHandlers);
  const picker = panel.children[1].children.find((c) => c.tagName === 'select');

  const first = picker.children[0];
  assert.strictEqual(first.value, exports.ALL_COURSES_OPTION, 'the all-remaining entry is not first');
  assert.match(first.textContent, /all remaining courses \(115\)/);
  assert.strictEqual(picker.children.length, model.addable.length + 1);
  // The marker has to survive into the option the player actually reads, not
  // just the model: an <option> cannot be styled portably, so the text is it.
  const bachelor = picker.children.find((c) => /BIO3420/.test(c.textContent));
  assert.ok(bachelor.textContent.startsWith('[bachelor] '), 'the bachelor is unmarked in the picker');
  const plain = picker.children.find((c) => /BIO2380/.test(c.textContent));
  assert.ok(plain.textContent.indexOf('[bachelor]') === -1);
});

test('an empty addable list offers no all-remaining entry to click', () => {
  const { exports } = loadUserscript();
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = {
    status: 'ok', message: null, reductionLabel: '40% off',
    queue: [], addable: [], stale: [], problems: [],
    finishLabel: null, totalLabel: null, collapsed: false,
    saveError: false, selectedCourseId: null,
  };
  let addedAll = false;
  const handlers = {
    onToggle() {}, onAdd() {}, onRemove() {}, onPickerChange() {},
    onAddAll: () => { addedAll = true; },
  };
  const panel = exports.renderPanel(doc, mount, model, handlers);
  const body = panel.children[1];
  const picker = body.children.find((c) => c.tagName === 'select');
  assert.strictEqual(picker.children.length, 0, 'nothing is addable, so nothing may be offered');
  const addButton = body.children.find((c) => c.textContent === 'add');
  for (const fn of (addButton.listeners.click || [])) fn();
  assert.strictEqual(addedAll, false, 'onAddAll fired with nothing to add');
});

// The sentinel is a string in a field that otherwise carries integers, and it
// passes Number() as NaN. Both handlers have to recognise it before converting,
// or "add all" silently queues nothing.
test('the all-remaining entry queues every remaining course, in a followable order', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const { exports, gmStore } = loadUserscript({
    location: { search: '' },
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await exports.init();

  const body = doc.querySelector('#tes-panel').children[1];
  const picker = body.children.find((c) => c.tagName === 'select');
  const addButton = body.children.find((c) => c.textContent === 'add');
  picker.value = exports.ALL_COURSES_OPTION;
  for (const fn of (picker.listeners.change || [])) fn();
  for (const fn of addButton.listeners.click) fn();

  const stored = JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue;
  const data = exports.parsePayload(loadFixture());
  assert.deepStrictEqual(stored, exports.allRemainingCourses(data.completedIds, data.courses));
  assert.strictEqual(stored.length, 115);
  assert.strictEqual(new Set(stored).size, stored.length, 'the stored queue has duplicates');

  // The point of the feature: a plan the panel will actually date. A queue the
  // panel reports problems for gets no finish line at all.
  const redrawn = doc.querySelector('#tes-panel').children[1];
  const summary = redrawn.children.find((c) => c.className === 'tes-summary');
  assert.ok(!/cannot be followed/.test(summary.textContent), summary.textContent.split('\n')[1]);
  assert.ok(redrawn.children.some((c) => c.className === 'tes-finish'), 'no finish date for the full plan');
});

test('adding everything twice does not queue anything a second time', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const { exports, gmStore } = loadUserscript({
    location: { search: '' },
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await exports.init();

  function clickAddAll() {
    const body = doc.querySelector('#tes-panel').children[1];
    const picker = body.children.find((c) => c.tagName === 'select');
    const addButton = body.children.find((c) => c.textContent === 'add');
    picker.value = exports.ALL_COURSES_OPTION;
    for (const fn of addButton.listeners.click) fn();
  }

  clickAddAll();
  const afterFirst = JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue;
  clickAddAll(); // everything is queued; the second click has nothing to add
  const afterSecond = JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue;
  assert.deepStrictEqual(afterSecond, afterFirst);
});

// Every element under `el`, itself included. The settings view nests its rows
// inside sections, so a one-level scan of body.children no longer sees them.
function descendants(el) {
  const out = [];
  (function walk(node) {
    out.push(node);
    for (const child of (node.children || [])) walk(child);
  })(el);
  return out;
}

const hasText = (el, text) => descendants(el).some((c) => c.textContent === text);

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

  // Each assertion names content only that view produces. "Something rendered"
  // is not enough: transposing two branches of the view switch passes it, and
  // a crossed wire in the dispatch must fail loudly rather than look fine.

  // Default: no view on the state at all still yields the schedule view.
  const fallback = draw(undefined);
  assert.match(fallback.panel.children[0].textContent, /^Education Scheduler/);
  assert.ok(hasText(fallback.body, 'add'), 'the schedule view did not render its add control');
  assert.ok(!hasText(fallback.body, 'Education perks'), 'the schedule view rendered settings content');

  const settings = draw('settings');
  assert.match(settings.panel.children[0].textContent, /^Settings/);
  for (const label of ['Boosters', 'Education perks', 'Planning', 'Merits reduction (%)',
    'Principal rank (10%)', 'WSU stock block (10%)', 'Queue order']) {
    assert.ok(hasText(settings.body, label), `the settings view is missing "${label}"`);
  }
  assert.ok(!hasText(settings.body, 'add'), 'the settings view rendered schedule content');

  const grid = draw('grid');
  assert.match(grid.panel.children[0].textContent, /^Degrees/);
  assert.ok(
    grid.body.children.some((c) => c.className === 'tes-summary' && c.textContent === 'Degrees'),
    'the grid view rendered nothing'
  );
  assert.ok(!hasText(grid.body, 'Education perks'), 'the grid view rendered settings content');

  // The nav always offers exactly the two views you are not looking at, so
  // there is no button that redraws the view already on screen.
  for (const { nav } of [fallback, settings, grid]) {
    assert.strictEqual(nav.children.length, 2);
  }
  assert.ok(!fallback.nav.children.some((b) => b.textContent === 'schedule'), 'the current view is offered as a target');
});

test('the settings view shows the inference as an inference, not as a reading', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  // The fixture's reduction is a constant 40%, the one total above 30 that has
  // a single decomposition.
  const model = exports.buildPanelModel({ ...state, view: 'settings' });
  assert.strictEqual(model.perkInference.determinate, true);

  const panel = exports.renderPanel(doc, mount, model, noopHandlers);
  const note = descendants(panel.children[1]).find((c) => c.className === 'tes-note');
  assert.ok(note, 'the perks section has no note');
  assert.match(note.textContent, /Inferred from your 40% reduction/);
  assert.match(note.textContent, /Correct it if it is wrong/);
});

test('an ambiguous reduction prefills nothing and says why', () => {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  // 20% off: 20 merits alone, 10 merits plus either 10% perk, or both 10%
  // perks with no merits — four ways in, and no way to tell them apart.
  const model = exports.buildPanelModel({
    fetchResult: { ok: true, data: { ...data, reduction: { ratio: 0.8, constant: true, ratios: [0.8] } } },
    plan: { queue: [], collapsed: false },
    now: NOW,
    view: 'settings',
  });
  assert.strictEqual(model.perkInference.determinate, false);
  assert.match(model.perkInference.note, /4 possible combinations/);
  // Nothing was prefilled: the fields still read "has not said".
  assert.strictEqual(model.settings.perks.meritsPercent, null);
  assert.strictEqual(model.settings.perks.principal, null);
});

test('a reduction that varies by course refuses to name a combination', () => {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  const model = exports.buildPanelModel({
    fetchResult: { ok: true, data: { ...data, reduction: { ratio: null, constant: false, ratios: [0.6, 0.7] } } },
    plan: { queue: [], collapsed: false },
    now: NOW,
    view: 'settings',
  });
  assert.strictEqual(model.perkInference.determinate, false);
  assert.match(model.perkInference.note, /varies by course/);
  assert.strictEqual(model.reductionLabel, 'varies by course');
});

test('a reduction we could not read is not reported as one that varies', () => {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  function noteFor(reduction) {
    return exports.buildPanelModel({
      fetchResult: { ok: true, data: { ...data, reduction: reduction } },
      plan: { queue: [], collapsed: false },
      now: NOW,
      view: 'settings',
    });
  }

  // Every course with baseDuration <= 0 leaves deriveReduction with no ratios
  // at all. Telling the player their reduction "varies by course" would state
  // something about their account that nothing here supports.
  const empty = noteFor({ ratio: null, constant: false, ratios: [] });
  assert.strictEqual(empty.perkInference.determinate, false);
  assert.match(empty.perkInference.note, /could not be read from this page/);
  assert.doesNotMatch(empty.perkInference.note, /varies by course/);
  assert.strictEqual(empty.reductionLabel, 'could not be read');

  // typeof NaN === 'number': the panel must never print "Your NaN% reduction"
  // or "NaN% off".
  const notANumber = noteFor({ ratio: NaN, constant: true, ratios: [NaN] });
  assert.doesNotMatch(notANumber.perkInference.note, /NaN/);
  assert.doesNotMatch(notANumber.reductionLabel, /NaN/);
  assert.strictEqual(notANumber.reductionLabel, 'could not be read');
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
  // init() prefills the perks from the fixture's unambiguous 40%, so the
  // settings key is already written before the view switch. What matters here
  // is that switching the view adds nothing to either key.
  const settingsAfterInit = gmStore.get(exports.SETTINGS_KEY);

  const nav = doc.querySelector('#tes-panel').children[1].children.find((c) => c.className === 'tes-nav');
  const toSettings = nav.children.find((b) => /settings/.test(b.textContent));
  for (const fn of toSettings.listeners.click) fn();

  assert.match(doc.querySelector('#tes-panel').children[0].textContent, /^Settings/);
  // view lives in init()'s closure, never in storage: a player who opened
  // settings once does not want settings every visit.
  assert.strictEqual(gmStore.get(exports.STORAGE_KEY), undefined, 'switching view wrote to storage');
  assert.strictEqual(gmStore.get(exports.SETTINGS_KEY), settingsAfterInit, 'switching view rewrote the settings');
});

// Boots init() against the real fixture with a live-looking session cookie, so
// acquisition path 1 succeeds and the perk inference has data to work from.
async function initWithFixture(seedSettings) {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const loaded = loadUserscript({
    location: { search: '' }, // keeps the bootstrap from auto-running init()
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  if (seedSettings !== undefined) {
    loaded.gmStore.set(loaded.exports.SETTINGS_KEY, JSON.stringify(seedSettings));
  }
  await loaded.exports.init();
  return { ...loaded, doc: doc, stored: () => JSON.parse(loaded.gmStore.get(loaded.exports.SETTINGS_KEY)) };
}

// Switches the mounted panel to the settings view and returns its body.
function openSettings(doc) {
  const nav = doc.querySelector('#tes-panel').children[1].children.find((c) => c.className === 'tes-nav');
  for (const fn of nav.children.find((b) => /settings/.test(b.textContent)).listeners.click) fn();
  return doc.querySelector('#tes-panel').children[1];
}

// The row shape is [label span, control], so the control is the label's sibling.
function fieldFor(body, label) {
  const row = descendants(body).find((c) => c.className === 'tes-row' && c.children[0] && c.children[0].textContent === label);
  assert.ok(row, `no settings row labelled "${label}"`);
  return row.children[1];
}

const fire = (el, type) => { for (const fn of (el.listeners[type] || [])) fn(); };

test('init prefills a unique decomposition into the perk fields the player has not answered', async () => {
  const { stored } = await initWithFixture();
  // The fixture is a constant 40%: 20 merits + Principal + WSU, the only
  // combination that reaches it.
  assert.deepStrictEqual(stored().perks, { meritsPercent: 20, principal: true, wsuBlock: true });
});

test('prefill never overwrites a perk the player has already answered', async () => {
  // The player says 4% merits and no Principal rank. Both are answers, not
  // absences — 0/false are values, and only null means "has not said".
  const { stored } = await initWithFixture({
    maxCooldownHours: 6, booksOwned: 3, bookPrice: 100, jobPoints: 5,
    perks: { meritsPercent: 4, principal: false, wsuBlock: null },
    orderMode: 'as-listed',
  });
  const after = stored();
  assert.strictEqual(after.perks.meritsPercent, 4, 'prefill overwrote an entered merits value');
  assert.strictEqual(after.perks.principal, false, 'prefill overwrote an entered false');
  assert.strictEqual(after.perks.wsuBlock, true, 'the one unanswered field was not filled');
  // The rest of the settings survived the prefill write untouched.
  assert.strictEqual(after.bookPrice, 100);
  assert.strictEqual(after.maxCooldownHours, 6);
});

test('prefill writes nothing when every perk is already answered', async () => {
  const seeded = {
    maxCooldownHours: 24, booksOwned: 0, bookPrice: 13500000, jobPoints: 0,
    perks: { meritsPercent: 20, principal: true, wsuBlock: true },
    orderMode: 'as-listed',
  };
  const { gmStore, exports } = await initWithFixture(seeded);
  // Byte-identical to what was seeded: no write happened at all.
  assert.strictEqual(gmStore.get(exports.SETTINGS_KEY), JSON.stringify(seeded));
});

test('editing a settings field stores it, and a rejected value falls back to its default', async () => {
  const { doc, stored } = await initWithFixture();
  const body = openSettings(doc);

  const cooldown = fieldFor(body, 'Max booster cooldown (hours)');
  cooldown.value = '12';
  fire(cooldown, 'change');
  assert.strictEqual(stored().maxCooldownHours, 12);

  // normaliseSettings is the only writer of the canonical shape, so nonsense
  // falls back to the default rather than reaching storage — and only that
  // field is affected.
  const price = fieldFor(doc.querySelector('#tes-panel').children[1], 'Book of Carols price');
  price.value = '-5';
  fire(price, 'change');
  assert.strictEqual(stored().bookPrice, 13500000, 'a negative price was stored instead of rejected');
  assert.strictEqual(stored().maxCooldownHours, 12, 'one bad field reset an unrelated good one');
});

test('clearing a perk field returns it to "has not said" rather than zero', async () => {
  const { doc, stored } = await initWithFixture();
  const merits = fieldFor(openSettings(doc), 'Merits reduction (%)');
  merits.value = '';
  fire(merits, 'change');
  assert.strictEqual(stored().perks.meritsPercent, null);
});

test('answering "no" to a perk stores false, which is an answer and not an absence', async () => {
  const { doc, stored } = await initWithFixture();
  const principal = fieldFor(openSettings(doc), 'Principal rank (10%)');
  assert.strictEqual(principal.value, 'yes', 'the prefilled perk did not render as answered');
  principal.value = 'no';
  fire(principal, 'change');
  assert.strictEqual(stored().perks.principal, false);

  // And back to the unanswered state, which must be reachable from the form —
  // otherwise the player can never undo an answer they did not mean to give.
  // The commit redrew the settings view in place, so re-read the live body.
  const again = fieldFor(doc.querySelector('#tes-panel').children[1], 'Principal rank (10%)');
  assert.strictEqual(again.value, 'no');
  again.value = '';
  fire(again, 'change');
  assert.strictEqual(stored().perks.principal, null);
});

test('an unanswered perk renders differently from a perk answered "no"', () => {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(loadFixture());
  const doc = makeFakeDocument();

  // A perk is true, false or null, and null is the state this whole feature
  // turns on. A control that renders null and false identically shows an
  // unanswered question as a stated "no" — the panel answering on the player's
  // behalf, which is the thing the inference itself refuses to do.
  function renderWith(perks) {
    const mount = doc.createElement('div');
    const model = exports.buildPanelModel({
      // An ambiguous 20%: nothing is inferred, so whatever the fields show is
      // what the player themselves said.
      fetchResult: { ok: true, data: { ...data, reduction: { ratio: 0.8, constant: true, ratios: [0.8] } } },
      plan: { queue: [], collapsed: false },
      now: NOW,
      view: 'settings',
      settings: { perks: perks },
    });
    assert.strictEqual(model.perkInference.determinate, false);
    const panel = exports.renderPanel(doc, mount, model, noopHandlers);
    return fieldFor(panel.children[1], 'Principal rank (10%)');
  }

  const unanswered = renderWith({ meritsPercent: null, principal: null, wsuBlock: null });
  const answeredNo = renderWith({ meritsPercent: null, principal: false, wsuBlock: null });
  const answeredYes = renderWith({ meritsPercent: null, principal: true, wsuBlock: null });

  assert.notStrictEqual(unanswered.value, answeredNo.value, '"has not said" renders as a stated "no"');
  assert.strictEqual(unanswered.value, '');
  assert.strictEqual(answeredNo.value, 'no');
  assert.strictEqual(answeredYes.value, 'yes');

  // The unanswered state is named on screen, not merely a blank slot.
  const selected = (field) => field.children.find((o) => o.selected === true);
  assert.strictEqual(selected(unanswered).textContent, 'Not set');
  assert.strictEqual(selected(answeredNo).textContent, 'No');
  assert.strictEqual(selected(answeredYes).textContent, 'Yes');
});

test('the queue order is stored as its id, not coerced into a number', async () => {
  const { doc, stored } = await initWithFixture();
  const select = fieldFor(openSettings(doc), 'Queue order');
  // Task 10 adds the other modes to the dropdown; the handler must already
  // carry a string through intact, or every choice arrives as NaN and
  // normaliseSettings silently restores the default.
  select.value = 'shortest-first';
  fire(select, 'change');
  assert.strictEqual(stored().orderMode, 'shortest-first');
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
