'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');
// The shared fake DOM (tests/fake-document.js): id-aware `querySelector` over a
// registry of created elements, and a `<select>` that reports what a browser
// would. The harness's own document stub is too inert — querySelector always
// null, appendChild a no-op — to show what a view actually appended.
const { makeFakeDocument } = require('./fake-document');

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

test('formats a timestamp as a Torn City Time date and time', () => {
  const { exports } = loadUserscript();
  assert.strictEqual(exports.formatDate(1767225600), '2026-01-01');
  assert.strictEqual(exports.formatTime(1767225600), '00:00');
});

test('formats durations in days and abbreviated hours', () => {
  const { exports } = loadUserscript();
  assert.strictEqual(exports.formatDuration(0), '0 hrs');
  assert.strictEqual(exports.formatDuration(3600), '1 hrs');
  assert.strictEqual(exports.formatDuration(86400), '1 day');
  assert.strictEqual(exports.formatDuration(1088640), '12 days 14 hrs');
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
  assert.strictEqual(model.finishLabel, `${exports.formatDate(1768314240)} · ${exports.formatTime(1768314240)} TCT`);
  assert.strictEqual(model.totalLabel, '12 days 14 hrs');
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
  assert.strictEqual(model.totalLabel, '12 days 14 hrs');
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
  assert.strictEqual(model.finishLabel, `${exports.formatDate(1768314240)} · ${exports.formatTime(1768314240)} TCT`);
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
  assert.strictEqual(entry.durationLabel, '12 days 14 hrs');
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

const noopHandlers = { onToggle() {}, onAdd() {}, onAddAll() {}, onAddPreset() {}, onRemove() {}, onMove() {}, onPickerChange() {} };

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
    settings: { orderMode: 'as-listed' },
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
  const summary = descendants(body).find((c) => hasClass(c, 'tes-summary'));
  // allText, not summary.textContent: Task 7 split the summary into three
  // child elements (.tes-summary-inputs/-result/-diagnostics), so the
  // messages live on those, not on the outer .tes-summary div itself — the
  // fake document does not aggregate children's textContent onto a parent.
  assert.match(allText(summary), /cannot be followed/i);
  assert.match(allText(summary), /MTH1220/);
  assert.match(allText(summary), /MTH2260/);
  // No "Queue finishes" line and no "Total queued time" line — a stale
  // problems-free wording would misleadingly imply a real date exists.
  assert.doesNotMatch(allText(summary), /Total queued time/);
});

test('renderPanel names a dropped stale queue entry on screen, not only in the model', () => {
  // Half of do-not-revert #6 ("dropped from a stored queue and reported"):
  // the dropping is pinned by the model test above this one, but nothing
  // asserted the entry actually reaches the rendered summary.
  const { exports, state } = okState([999999, 38]);
  const model = exports.buildPanelModel(state);
  assert.deepStrictEqual(model.stale, [{ courseId: 999999, why: 'no longer in the catalogue' }]);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const panel = exports.renderPanel(doc, mount, model, noopHandlers);
  const body = panel.children[1];
  // Both the Books-of-Carols block and the real queue summary render with
  // class .tes-summary — this queue has consumables (no problems, non-empty),
  // so .find would grab the wrong one. Match on content instead of position.
  // allText, not c.textContent: Task 7 moved the stale-entry line onto the
  // nested .tes-summary-diagnostics child, so the outer .tes-summary div's
  // own textContent is empty.
  const summaries = descendants(body).filter((c) => hasClass(c, 'tes-summary'));
  const summary = summaries.find((c) => /Removed/.test(allText(c)));
  assert.ok(summary, `no .tes-summary block named the stale entry: ${summaries.map((s) => allText(s)).join(' | ')}`);
  assert.match(
    allText(summary),
    /Removed 999999 from your queue — no longer in the catalogue\./,
    `the stale entry never reached the rendered panel: ${allText(summary)}`
  );
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

test('the picker groups all five addable guide presets before all remaining and marks bachelors separately', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = exports.buildPanelModel(state);
  const panel = exports.renderPanel(doc, mount, model, noopHandlers);
  const picker = panel.children[1].children.find((c) => c.tagName === 'select');

  // First is the inert placeholder — see the untouched-picker test above for
  // what sitting at the top of a <select> actually means.
  assert.strictEqual(picker.children[0].value, '');
  const group = picker.children[1];
  assert.strictEqual(group.tagName, 'optgroup');
  assert.strictEqual(group.label, 'Guide presets');
  assert.deepStrictEqual(group.children.map((option) => option.textContent), [
    '0-Start Here', '1-Fighting', '2-Crime', '3-Trader / collector', '4-Undecided',
  ]);
  assert.ok(group.children.every((option) => option.className === 'tes-option-preset'));
  const all = picker.children[2];
  assert.strictEqual(all.value, exports.ALL_COURSES_OPTION, 'the all-remaining entry is buried');
  // Unabbreviated on purpose (see the comment above formatDuration): the
  // picker is prose, not a dense readout, and matches the all-remaining
  // banner's own title rather than the grid's "crs". This assertion pins
  // that decision, not an oversight lagging behind the grid's abbreviation.
  assert.match(all.textContent, /all remaining courses \(115\)/);
  assert.strictEqual(picker.children.length, model.addable.length + 3);
  // The marker has to survive into the option the player actually reads, not
  // just the model: no text prefix any more (owner decision), so the class
  // is what carries it — see the "bachelor colour" test below for the rule
  // itself.
  const bachelor = picker.children.find((c) => /BIO3420/.test(c.textContent));
  assert.ok(!/\[bachelor\]/i.test(bachelor.textContent), 'the bachelor label still carries the retired text prefix');
  assert.strictEqual(bachelor.className, 'tes-option-bachelor', 'the bachelor is unmarked in the picker');
  const plain = picker.children.find((c) => /BIO2380/.test(c.textContent));
  assert.ok(plain.textContent.indexOf('[bachelor]') === -1);
  assert.notStrictEqual(plain.className, 'tes-option-bachelor', 'a non-bachelor was marked as one');
});

test('bachelor labels carry no prefix', () => {
  const { exports, state } = okState([]);
  const model = exports.buildPanelModel(state);
  for (const a of model.addable) assert.ok(!/\[bachelor\]/i.test(a.label));
});

test('bachelor options are classed and non-bachelors are not', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = exports.buildPanelModel(state);
  const panel = exports.renderPanel(doc, mount, model, noopHandlers);
  const picker = panel.children[1].children.find((c) => c.tagName === 'select');
  const opts = picker.children.filter((c) => c.tagName === 'option');
  const marked = opts.filter((o) => /tes-option-bachelor/.test(o.className || ''));
  assert.ok(marked.length > 0, 'no bachelor option was classed');
  assert.ok(marked.length < opts.length, 'every option was classed as a bachelor');
});

test('the bachelor colour is the finish-line green', () => {
  const { exports } = okState([]);
  assert.match(exports.panelStyleText(), /\.tes-option-bachelor[^}]*var\(--tm-good-text\)/);
});

test('guide presets use blue text and never the bachelor green', () => {
  const { exports } = okState([]);
  const css = exports.panelStyleText();
  assert.match(css, /\.tes-option-preset[^}]*var\(--tm-accent-text\)/);
  assert.doesNotMatch(css, /\.tes-option-preset[^}]*var\(--tm-good-text\)/);
  assert.match(css, /--tm-accent-text:\s*#6ea3d0/);
});

test('a guide preset dispatches by key before numeric course conversion', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  let presetKey = null;
  let numeric = null;
  const handlers = {
    onToggle() {}, onRemove() {}, onPickerChange() {}, onAddAll() {},
    onAdd: (id) => { numeric = id; },
    onAddPreset: (key) => { presetKey = key; },
  };
  const body = exports.renderPanel(doc, doc.createElement('div'), exports.buildPanelModel(state), handlers).children[1];
  const picker = body.children.find((child) => child.tagName === 'select');
  picker.value = exports.GUIDE_PRESETS[1].value;
  const add = body.children.find((child) => child.textContent === 'add');
  for (const fn of add.listeners.click) fn();
  assert.strictEqual(presetKey, 'fighting');
  assert.strictEqual(numeric, null);
});

test('guide presets disappear when all their work is represented', () => {
  const { exports, state } = okState([]);
  const data = state.fetchResult.data;
  state.plan.queue = exports.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const model = exports.buildPanelModel(state);
  assert.deepStrictEqual(model.guidePresets, []);

  const doc = makeFakeDocument();
  const panel = exports.renderPanel(doc, doc.createElement('div'), model, noopHandlers);
  const picker = panel.children[1].children.find((child) => child.tagName === 'select');
  assert.ok(!picker.children.some((child) => child.tagName === 'optgroup'));
});

test('one fully completed preset disappears while presets with work remain', () => {
  const { exports, state } = okState([]);
  const data = state.fetchResult.data;
  data.completedIds = new Set();
  data.activeCourse = null;
  for (const course of data.courses.values()) course.status = 'available';
  const foundation = exports.expandGuidePreset(
    'foundation', data.completedIds, data.courses, data.activeCourse, []
  );
  assert.strictEqual(foundation.ok, true);
  for (const id of foundation.courseIds) data.completedIds.add(id);

  const model = exports.buildPanelModel(state);
  assert.deepStrictEqual(model.guidePresets.map((preset) => preset.label), [
    '1-Fighting', '2-Crime', '3-Trader / collector', '4-Undecided',
  ]);
  const doc = makeFakeDocument();
  const panel = exports.renderPanel(doc, doc.createElement('div'), model, noopHandlers);
  const picker = panel.children[1].children.find((child) => child.tagName === 'select');
  const group = picker.children.find((child) => child.tagName === 'optgroup');
  assert.deepStrictEqual(group.children.map((option) => option.textContent), [
    '1-Fighting', '2-Crime', '3-Trader / collector', '4-Undecided',
  ]);
});

// The failure this guards is not hypothetical: a browser selects the first
// option, so before the placeholder existed an untouched picker submitted the
// all-remaining sentinel, and a stray click on `add` queued the whole
// catalogue. Removal is one course at a time and nothing clears a queue, so
// the walk back was 115 clicks.
test('an untouched picker submits nothing, not every remaining course', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = exports.buildPanelModel(state);
  assert.strictEqual(model.selectedCourseId, null, 'a fresh panel has no selection');

  let added = null;
  let addedAll = false;
  const handlers = {
    onToggle() {}, onRemove() {}, onPickerChange() {},
    onAdd: (id) => { added = id; },
    onAddAll: () => { addedAll = true; },
  };
  const body = exports.renderPanel(doc, mount, model, handlers).children[1];
  const picker = body.children.find((c) => c.tagName === 'select');

  assert.strictEqual(picker.children[0].value, '', 'the first option is not inert');
  assert.strictEqual(picker.value, '', 'an untouched picker is already on a real option');
  assert.notStrictEqual(picker.value, exports.ALL_COURSES_OPTION);
  // Still near the top, so it stays discoverable without scrolling 115 entries.
  assert.strictEqual(picker.children[1].tagName, 'optgroup');
  assert.strictEqual(picker.children[2].value, exports.ALL_COURSES_OPTION);

  const addButton = body.children.find((c) => c.textContent === 'add');
  for (const fn of addButton.listeners.click) fn();
  assert.strictEqual(added, null, 'a stray click queued a course');
  assert.strictEqual(addedAll, false, 'a stray click queued the entire catalogue');
});

test('an empty addable list offers no all-remaining entry to click', () => {
  const { exports } = loadUserscript();
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const model = {
    status: 'ok', message: null, reductionLabel: '40% off',
    queue: [], addable: [], stale: [], problems: [],
    guidePresets: [],
    finishLabel: null, totalLabel: null, collapsed: false,
    saveError: false, selectedCourseId: null,
    settings: { orderMode: 'as-listed' },
  };
  let addedAll = false;
  const handlers = {
    onToggle() {}, onAdd() {}, onRemove() {}, onPickerChange() {},
    onAddAll: () => { addedAll = true; },
  };
  const panel = exports.renderPanel(doc, mount, model, handlers);
  const body = panel.children[1];
  const picker = body.children.find((c) => c.tagName === 'select');
  assert.deepStrictEqual(picker.children.map((c) => c.tagName), ['option']);
  assert.ok(!picker.children.some((child) => child.value === exports.ALL_COURSES_OPTION));
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
  assert.deepStrictEqual(stored, exports.allRemainingCourses(data.completedIds, data.courses, data.activeCourse));
  assert.strictEqual(stored.length, 115);
  assert.strictEqual(new Set(stored).size, stored.length, 'the stored queue has duplicates');

  // The point of the feature: a plan the panel will actually date. A queue the
  // panel reports problems for gets no finish line at all.
  const redrawn = doc.querySelector('#tes-panel').children[1];
  // Asserting about the queue summary (the block carrying a
  // .tes-summary-inputs child, whose line opens "Perk reduction:"), not the
  // consumables/Books block — that one also carries .tes-summary and renders
  // first whenever the queue has a finish date, and it can never contain
  // "cannot be followed", so taking the first .tes-summary here would pass
  // regardless of what the real summary says. Task 7 split the summary into
  // .tes-summary-inputs/-result/-diagnostics children, so that child's
  // presence — not the outer div's own (now-empty) textContent — is what
  // distinguishes it from the Books block.
  const summary = descendants(redrawn).find(
    (c) => hasClass(c, 'tes-summary') && descendants(c).some((d) => d.className === 'tes-summary-inputs')
  );
  assert.ok(summary, 'no queue summary block rendered');
  assert.ok(!/cannot be followed/.test(allText(summary)), allText(summary));
  assert.ok(descendants(redrawn).some((c) => c.className === 'tes-finish'), 'no finish date for the full plan');
});

// Number('') is 0 and passes Number.isInteger, so choosing the placeholder back
// used to leave the panel remembering a selection of course 0 — invisible only
// because no course has that id and the placeholder is first anyway.
test('choosing the placeholder returns the panel to no selection at all', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const { exports } = loadUserscript({
    location: { search: '' },
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await exports.init();

  const pickerIn = (panel) => panel.children[1].children.find((c) => c.tagName === 'select');
  const picker = pickerIn(doc.querySelector('#tes-panel'));
  picker.value = '38';
  for (const fn of picker.listeners.change) fn();
  picker.value = '';
  for (const fn of picker.listeners.change) fn();

  // Redraw through a handler that changes nothing else about the plan: collapse
  // and reopen, which rebuilds the picker from the model twice.
  for (let i = 0; i < 2; i += 1) {
    const toggle = doc.querySelector('#tes-panel').children[0].children[1];
    for (const fn of toggle.listeners.click) fn();
  }

  const redrawn = pickerIn(doc.querySelector('#tes-panel'));
  assert.strictEqual(redrawn.children[0].selected, true, 'the placeholder is not the selection');
  assert.strictEqual(redrawn.value, '');
  assert.ok(!redrawn.children.some((c) => c.value === '0'), 'course 0 must not be a real option');
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

// Token match, not string equality. The schedule view's summary block carries
// two classes — `tes-summary tes-summary-queue`, the second being what draws
// the separator above the queue rows — so `className === 'tes-summary'` stopped
// finding it. Splitting is also what keeps this from matching the block's own
// `.tes-summary-inputs`/`-result`/`-diagnostics` children, which a substring
// test would.
function hasClass(el, name) {
  return String(el.className || '').split(' ').indexOf(name) !== -1;
}

const hasText = (el, text) => descendants(el).some((c) => c.textContent === text);
const EDUCATION_PERKS_TITLE = 'Education perks';

function settingsSectionTitle(section) {
  const title = descendants(section).find((c) => c.className === 'tes-section-title');
  return title && title.textContent;
}

function settingsSectionRole(section) {
  const role = descendants(section).find((c) => c.className === 'tes-section-role');
  return role && role.textContent;
}

function findSettingsSection(root, title) {
  return descendants(root).find((c) => c.className === 'tes-section' && settingsSectionTitle(c) === title);
}

test('the shell renders the requested view with every available nav button', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();

  function draw(view, orderMode) {
    const mount = doc.createElement('div');
    const model = exports.buildPanelModel({
      ...state,
      view: view,
      settings: orderMode ? { orderMode: orderMode } : undefined,
    });
    const panel = exports.renderPanel(doc, mount, model, noopHandlers);
    const body = panel.children[1];
    return { panel: panel, body: body, nav: body.children.find((c) => c.className === 'tes-nav') };
  }

  // Each assertion names content only that view produces. "Something rendered"
  // is not enough: transposing two branches of the view switch passes it, and
  // a crossed wire in the dispatch must fail loudly rather than look fine.

  // Default: no view on the state at all still yields the schedule view.
  const fallback = draw(undefined);
  assert.match(fallback.panel.children[0].children[0].textContent, /^Education Scheduler/);
  assert.ok(hasText(fallback.body, 'add'), 'the schedule view did not render its add control');
  assert.ok(!hasText(fallback.body, EDUCATION_PERKS_TITLE), 'the schedule view rendered settings content');

  const settings = draw('settings');
  assert.match(settings.panel.children[0].children[0].textContent, /^Settings/);
  for (const label of ['Boosters', 'Planning', EDUCATION_PERKS_TITLE, 'Merits reduction (%)',
    'Principal rank (10%)', 'WSU stock block (10%)', 'Job points available', 'Queue order']) {
    assert.ok(hasText(settings.body, label), `the settings view is missing "${label}"`);
  }
  assert.ok(!hasText(settings.body, 'add'), 'the settings view rendered schedule content');

  const grid = draw('grid');
  assert.match(grid.panel.children[0].children[0].textContent, /^Degrees/);
  // Content only the grid view produces: a degree box titled with its bachelor.
  // tests/grid.test.js owns the view's behaviour; this pins the dispatch.
  assert.ok(hasText(grid.body, 'Biology (BIO3420)'), 'the grid view did not render its boxes');
  assert.ok(!hasText(grid.body, EDUCATION_PERKS_TITLE), 'the grid view rendered settings content');

  const focus = draw('focus');
  assert.match(focus.panel.children[0].children[0].textContent, /^Focus/);
  // Content only the focus view produces: a category from the taxonomy.
  // tests/panel.test.js's own focus tests own the view's behaviour beyond
  // this; this pins the dispatch.
  assert.ok(hasText(focus.body, 'Working Stats'), 'the focus view did not render its categories');
  assert.ok(!hasText(focus.body, EDUCATION_PERKS_TITLE), 'the focus view rendered settings content');

  // Planner destinations are fixed controls, including the current view.
  // v0.3.0 Task 2 adds a reset button after settings on schedule, focus and
  // settings — never grid, which owns no player data.
  assert.strictEqual(fallback.nav.children.length, 5);
  assert.strictEqual(grid.nav.children.length, 4);
  assert.strictEqual(focus.nav.children.length, 5);
  assert.strictEqual(settings.nav.children.length, 5);
  for (const [view, rendered] of [['schedule', fallback], ['grid', grid], ['focus', focus], ['settings', settings]]) {
    const label = view === 'grid' ? 'degrees' : view;
    const current = rendered.nav.children.find((b) => b.textContent === label || (view === 'settings' && /settings/i.test(b.textContent)));
    assert.ok(current, `the current ${view} view is missing from its nav`);
    assert.strictEqual(current.attributes['aria-current'], 'page');
  }

  const noFocusSchedule = draw('schedule', 'shortest-first');
  const noFocusGrid = draw('grid', 'shortest-first');
  const noFocusSettings = draw('settings', 'shortest-first');
  assert.strictEqual(noFocusSchedule.nav.children.length, 4);
  assert.strictEqual(noFocusGrid.nav.children.length, 3);
  assert.strictEqual(noFocusSettings.nav.children.length, 4);
});

// Task 4: settings becomes a permanent right-aligned landmark rather than a
// fourth toggle target. Adapted from the task brief, which assumed a
// browser-accurate `querySelectorAll` and `dispatchEvent` — tests/fake-
// document.js implements neither (`querySelectorAll` always returns `[]`,
// and elements have no `getAttribute`/`dispatchEvent` at all), so these use
// this file's own idioms: `descendants()`, `.children` and `.attributes`.
function navLabels(panel) {
  const nav = descendants(panel).find((c) => c.className === 'tes-nav');
  return nav ? nav.children.map((b) => b.textContent) : [];
}

test('every view shows planner buttons in schedule, degrees, focus order', () => {
  const { x } = load();
  const doc = makeDocument();
  const on = (v) => navLabels(x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: v })), handlers()));
  for (const view of ['schedule', 'grid', 'focus', 'settings']) {
    assert.deepStrictEqual(on(view).slice(0, 3), ['schedule', 'degrees', 'focus']);
  }
});

test('settings is present on every view, enabled, and identically styled', () => {
  const { x } = load();
  const doc = makeDocument();
  const classes = new Set();
  for (const v of ['schedule', 'grid', 'settings']) {
    const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: v })), handlers());
    const nav = descendants(panel).find((c) => c.className === 'tes-nav');
    const btn = nav.children.find((b) => /settings/i.test(b.textContent));
    assert.ok(btn, `settings must render on ${v}`);
    assert.notStrictEqual(btn.disabled, true, 'the landmark is never disabled');
    classes.add(btn.className || '');
  }
  assert.strictEqual(classes.size, 1, 'settings must look the same on every view');
});

test('settings is marked current on the settings view only', () => {
  const { x } = load();
  const doc = makeDocument();
  const cur = (v) => {
    const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: v })), handlers());
    const nav = descendants(panel).find((c) => c.className === 'tes-nav');
    const btn = nav.children.find((b) => /settings/i.test(b.textContent));
    return btn.attributes['aria-current'];
  };
  assert.strictEqual(cur('settings'), 'page');
  assert.notStrictEqual(cur('schedule'), 'page');
});

test('settings holds the same position from the end of the row on every view', () => {
  const { x } = load();
  const doc = makeDocument();
  const idx = (v) => {
    const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: v })), handlers());
    const nav = descendants(panel).find((c) => c.className === 'tes-nav');
    const kids = nav.children;
    const at = kids.findIndex((k) => /settings/i.test(k.textContent || ''));
    return kids.length - at;
  };
  // Grid gets no reset button (v0.3.0 Task 2 — it owns no player data), so
  // settings is still the last thing in its row, same as before that task.
  // Every other view now appends a reset button after settings, which moves
  // settings one slot in from the end without moving settings itself: the
  // reset button follows it into the same right-aligned group. The
  // invariant this test protects is "settings sits a fixed distance from the
  // end, and that distance depends only on whether a reset button renders
  // beside it" — not "always last".
  assert.strictEqual(idx('grid'), 1);
  assert.strictEqual(idx('schedule'), 2);
  assert.strictEqual(idx('settings'), 2);
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
  // Scoped to the recorded-not-calculated section itself (not just matched on
  // content) so this stays pinned to the note leading that section — its
  // whole job — rather than passing no matter where the note ends up on
  // the page.
  const recordedSection = findSettingsSection(panel.children[1], EDUCATION_PERKS_TITLE);
  const note = descendants(recordedSection).find((c) => c.className === 'tes-note'
    && /Inferred from your 40% reduction/.test(c.textContent));
  assert.ok(note, 'the recorded settings section has no inference note');
  assert.match(note.textContent, /Inferred from your 40% reduction/);
  assert.match(note.textContent, /Correct it if it is wrong/);
});

test('the recorded settings note explains why its fields do not change dates and what they are for', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const panel = exports.renderPanel(
    doc,
    doc.createElement('div'),
    exports.buildPanelModel({ ...state, view: 'settings' }),
    noopHandlers,
  );
  const sections = descendants(panel.children[1]).filter((c) => c.className === 'tes-section');
  const recorded = sections.find((c) => settingsSectionTitle(c) === EDUCATION_PERKS_TITLE);
  const explanatoryNotes = recorded.children.filter((c) => c.className === 'tes-note'
    && /These fields do not change/.test(c.textContent));

  assert.strictEqual(explanatoryNotes.length, 1, 'the inert-field explanation is split or repeated');
  assert.match(explanatoryNotes[0].textContent, /do not change any date the panel shows/);
  assert.match(explanatoryNotes[0].textContent, /applied your education perks to the course durations it sends/);
  assert.match(explanatoryNotes[0].textContent, /reads those durations rather than rebuilding them/);
  // Job points used to be listed here as a fourth inert field. They are not
  // inert any more (planConsumables spends them), so the note has to say so
  // rather than leave a player hunting the section they were moved out of.
  assert.match(explanatoryNotes[0].textContent, /Job points are not among them/);
  assert.match(explanatoryNotes[0].textContent, /Boosters/);
  assert.match(explanatoryNotes[0].textContent, /shared plan and a debug report/);
});

test('only date-changing booster fields remain and inert fields render only in the recorded section', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const panel = exports.renderPanel(
    doc,
    doc.createElement('div'),
    exports.buildPanelModel({ ...state, view: 'settings' }),
    noopHandlers,
  );
  const sections = descendants(panel.children[1]).filter((c) => c.className === 'tes-section');
  const section = (title) => sections.find((c) => settingsSectionTitle(c) === title);
  const rowLabels = (parent) => parent.children
    .filter((c) => c.className === 'tes-row')
    .map((c) => c.children[0].textContent);
  const relocated = [
    'Merits reduction (%)',
    'Principal rank (10%)',
    'WSU stock block (10%)',
  ];

  // Job points came BACK to Boosters when they stopped being inert: they are
  // spent by the player on courses not yet started, so planConsumables really
  // does subtract them. First in the section because they are first in the
  // arithmetic — the Book figures are computed against what they leave behind.
  assert.deepStrictEqual(rowLabels(section('Boosters')), [
    'Job points available',
    'Max booster cooldown (hours)',
    'Books of Carols owned',
    'Book of Carols price',
  ]);
  assert.deepStrictEqual(rowLabels(section(EDUCATION_PERKS_TITLE)), relocated);
  for (const label of relocated) {
    assert.ok(!rowLabels(section('Boosters')).includes(label), `${label} still renders in Boosters`);
  }
});

test('settings keeps five sections in the selected order with explicit roles', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const panel = exports.renderPanel(
    doc,
    doc.createElement('div'),
    exports.buildPanelModel({ ...state, view: 'settings' }),
    noopHandlers,
  );
  const titles = panel.children[1].children
    .filter((c) => c.className === 'tes-section')
    .map(settingsSectionTitle);
  const roles = panel.children[1].children
    .filter((c) => c.className === 'tes-section')
    .map(settingsSectionRole);

  assert.deepStrictEqual(titles, [
    'Boosters',
    'Planning',
    EDUCATION_PERKS_TITLE,
    'Help',
    'Share this plan',
  ]);
  assert.deepStrictEqual(roles, [
    'Affects dates',
    'Affects order',
    'Saved only · not used in dates',
    'Troubleshooting',
    'Export or import',
  ]);
  const headers = descendants(panel.children[1]).filter((c) => c.className === 'tes-section-header');
  assert.strictEqual(headers.length, 5, 'every Settings section needs one visual header bar');
  assert.ok(headers.every((header) => descendants(header).some((c) => c.className === 'tes-section-title')));
  assert.ok(headers.every((header) => descendants(header).some((c) => c.className === 'tes-section-role')));
});

test('each relocated field commits through onSettingChange with its unchanged path', () => {
  const { exports, state } = okState([]);
  const doc = makeFakeDocument();
  const commits = [];
  const panel = exports.renderPanel(
    doc,
    doc.createElement('div'),
    exports.buildPanelModel({ ...state, view: 'settings' }),
    { onSettingChange: (field, value) => commits.push([field, value]) },
  );
  const recorded = findSettingsSection(panel.children[1], EDUCATION_PERKS_TITLE);

  const edit = (parent, label, value) => {
    const field = fieldFor(parent, label);
    field.value = value;
    fire(field, 'change');
  };
  edit(recorded, 'Merits reduction (%)', '12');
  edit(recorded, 'Principal rank (10%)', 'no');
  edit(recorded, 'WSU stock block (10%)', 'no');
  // Job points now live in Boosters, but the field path is the one thing that
  // must not have moved with them: the share string and the debug report both
  // key off `jobPoints`, and a rename would silently break every plan already
  // in circulation.
  const boosters = findSettingsSection(panel.children[1], 'Boosters');
  edit(boosters, 'Job points available', '17');

  assert.deepStrictEqual(commits, [
    ['perks.meritsPercent', '12'],
    ['perks.principal', false],
    ['perks.wsuBlock', false],
    ['jobPoints', '17'],
  ]);
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

  assert.match(doc.querySelector('#tes-panel').children[0].children[0].textContent, /^Settings/);
  // view lives in init()'s closure, never in storage: a player who opened
  // settings once does not want settings every visit.
  assert.strictEqual(gmStore.get(exports.STORAGE_KEY), undefined, 'switching view wrote to storage');
  assert.strictEqual(gmStore.get(exports.SETTINGS_KEY), settingsAfterInit, 'switching view rewrote the settings');
});

// Boots init() against the real fixture with a live-looking session cookie, so
// acquisition path 1 succeeds and the perk inference has data to work from.
async function initWithFixture(seedSettings, seedPlan, fixture) {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const loaded = loadUserscript({
    location: { search: '' }, // keeps the bootstrap from auto-running init()
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(fixture || loadFixture()) }),
  });
  if (seedSettings !== undefined) {
    loaded.gmStore.set(loaded.exports.SETTINGS_KEY, JSON.stringify(seedSettings));
  }
  // Seeded before init(), because loadPlan() runs inside it: a queue written
  // afterwards would be read by nothing.
  if (seedPlan !== undefined) {
    loaded.gmStore.set(loaded.exports.STORAGE_KEY, JSON.stringify(seedPlan));
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

test('changing max cooldown redraws the floor arithmetic and its cooldown descriptor together', async () => {
  const { doc, stored } = await initWithFixture(undefined, { queue: [38], collapsed: false });
  const floorText = () => {
    const row = descendants(doc.querySelector('#tes-panel'))
      .find((node) => node.className === 'tes-booster-row'
        && descendants(node).some((child) => child.textContent === 'Maximum Books floor'));
    assert.ok(row, 'the maximum-Books floor is missing');
    return descendants(row).map((node) => node.textContent || '').join(' ');
  };

  const before = floorText();
  assert.match(before, /48hr CD/);
  const beforeBooks = Number(before.match(/(\d+) Books/)[1]);

  const cooldown = fieldFor(openSettings(doc), 'Max booster cooldown (hours)');
  cooldown.value = '24';
  fire(cooldown, 'change');
  assert.strictEqual(stored().maxCooldownHours, 24);

  const nav = descendants(doc.querySelector('#tes-panel')).find((node) => node.className === 'tes-nav');
  fire(nav.children.find((button) => /schedule/i.test(button.textContent)), 'click');
  const after = floorText();
  assert.match(after, /24hr CD/);
  assert.doesNotMatch(after, /48hr CD/);
  assert.notStrictEqual(Number(after.match(/(\d+) Books/)[1]), beforeBooks,
    'the descriptor changed but the floor calculation did not');
});

test('changing a perk field leaves the schedule reduction read from Torn unchanged', async () => {
  const { doc, stored } = await initWithFixture();
  const reductionLine = () => descendants(doc.querySelector('#tes-panel'))
    .find((c) => c.className === 'tes-summary-inputs').textContent;
  assert.strictEqual(reductionLine(), 'Perk reduction: 40% off');

  const merits = fieldFor(openSettings(doc), 'Merits reduction (%)');
  merits.value = '0';
  fire(merits, 'change');
  assert.strictEqual(stored().perks.meritsPercent, 0, 'the perk edit did not reach settings');

  const panel = doc.querySelector('#tes-panel');
  const nav = descendants(panel).find((c) => c.className === 'tes-nav');
  fire(nav.children.find((b) => /schedule/i.test(b.textContent)), 'click');
  assert.strictEqual(reductionLine(), 'Perk reduction: 40% off');
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
  // The ids are spelled out here rather than read back off ORDER_MODE_LABELS,
  // which would assert only that the view renders whatever it was handed. This
  // is the one place the rendered value and the string normaliseSettings
  // accepts are compared against a third party, so a typo like `shortest_first`
  // fails here instead of shipping as a preference that silently refuses to
  // change. (Until Task 10 this test appended its own option, because
  // production offered one — which meant it could not have caught that.)
  assert.deepStrictEqual(
    select.children.map((o) => o.value),
    ['as-listed', 'shortest-first', 'unlocks-first', 'focus'],
    'the rendered dropdown does not offer exactly the four shipped modes',
  );
  // The handler must carry a string through intact, or every choice arrives as
  // NaN and normaliseSettings silently restores the default.
  select.value = 'shortest-first';
  fire(select, 'change');
  assert.strictEqual(stored().orderMode, 'shortest-first');
});

// The queue rows as the player reads them, in the order they were drawn. Each
// row's remove button carries its course id, which is the only place the
// rendered row states which course it is without parsing a label.
function renderedQueueIds(doc) {
  const body = doc.querySelector('#tes-panel').children[1];
  return descendants(body)
    .filter((el) => el.className === 'tes-queue-row')
    .map((row) => (row.children || []).find((c) => c.dataset && c.dataset.courseId !== undefined))
    .filter(Boolean)
    .map((btn) => Number(btn.dataset.courseId));
}

test('the ordering the player chose is the order the panel renders', async () => {
  // The wiring test. Every other assertion in this task calls orderQueue
  // directly, so deleting the single line in buildPanelModel that applies
  // settings.orderMode left the whole suite green while the control did
  // nothing: the dropdown still rendered, the note still explained
  // time-to-benefit, and the player's choice reached no queue. This release
  // has already shipped one feature that was unreachable in the state it
  // existed for, and the reason nothing caught it was the same — everything
  // asserted the model, nothing asserted the wiring.
  //
  // Four tier-1 roots from four categories: no prerequisite relates any of
  // them, so nothing but the chosen mode can decide the order. They also all
  // share one duration, which is why the mode under test is unlocks-first —
  // shortest-first has nothing to sort these by.
  const QUEUE = [63, 112, 1, 88];
  const plan = { queue: QUEUE, collapsed: false };

  const asListed = await initWithFixture({ orderMode: 'as-listed' }, plan);
  assert.deepStrictEqual(renderedQueueIds(asListed.doc), QUEUE, 'as-listed did not render the stored order');

  const unlocks = await initWithFixture({ orderMode: 'unlocks-first' }, plan);
  // LAW1880 (14 downstream), BUS1100 (12), GEN1112 (11), PSY1630 (7).
  assert.deepStrictEqual(renderedQueueIds(unlocks.doc), [88, 1, 112, 63], 'the chosen ordering never reached the rendered queue');
});

test('a manual move materialises the visible order, switches to As listed, and persists', async () => {
  const loaded = await initWithFixture(
    { orderMode: 'shortest-first' },
    { queue: [38, 39, 40], collapsed: false },
  );
  const { doc, gmStore, exports } = loaded;
  assert.deepStrictEqual(renderedQueueIds(doc), [39, 38, 40],
    'the automatic mode did not create a distinct visible order for the test');

  const rows = descendants(doc.querySelector('#tes-panel'))
    .filter((el) => el.className === 'tes-queue-row');
  const down = rows[1].children[0].children[1];
  assert.notStrictEqual(down.disabled, true, 'the independent neighbouring courses cannot be swapped');
  fire(down, 'click');

  assert.deepStrictEqual(JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue, [39, 40, 38]);
  assert.strictEqual(JSON.parse(gmStore.get(exports.SETTINGS_KEY)).orderMode, 'as-listed');
  assert.deepStrictEqual(renderedQueueIds(doc), [39, 40, 38],
    'the manually moved queue was immediately sorted back into place');
  const notice = descendants(doc.querySelector('#tes-panel'))
    .find((el) => el.className === 'tes-note tes-queue-notice');
  assert.ok(notice, 'the automatic setting change was not explained');
  assert.match(notice.textContent, /changed to As listed/i);
});

test('a disabled prerequisite move has no click handler and writes nothing', async () => {
  const loaded = await initWithFixture(
    { orderMode: 'as-listed' },
    { queue: [22, 26, 32], collapsed: false },
  );
  const { doc, gmStore, exports } = loaded;
  const before = gmStore.get(exports.STORAGE_KEY);
  const rows = descendants(doc.querySelector('#tes-panel'))
    .filter((el) => el.className === 'tes-queue-row');
  const blockedDown = rows[0].children[0].children[1];
  assert.strictEqual(blockedDown.disabled, true);
  assert.deepStrictEqual(blockedDown.listeners.click || [], []);
  fire(blockedDown, 'click');
  assert.strictEqual(gmStore.get(exports.STORAGE_KEY), before);
  assert.deepStrictEqual(renderedQueueIds(doc), [22, 26, 32]);
});

test('the ordering control says on screen that it does not change the finish date', async () => {
  // The one claim this feature must not be left to imply. Ordering changes
  // time-to-benefit, not the total — courses run one at a time, so the total is
  // a sum. Several community guides blur the two, and a dropdown offered with
  // no note beside it lets a player carry that belief into the choice the panel
  // just handed them. Asserted on screen rather than on the model, because a
  // note nothing renders is how this would fail silently.
  const { doc } = await initWithFixture();
  const body = openSettings(doc);
  const notes = descendants(body)
    .filter((el) => el.className === 'tes-note')
    .map((el) => el.textContent);
  const orderNote = notes.find((t) => /finish date/.test(t));
  assert.ok(orderNote, `no note beside the ordering control; the notes were: ${JSON.stringify(notes)}`);
  assert.match(orderNote, /does not change the finish date/);
  // And it must say what ordering *does* change, or it reads as a control with
  // no purpose rather than one with a different purpose.
  assert.match(orderNote, /paying off/);
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

test('init() renders a draw() that threw inside the panel instead of blanking the page', async () => {
  // The last untested safety net in the file. init() is async, so an unguarded
  // throw out of draw() is an unhandled rejection: no panel, no message, and a
  // player who reads it as Torn being broken.
  //
  // There are now TWO guards in init() and this test is about the inner one.
  // The outer guard wraps mount acquisition and renders "could not read the
  // page"; the per-draw() catch renders "hit an error and stopped". The
  // messages are disjoint, so the assertion below names which net caught it —
  // a document that threw on querySelector would be caught by the other guard
  // and produce the other message, and this test would fail.
  const doc = makeFakeDocument({ cookie: 'rfc_v=abcdefghijklm' });

  // A real element standing behind Torn's own education-page selector, so
  // findMountPoint returns THIS node. Without it the panel is drawn into the
  // #tes-fallback-mount init() creates for itself — a different element, whose
  // appendChild does not throw, and the test would pass having exercised
  // nothing. Asserted below rather than assumed.
  const mount = doc.createElement('div');
  doc.selectors['[class*="educationPage___"]'] = mount;

  // `mount.appendChild(panel)` is the last statement in renderPanel, so the
  // throw lands inside draw()'s try after a complete, otherwise-successful
  // render — which is the realistic shape of the failure. It fails ONCE: the
  // catch re-renders through this same mount, and a permanently exploding
  // mount would take the safety net down with it and prove nothing about it.
  let appendCalls = 0;
  const realAppend = mount.appendChild.bind(mount);
  mount.appendChild = function (child) {
    appendCalls += 1;
    if (appendCalls === 1) throw new Error('mount exploded');
    return realAppend(child);
  };

  const { exports } = loadUserscript({
    location: { search: '' }, // keeps the bootstrap from auto-running init()
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });

  // Resolves rather than rejects: the whole point of the net.
  await exports.init();

  assert.strictEqual(appendCalls, 2, 'the catch did not re-render exactly once through the same mount');
  assert.strictEqual(
    doc.querySelector('#tes-fallback-mount'), null,
    'init() fell back to its own mount, so the exploding one was never the mount under test',
  );

  const panel = mount.children.find((c) => c.id === 'tes-panel');
  assert.ok(panel, 'nothing was drawn after the throw — this is the blank page the catch exists to prevent');

  const body = panel.children[1];
  const failure = body.children.find((c) => c.className === 'tes-error');
  assert.ok(failure, 'the re-render carried no visible failure line');
  assert.match(failure.textContent, /hit an error and stopped/, 'a different guard rendered this, not the per-draw catch');
  assert.match(failure.textContent, /mount exploded/, 'the underlying message was swallowed');

  // renderPanel suppresses the nav row on an identity match with noopHandlers,
  // and the catch is the only thing that hands it noopHandlers alongside live
  // course data. Buttons that render and do nothing read as the script being
  // broken twice over.
  assert.ok(
    !body.children.some((c) => c.className === 'tes-nav'),
    'the inert panel offered nav buttons nothing is listening to',
  );
});

// -----------------------------------------------------------------------
// The focus view (Task 7).
//
// The task brief for this section assumed `load`/`makeDocument`/`state`/
// `handlers` helpers already lived in this file, on the pattern
// tests/share.test.js's and tests/ordering.test.js's own `load()`. They did
// not exist here — this file's equivalent idioms are `okState`,
// `makeFakeDocument` and a locally-built handler object per test — so they
// are built fresh below rather than duplicated per test.
//
// The brief's own tests also assumed a browser-accurate `querySelectorAll`
// and `dispatchEvent`; tests/fake-document.js implements neither (its
// `querySelectorAll` always returns `[]`, and elements have no
// `dispatchEvent` at all — see the file's own header comment on what it
// deliberately does not model). Every test below is adapted to this file's
// real idioms: `descendants()`, `body.children.find(...)` and the `fire()`
// helper defined above.
// -----------------------------------------------------------------------

function load() {
  const { exports: x } = loadUserscript();
  return { x };
}

function makeDocument() { return makeFakeDocument(); }

// A full ok-state buildPanelModel() input built from the real fixture.
// `overrides.settings` is a partial settings object — normaliseSettings
// fills in whatever it omits, so a test only has to name what it cares
// about. `overrides.fetchFailed` swaps in a failure model instead.
// `overrides.queue` seeds plan.queue (default: empty), for tests that need
// buildPanelModel to actually order something rather than an empty list.
function state(overrides) {
  const o = overrides || {};
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  return {
    fetchResult: o.fetchFailed ? { ok: false, reason: 'network', detail: 'offline' } : { ok: true, data: data },
    plan: { queue: o.queue || [], collapsed: o.collapsed === true },
    now: NOW,
    view: o.view,
    settings: o.settings || {},
  };
}

// A full, real handler set — deliberately NOT noopHandlers, whose identity
// renderPanel tests for to suppress the whole .tes-nav row. These tests are
// about the nav row, so they need a handler set renderPanel treats as live.
function handlers() {
  return {
    onToggle() {}, onAdd() {}, onRemove() {}, onMove() {}, onAddAll() {},
    onAddPreset() {},
    onPickerChange() {}, onViewChange() {},
    onSettingChange() {}, onToggleDebugReport() {}, onCopyDebugReport() {},
    onImportPlan() {},
    onFocusToggle() {}, onFocusPriority() {}, onFocusSectionToggle() {}, onFocusCompletedToggle() {},
    onFocusRankToggle() {},
    onResetArm() {}, onResetConfirm() {},
  };
}

// Every descendant's own textContent, joined. The fake document does not
// implement a real browser's aggregating textContent, so a search across a
// whole rendered panel has to walk descendants and join them itself.
function allText(el) { return descendants(el).map((c) => c.textContent).join(' '); }

function focusSectionFor(panel, category) {
  return descendants(panel).find((c) => c.className === 'tes-focus-section'
    && c.children[0].children[1].textContent.startsWith(category));
}

function focusCountFor(panel, category) {
  return focusSectionFor(panel, category).children[0].children[2];
}

function completedGroupFor(section) {
  return section.children.find((c) => c.className === 'tes-focus-completed');
}

function focusNavButton(panel) {
  const nav = descendants(panel).find((c) => c.className === 'tes-nav');
  return nav ? nav.children.find((b) => /focus/i.test(b.textContent)) : undefined;
}

// Boots init() against the real fixture, seeding both storage keys before
// the first draw. Delegates to initWithFixture (defined above) rather than
// duplicating its setup, but takes its two arguments in plan-then-settings
// order and returns the raw gmStore Map as `gmStore` — what the guard test
// below needs, to re-read settings after a fallback-to-schedule fires.
async function bootInit(seedPlan, seedSettings) {
  const result = await initWithFixture(seedSettings, seedPlan);
  return { x: result.exports, doc: result.doc, gmStore: result.gmStore };
}

function freshRouteFixture() {
  const fixture = loadFixture();
  for (const category of fixture.categories) {
    for (const course of category.courses) course.status = 'available';
  }
  fixture.activeCourse = null;
  return fixture;
}

function courseInFixture(fixture, prefix) {
  for (const category of fixture.categories) {
    const found = category.courses.find((course) => course.prefix === prefix);
    if (found) return found;
  }
  return null;
}

function chooseGuidePreset(doc, x, key) {
  const body = doc.querySelector('#tes-panel').children[1];
  const picker = body.children.find((child) => child.tagName === 'select');
  const preset = x.GUIDE_PRESETS.find((candidate) => candidate.key === key);
  picker.value = preset.value;
  fire(picker, 'change');
  const add = body.children.find((child) => child.textContent === 'add');
  fire(add, 'click');
}

test('a guide preset stores its complete followable route including the foundation', async () => {
  const fixture = freshRouteFixture();
  const { exports: x, doc, gmStore } = await initWithFixture(undefined, undefined, fixture);
  chooseGuidePreset(doc, x, 'fighting');
  const stored = JSON.parse(gmStore.get(x.STORAGE_KEY)).queue;
  const data = x.parsePayload(fixture);
  const expected = x.expandGuidePreset('fighting', data.completedIds, data.courses, data.activeCourse, []);
  assert.strictEqual(expected.ok, true);
  assert.deepStrictEqual(stored, expected.courseIds);
  assert.strictEqual(stored.length, 12);
  assert.deepStrictEqual(x.validateQueue(stored, new Set(), data.courses), []);
});

test('Start Here then Fighting is duplicate-free, preserves the existing front, and changes no settings', async () => {
  const fixture = freshRouteFixture();
  const { exports: x, doc, gmStore } = await initWithFixture({
    orderMode: 'focus', focuses: [{ category: 'Working Stats', selection: 'intelligence' }],
  }, undefined, fixture);
  const settingsBefore = gmStore.get(x.SETTINGS_KEY);
  chooseGuidePreset(doc, x, 'foundation');
  const start = JSON.parse(gmStore.get(x.STORAGE_KEY)).queue;
  chooseGuidePreset(doc, x, 'fighting');
  const combined = JSON.parse(gmStore.get(x.STORAGE_KEY)).queue;
  const data = x.parsePayload(fixture);
  const direct = x.expandGuidePreset('fighting', data.completedIds, data.courses, null, []).courseIds;
  assert.deepStrictEqual(combined.slice(0, start.length), start);
  assert.deepStrictEqual(combined, direct);
  assert.strictEqual(new Set(combined).size, combined.length);
  assert.strictEqual(gmStore.get(x.SETTINGS_KEY), settingsBefore);

  const planBeforeNoop = gmStore.get(x.STORAGE_KEY);
  chooseGuidePreset(doc, x, 'fighting');
  assert.strictEqual(gmStore.get(x.STORAGE_KEY), planBeforeNoop, 'a represented preset rewrote the plan');
});

test('a preset sentinel survives picker state across redraws', async () => {
  const fixture = freshRouteFixture();
  const { exports: x, doc } = await initWithFixture(undefined, undefined, fixture);
  const pickerIn = () => doc.querySelector('#tes-panel').children[1].children.find((child) => child.tagName === 'select');
  const fighting = x.GUIDE_PRESETS.find((preset) => preset.key === 'fighting');
  const picker = pickerIn();
  picker.value = fighting.value;
  fire(picker, 'change');
  for (let i = 0; i < 2; i += 1) {
    const toggle = doc.querySelector('#tes-panel').children[0].children[1];
    fire(toggle, 'click');
  }
  assert.strictEqual(pickerIn().value, fighting.value);
});

test('a missing preset target adds nothing, names the failure, and clears after a valid add', async () => {
  const fixture = freshRouteFixture();
  const bio = courseInFixture(fixture, 'BIO1340');
  for (const category of fixture.categories) {
    category.courses = category.courses.filter((course) => course.prefix !== 'SPT3510');
  }
  const seed = { queue: [bio.id], collapsed: false };
  const { exports: x, doc, gmStore } = await initWithFixture(undefined, seed, fixture);
  const before = gmStore.get(x.STORAGE_KEY);
  chooseGuidePreset(doc, x, 'fighting');
  assert.strictEqual(gmStore.get(x.STORAGE_KEY), before, 'a partial route reached storage');
  let error = descendants(doc.querySelector('#tes-panel')).find((child) => child.className === 'tes-error');
  assert.ok(error);
  assert.match(error.textContent, /1-Fighting/);
  assert.match(error.textContent, /SPT3510/);

  chooseGuidePreset(doc, x, 'foundation');
  error = descendants(doc.querySelector('#tes-panel')).find((child) => child.className === 'tes-error');
  assert.strictEqual(error, undefined);
  const after = JSON.parse(gmStore.get(x.STORAGE_KEY)).queue;
  assert.strictEqual(after[0], bio.id);
  assert.strictEqual(new Set(after).size, after.length);
});

test('a preset save failure uses the existing visible save-error path', async () => {
  const fixture = freshRouteFixture();
  const { exports: x, doc, sandbox, gmStore } = await initWithFixture(undefined, undefined, fixture);
  sandbox.GM_setValue = () => { throw new Error('storage blocked'); };
  chooseGuidePreset(doc, x, 'foundation');
  assert.strictEqual(gmStore.get(x.STORAGE_KEY), undefined);
  const saveError = descendants(doc.querySelector('#tes-panel')).find((child) => child.className === 'tes-save-error');
  assert.ok(saveError);
});

test('the nav row offers the focus view and titles it', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state()), handlers());
  const nav = descendants(panel).find((c) => c.className === 'tes-nav');
  const labels = nav.children.map((b) => b.textContent);
  assert.ok(labels.some((l) => /focus/i.test(l)));
});

test('focus navigation is visible by default and absent outside focus ordering', () => {
  const { x } = load();
  const doc = makeDocument();
  const defaultPanel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ settings: x.freshSettings() })), handlers());
  assert.ok(focusNavButton(defaultPanel), 'the default settings shape must expose focus navigation');
  assert.notStrictEqual(focusNavButton(defaultPanel).disabled, true);

  const noFocusPanel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ settings: { orderMode: 'shortest-first' } })), handlers());
  assert.strictEqual(focusNavButton(noFocusPanel), undefined);
});

test('selecting focus in Queue order enables the button', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ settings: { orderMode: 'focus' } })), handlers());
  assert.ok(!focusNavButton(panel).disabled);
});

test('a programmatic focus route falls back to schedule outside focus ordering', async () => {
  const { doc } = await bootInit({ queue: [34] }, { orderMode: 'focus' });
  const panel = doc.querySelector('#tes-panel');
  const focus = focusNavButton(panel);
  assert.ok(focus, 'focus must exist before this programmatic-route check');

  const settings = panel.children[1].children.find((c) => c.className === 'tes-nav')
    .children.find((b) => /settings/i.test(b.textContent));
  fire(settings, 'click');
  const orderSelect = fieldFor(doc.querySelector('#tes-panel').children[1], 'Queue order');
  orderSelect.value = 'shortest-first';
  fire(orderSelect, 'change');

  // The detached button still invokes init()'s onViewChange('focus') handler,
  // which is the programmatic route that remains after focus disappears.
  fire(focus, 'click');
  const after = doc.querySelector('#tes-panel');
  assert.match(after.children[0].children[0].textContent, /^Education Scheduler/);
  assert.strictEqual(focusNavButton(after), undefined);
});

// The brief's version of this test looked up the Queue-order <select> AFTER
// navigating to the focus view — but that control lives on the settings
// view alone, so it can never be found there, in a real browser or this
// harness (querySelectorAll is a stub here regardless). Rewritten: capture
// the select from the settings view first, THEN navigate to focus (Queue
// order really is 'focus', so its nav entry really is enabled), and fire
// the now-detached select's own change listener. That listener closes over
// init()'s shared `view` variable rather than a per-render copy, so it
// still reads 'focus' at the moment it fires — the exact combination the
// guard exists for, and the only way to reach it without two panels open
// at once.
test('leaving focus mode while on the focus view returns to the schedule', async () => {
  const { x, doc, gmStore } = await bootInit(
    { queue: [34] },
    { orderMode: 'focus', focuses: [{ category: 'Working Stats', selection: 'intelligence' }] },
  );

  function navTo(pattern) {
    const nav = descendants(doc.querySelector('#tes-panel')).find((c) => c.className === 'tes-nav');
    const btn = nav.children.find((b) => pattern.test(b.textContent));
    assert.ok(btn, `no nav button matching ${pattern}`);
    fire(btn, 'click');
  }

  navTo(/settings/i);
  const orderSelect = fieldFor(doc.querySelector('#tes-panel').children[1], 'Queue order');
  assert.strictEqual(orderSelect.value, 'focus');

  navTo(/focus/i);
  assert.match(doc.querySelector('#tes-panel').children[0].children[0].textContent, /^Focus/, 'did not actually land on the focus view');

  orderSelect.value = 'shortest-first';
  fire(orderSelect, 'change');

  const title = doc.querySelector('#tes-panel').children[0].children[0].textContent;
  assert.ok(/^Education Scheduler/.test(title),
    'the player must not be stranded on a view whose nav entry is now disabled');
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.SETTINGS_KEY)).focuses.length, 1,
    'leaving focus mode says nothing about what the player is building toward');
});

test('focus categories stay named while collapsed and reveal selections only when opened', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({ view: 'focus' }));
  const doc = makeDocument();
  const closedSelection = model.focusGroups.find((group) => group.category !== 'Working Stats').selections[0].selection;
  let opened = [];
  const h = Object.assign({}, handlers(), {
    onFocusSectionToggle: (category) => { opened = [category]; },
  });
  let panel = x.renderPanel(doc, doc.body, model, h);
  let text = allText(panel);
  assert.ok(text.includes('Working Stats'));
  assert.ok(text.includes('Passive Stat Bonus'));
  assert.ok(!text.includes('intelligence'), 'collapsed sections must withhold their selections');

  fire(descendants(panel).find((c) => c.className === 'tes-focus-section-title'), 'click');
  model.focusOpenCategories = opened;
  panel = x.renderPanel(doc, doc.body, model, h);
  text = allText(panel);
  assert.ok(text.includes('intelligence'));
  assert.ok(!text.includes(closedSelection), 'opening one section must leave the others closed');
});

test('focus section headings are buttons with matching expanded state', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({ view: 'focus' }));
  const doc = makeDocument();
  let panel = x.renderPanel(doc, doc.body, model, handlers());
  let header = descendants(panel).find((c) => c.className === 'tes-focus-section-header');
  let heading = header.children[1];
  assert.strictEqual(heading.tagName, 'button');
  assert.strictEqual(heading['aria-expanded'], 'false');

  model.focusOpenCategories = ['Working Stats'];
  panel = x.renderPanel(doc, doc.body, model, handlers());
  header = descendants(panel).find((c) => c.className === 'tes-focus-section-header');
  heading = header.children[1];
  assert.strictEqual(heading['aria-expanded'], 'true');
});

test('completed unchosen selections render only behind a collapsed completed group', () => {
  const { x } = load();
  const category = 'Gym Gain Bonus';
  const model = x.buildPanelModel(state({ view: 'focus' }));
  const source = model.focusGroups.find((group) => group.category === category);
  const completedNames = source.selections.map((sel) => sel.selection);
  assert.ok(source.selections.every((sel) => sel.remainingLabel === 'complete' && sel.priority === null),
    'the all-completed fixture category changed');
  model.focusOpenCategories = [category];

  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const section = focusSectionFor(panel, category);
  const completed = completedGroupFor(section);
  assert.ok(completed, 'an all-completed category still needs its nested disclosure');
  assert.strictEqual(completed.children[0]['aria-expanded'], 'false');
  assert.strictEqual(completed.children.length, 1, 'closed groups must not build their rows');
  assert.strictEqual(section.children.filter((child) => child.className === 'tes-focus-row').length, 0,
    'an all-completed category must have no ungrouped rows');
  for (const name of completedNames) assert.ok(!allText(section).includes(name), `${name} leaked out while closed`);
});

test('opening one completed group reveals exactly its rows and resets on Focus re-entry', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [] }, { orderMode: 'focus' });
  const panelEl = () => doc.querySelector('#tes-panel');
  const navButton = (pattern) => descendants(panelEl()).find((c) => c.className === 'tes-nav')
    .children.find((button) => pattern.test(button.textContent));
  const storedPlan = gmStore.get(x.STORAGE_KEY);
  const storedSettings = gmStore.get(x.SETTINGS_KEY);

  fire(navButton(/focus/i), 'click');
  fire(descendants(panelEl()).find((c) => c.className === 'tes-focus-section-title'
    && c.textContent.startsWith('Unlocks & Abilities')), 'click');
  fire(descendants(panelEl()).find((c) => c.className === 'tes-focus-section-title'
    && c.textContent.startsWith('Combat Bonuses')), 'click');

  let unlocks = focusSectionFor(panelEl(), 'Unlocks & Abilities');
  let combat = focusSectionFor(panelEl(), 'Combat Bonuses');
  fire(completedGroupFor(unlocks).children[0], 'click');
  unlocks = focusSectionFor(panelEl(), 'Unlocks & Abilities');
  combat = focusSectionFor(panelEl(), 'Combat Bonuses');

  const expected = x.buildPanelModel(state({ view: 'focus' })).focusGroups
    .find((group) => group.category === 'Unlocks & Abilities').selections
    .filter((sel) => sel.remainingLabel === 'complete' && sel.priority === null)
    .map((sel) => sel.selection);
  const revealed = completedGroupFor(unlocks).children.slice(1).map((row) => row.children[1].textContent);
  assert.deepStrictEqual(revealed, expected);
  assert.strictEqual(completedGroupFor(unlocks).children[0]['aria-expanded'], 'true');
  assert.strictEqual(completedGroupFor(combat).children[0]['aria-expanded'], 'false');
  assert.strictEqual(completedGroupFor(combat).children.length, 1,
    'opening one category must leave another category\'s completed rows unbuilt');
  assert.strictEqual(gmStore.get(x.STORAGE_KEY), storedPlan);
  assert.strictEqual(gmStore.get(x.SETTINGS_KEY), storedSettings,
    'completed disclosure state must never be persisted');

  fire(navButton(/schedule/i), 'click');
  fire(navButton(/focus/i), 'click');
  fire(descendants(panelEl()).find((c) => c.className === 'tes-focus-section-title'
    && c.textContent.startsWith('Unlocks & Abilities')), 'click');
  unlocks = focusSectionFor(panelEl(), 'Unlocks & Abilities');
  assert.strictEqual(completedGroupFor(unlocks).children[0]['aria-expanded'], 'false',
    'completed disclosure state must reset whenever Focus is entered');
  assert.strictEqual(gmStore.get(x.STORAGE_KEY), storedPlan);
  assert.strictEqual(gmStore.get(x.SETTINGS_KEY), storedSettings);
});

test('a completed chosen selection stays in the main list and out of the completed group', () => {
  const { x } = load();
  const category = 'Unlocks & Abilities';
  const selection = 'Sports Shop Access';
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [{ category: category, selection: selection }] },
  }));
  model.focusOpenCategories = [category];
  model.focusOpenCompletedCategories = [category];
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const section = focusSectionFor(panel, category);
  const completed = completedGroupFor(section);
  const mainRow = section.children.find((child) => child.className === 'tes-focus-row'
    && child.children[1].textContent === selection);
  assert.ok(mainRow, 'the chosen completed row must stay immediately reachable');
  assert.strictEqual(mainRow.children[0].checked, true);
  assert.ok(!completed.children.slice(1).some((row) => row.children[1].textContent === selection));
  assert.strictEqual(completed.children[0].textContent, 'completed (2)');
});

test('a category with no completed selections renders no completed group', () => {
  const { x } = load();
  const category = 'Working Stats';
  const model = x.buildPanelModel(state({ view: 'focus' }));
  model.focusOpenCategories = [category];
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  assert.strictEqual(completedGroupFor(focusSectionFor(panel, category)), undefined);
});

test('the completed heading is a count-labelled button with matching expanded state', () => {
  const { x } = load();
  const category = 'Unlocks & Abilities';
  const model = x.buildPanelModel(state({ view: 'focus' }));
  model.focusOpenCategories = [category];
  const doc = makeDocument();

  let panel = x.renderPanel(doc, doc.body, model, handlers());
  let heading = completedGroupFor(focusSectionFor(panel, category)).children[0];
  assert.strictEqual(heading.tagName, 'button');
  assert.strictEqual(heading.textContent, 'completed (3)');
  assert.strictEqual(heading['aria-expanded'], 'false');

  model.focusOpenCompletedCategories = [category];
  panel = x.renderPanel(doc, doc.body, model, handlers());
  heading = completedGroupFor(focusSectionFor(panel, category)).children[0];
  assert.strictEqual(heading.tagName, 'button');
  assert.strictEqual(heading.textContent, 'completed (3)');
  assert.strictEqual(heading['aria-expanded'], 'true');
});

test('completed-group rows keep their checkbox name remaining figure and disabled state', () => {
  const { x } = load();
  const category = 'Unlocks & Abilities';
  const model = x.buildPanelModel(state({ view: 'focus' }));
  model.focusOpenCategories = [category];
  model.focusOpenCompletedCategories = [category];
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const rows = completedGroupFor(focusSectionFor(panel, category)).children.slice(1);
  assert.strictEqual(rows.length, 3);
  for (const row of rows) {
    assert.strictEqual(row.className, 'tes-focus-row');
    assert.strictEqual(row.children.length, 3);
    assert.strictEqual(row.children[0].type, 'checkbox');
    assert.ok(row.children[1].textContent);
    assert.strictEqual(row.children[2].textContent, 'complete');
    assert.strictEqual(row.children[0].disabled, true);
    assert.strictEqual(row['data-disabled'], 'true');
  }
});

test('the header priority slot precedes its toggle and count while rows keep three tracks', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [
      { category: 'Working Stats', selection: 'intelligence' },
      { category: 'Passive Stat Bonus', selection: 'Speed' },
    ] },
  }));
  model.focusOpenCategories = model.focusGroups.map((group) => group.category);
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const rows = descendants(panel).filter((c) => c.className === 'tes-focus-row');
  const headers = descendants(panel).filter((c) => c.className === 'tes-focus-section-header');
  assert.ok(headers.every((header) => header.children.length === 3));
  assert.ok(headers.every((header) => header.children[0].className === 'tes-focus-priority-slot'));
  assert.ok(headers.every((header) => header.children[1].className === 'tes-focus-section-title'));
  assert.ok(headers.every((header) => header.children[2].className === 'tes-focus-section-count'));
  assert.ok(rows.every((row) => row.children.length === 3));
  assert.ok(rows.every((row) => row.children[0].type === 'checkbox'));
  assert.ok(rows.every((row) => !descendants(row).some((c) => c.className === 'tes-focus-priority-slot')));
  assert.match(x.panelStyleText(), /\.tes-focus-section-header\s*\{[^}]*grid-template-columns:\s*2\.5em 1fr auto/);
  assert.match(x.panelStyleText(), /\.tes-focus-section-count\s*\{[^}]*justify-self:\s*end/);
  assert.match(x.panelStyleText(), /\.tes-focus-row\s*\{[^}]*grid-template-columns:\s*1\.5em 1fr auto/);
});

test('a mixed fixture category shows independently counted remaining and total selections', () => {
  const { x } = load();
  const fixtureSelections = [
    { selection: 'Medical Item Effectiveness', complete: false },
    { selection: 'Needle Effectiveness', complete: true },
  ];
  const expectedRemaining = fixtureSelections.filter((selection) => !selection.complete).length;
  const expectedTotal = fixtureSelections.length;
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ view: 'focus' })), handlers());
  assert.strictEqual(
    focusCountFor(panel, 'Medical Effectiveness').textContent,
    `${expectedRemaining} rem /${expectedTotal} total`,
  );
});

test('the focus count renders while its section is collapsed', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ view: 'focus' })), handlers());
  const section = focusSectionFor(panel, 'Combat Bonuses');
  assert.strictEqual(section.children[0].children[1]['aria-expanded'], 'false');
  assert.strictEqual(section.children.length, 1, 'collapsed sections must contain only their header');
  assert.strictEqual(focusCountFor(panel, 'Combat Bonuses').textContent, '16 rem /17 total');
});

test('a completed chosen selection still counts as complete in its header total', () => {
  const { x } = load();
  const category = 'Unlocks & Abilities';
  const doc = makeDocument();
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [{ category: category, selection: 'Sports Shop Access' }] },
  }));
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const header = focusSectionFor(panel, category).children[0];
  assert.strictEqual(header.children[0].children[0].className, 'tes-focus-priority');
  assert.strictEqual(header.children[2].textContent, '32 rem /35 total');
});

test('a category with nothing complete shows its total as remaining', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ view: 'focus' })), handlers());
  assert.strictEqual(focusCountFor(panel, 'Working Stats').textContent, '3 rem /3 total');
});

test('an all-complete category shows zero remaining', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ view: 'focus' })), handlers());
  assert.strictEqual(focusCountFor(panel, 'Gym Gain Bonus').textContent, '0 rem /4 total');
});

test('the focus count label keeps one space before the slash and none after it', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ view: 'focus' })), handlers());
  const label = focusCountFor(panel, 'Medical Effectiveness').textContent;
  assert.strictEqual(label, '1 rem /2 total');
  assert.match(label, /^\d+ rem \/\d+ total$/);
});

test('an unchosen focus section renders an empty header priority slot', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body,
    x.buildPanelModel(state({ view: 'focus' })), handlers());
  const header = descendants(panel).find((c) => c.className === 'tes-focus-section-header');
  const slot = header.children[0];
  assert.strictEqual(slot.className, 'tes-focus-priority-slot');
  assert.strictEqual(slot.children.length, 0);
  assert.strictEqual(descendants(slot).some((c) => c.className === 'tes-focus-priority'), false);
});

test('a chosen focus section renders its priority and selection name in the header', () => {
  const { x } = load();
  const doc = makeDocument();
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [{ category: 'Working Stats', selection: 'manual labor' }] },
  }));
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const heading = descendants(panel).find((c) => c.className === 'tes-focus-section-title'
    && c.textContent.includes('Working Stats'));
  const header = descendants(panel).find((c) => c.className === 'tes-focus-section-header'
    && c.children[1] === heading);
  assert.strictEqual(heading.textContent, 'Working Stats — manual labor');
  assert.strictEqual(header.children[0].children[0].className, 'tes-focus-priority');
});

test('the header priority input is a sibling of the toggle, never its descendant', () => {
  const { x } = load();
  const doc = makeDocument();
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [{ category: 'Working Stats', selection: 'intelligence' }] },
  }));
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const input = descendants(panel).find((c) => c.className === 'tes-focus-priority');
  const header = descendants(panel).find((c) => c.className === 'tes-focus-section-header'
    && descendants(c.children[0]).includes(input));
  const heading = header.children[1];
  assert.strictEqual(descendants(heading).includes(input), false);
  assert.strictEqual(header.children[0].children[0], input);
});

test('changing a header priority commits its category chosen selection and value', () => {
  const { x } = load();
  const doc = makeDocument();
  const calls = [];
  const h = Object.assign({}, handlers(), {
    onFocusPriority: (category, selection, value) => calls.push([category, selection, value]),
  });
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [{ category: 'Working Stats', selection: 'manual labor' }] },
  }));
  const panel = x.renderPanel(doc, doc.body, model, h);
  const heading = descendants(panel).find((c) => c.className === 'tes-focus-section-title'
    && c.textContent.includes('Working Stats'));
  assert.strictEqual(heading['aria-expanded'], 'false');
  const input = descendants(panel).find((c) => c.className === 'tes-focus-priority');
  input.value = '3';
  fire(input, 'change');
  assert.deepStrictEqual(calls, [['Working Stats', 'manual labor', 3]]);
});

test('every focus section renders exactly one priority slot, chosen or not', () => {
  const { x } = load();
  const doc = makeDocument();
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [{ category: 'Working Stats', selection: 'intelligence' }] },
  }));
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const sections = descendants(panel).filter((c) => c.className === 'tes-focus-section');
  assert.strictEqual(sections.length, model.focusGroups.length);
  for (const section of sections) {
    const slots = descendants(section).filter((c) => c.className === 'tes-focus-priority-slot');
    assert.strictEqual(slots.length, 1);
  }
});

test('a selection shows what is left, and unlocks show a count not a percentage', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({ view: 'focus' }));
  const unlock = model.focusGroups.find((g) => g.category === 'Unlocks & Abilities');
  assert.ok(unlock.selections.every((s) => s.unit === 'count'));
  assert.ok(unlock.selections.every((s) => !/%/.test(s.remainingLabel)));
});

test('the focus view says ordering does not change the finish date', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: 'focus' })), handlers());
  assert.ok(/finish date/i.test(allText(panel)),
    'the one thing this control must not be left to imply');
  assert.match(allText(panel), /Most per day banks the stat fastest in real time/);
  assert.match(allText(panel), /biggest total finishes the largest single courses first/);
});

test('the Focus rank button states both bases and commits through the real handler', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [] }, {
    orderMode: 'focus', focusRankBasis: 'per-day',
  });
  const panelEl = () => doc.querySelector('#tes-panel');
  const nav = descendants(panelEl()).find((c) => c.className === 'tes-nav');
  fire(nav.children.find((button) => /focus/i.test(button.textContent)), 'click');

  let body = panelEl().children[1];
  let overview = descendants(body).find((child) => hasClass(child, 'tes-focus-overview'));
  let button = overview.children.find((child) => child.className === 'tes-focus-rank-toggle');
  let buttonAt = overview.children.indexOf(button);
  assert.strictEqual(button.className, 'tes-focus-rank-toggle');
  assert.strictEqual(button.textContent, 'sorting: most per day');
  assert.strictEqual(overview.children[buttonAt + 1].className, 'tes-note', 'the rank button must precede the notes');

  fire(button, 'click');
  assert.strictEqual(JSON.parse(gmStore.get(x.SETTINGS_KEY)).focusRankBasis, 'total');
  body = panelEl().children[1];
  overview = descendants(body).find((child) => hasClass(child, 'tes-focus-overview'));
  button = overview.children.find((child) => child.className === 'tes-focus-rank-toggle');
  assert.strictEqual(button.textContent, 'sorting: biggest total');

  fire(button, 'click');
  assert.strictEqual(JSON.parse(gmStore.get(x.SETTINGS_KEY)).focusRankBasis, 'per-day');
  assert.strictEqual(descendants(panelEl()).find((c) => c.className === 'tes-focus-rank-toggle').textContent,
    'sorting: most per day');
});

function renderedFocusRow(x, settings, category, selection) {
  const model = x.buildPanelModel(state({ view: 'focus', settings: settings }));
  model.focusOpenCategories = [category];
  model.focusOpenCompletedCategories = [category];
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  return descendants(panel).find((row) => row.className === 'tes-focus-row'
    && row.children[1].textContent === selection);
}

test('a completed unchosen focus is disabled, titled, and muted', () => {
  const { x } = load();
  const row = renderedFocusRow(x, { orderMode: 'focus' },
    'Unlocks & Abilities', 'Sports Shop Access');
  assert.ok(row, 'the real completed fixture selection did not render');
  assert.strictEqual(row.children[2].textContent, 'complete');
  assert.strictEqual(row.children[0].disabled, true);
  assert.match(row.title, /already complete/i);
  assert.strictEqual(row['data-disabled'], 'true');
  assert.match(x.panelStyleText(), /\.tes-focus-row\[data-disabled="true"\]\s*\{\s*color:\s*var\(--tm-muted\)/);
});

test('a completed chosen focus stays enabled so it can be unticked', () => {
  const { x } = load();
  const row = renderedFocusRow(x, {
    orderMode: 'focus',
    focuses: [{ category: 'Unlocks & Abilities', selection: 'Sports Shop Access' }],
  }, 'Unlocks & Abilities', 'Sports Shop Access');
  assert.strictEqual(row.children[2].textContent, 'complete');
  assert.strictEqual(row.children[0].checked, true);
  assert.notStrictEqual(row.children[0].disabled, true);
  assert.strictEqual(row['data-disabled'], undefined);
  assert.ok((row.children[0].listeners.change || []).length > 0, 'the chosen checkbox cannot be unticked');
});

test('an incomplete focus remains enabled and selectable', () => {
  const { x } = load();
  const row = renderedFocusRow(x, { orderMode: 'focus' }, 'Working Stats', 'manual labor');
  assert.notStrictEqual(row.children[2].textContent, 'complete');
  assert.notStrictEqual(row.children[0].disabled, true);
  assert.strictEqual(row['data-disabled'], undefined);
  assert.ok((row.children[0].listeners.change || []).length > 0, 'the incomplete checkbox lost its handler');
});

test('an unchosen selection shows no number at all', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({ view: 'focus' }));
  const chosen = new Set(model.focuses.map((f) => `${f.category} ${f.selection}`));
  for (const group of model.focusGroups) {
    for (const s of group.selections) {
      if (!chosen.has(`${group.category} ${s.selection}`)) {
        assert.strictEqual(s.priority, null,
          'a number nobody set reads as a number somebody set');
      }
    }
  }
});

test('chosen focuses are numbered 1..n with no gaps and no repeats', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [
      { category: 'Working Stats', selection: 'intelligence' },
      { category: 'Passive Stat Bonus', selection: 'Speed' },
    ] },
  }));
  const nums = [];
  for (const group of model.focusGroups) {
    for (const s of group.selections) if (s.priority !== null) nums.push(s.priority);
  }
  assert.deepStrictEqual(nums.slice().sort((a, b) => a - b), [1, 2]);
});

test('the priority control remains reachable while its section is collapsed', () => {
  const { x } = load();
  const doc = makeDocument();
  const calls = [];
  const h = Object.assign({}, handlers(), {
    onFocusPriority: (c, s, p) => calls.push([c, s, p]),
  });
  const model = x.buildPanelModel(state({
    view: 'focus',
    settings: { focuses: [{ category: 'Working Stats', selection: 'intelligence' }] },
  }));
  const panel = x.renderPanel(doc, doc.body, model, h);
  const input = descendants(panel).find((c) => c.className === 'tes-focus-priority');
  assert.ok(input, 'a chosen focus must offer a way to change its number');
  const heading = descendants(panel).find((c) => c.className === 'tes-focus-section-title'
    && c.textContent.includes('Working Stats'));
  assert.strictEqual(heading['aria-expanded'], 'false');
  input.value = '1';
  fire(input, 'change');
  assert.strictEqual(calls.length, 1);
});

test('a stale or unmapped count is shown rather than hidden', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({ view: 'focus' }));
  assert.strictEqual(typeof model.focusHealth.stale, 'number');
  assert.strictEqual(typeof model.focusHealth.unmapped, 'number');
});

test('the focus view renders without a payload and withholds totals', () => {
  const { x } = load();
  const doc = makeDocument();
  const model = x.buildPanelModel(state({ view: 'focus', fetchFailed: true }));
  assert.doesNotThrow(() => x.renderPanel(doc, doc.body, model, handlers()));
  assert.strictEqual(model.focusGroups, null);
});

// Task 7b: orderQueue gained a focus mode and a scoreMaps argument in Task 6,
// and Task 7 built the settings UI that lets a player choose focuses — but
// nothing ever computed scoreMaps and handed it to the buildPanelModel call
// site. Selecting "My focus first" reordered nothing; it silently behaved
// like as-listed. Task 6's and ordering.test.js's own focus tests call
// orderQueue directly and so never exercised the gap — this is the first
// test that goes through buildPanelModel itself, the only place the wiring
// could have been dropped.
test('the rendered queue actually reorders under focus mode', () => {
  const { x } = load();
  const data = x.parsePayload(loadFixture());
  // The same 20-course slice ordering.test.js's own focus tests use: enough
  // courses, with intelligence gains that differ widely enough across the
  // catalogue, to guarantee as-listed and focus disagree (confirmed by hand
  // against this fixture, not merely hoped for).
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse).slice(0, 20);
  const focusSettings = { orderMode: 'focus', focuses: [{ category: 'Working Stats', selection: 'intelligence' }] };

  const asListed = x.buildPanelModel(state({ queue: queue, settings: { orderMode: 'as-listed' } }));
  const focused = x.buildPanelModel(state({ queue: queue, settings: focusSettings }));

  const asListedIds = asListed.queue.map((i) => i.courseId);
  const focusedIds = focused.queue.map((i) => i.courseId);

  // Guard against vacuity in both directions: the two orders must actually
  // differ (proving the scores reached orderQueue), and must contain exactly
  // the same course ids (proving the reorder is a reorder, not a dropped or
  // invented course — the failure mode a careless fix could introduce).
  assert.notDeepStrictEqual(focusedIds, asListedIds, 'focus mode did not reorder the rendered queue');
  assert.deepStrictEqual(
    new Set(focusedIds), new Set(asListedIds),
    'focus mode changed which courses are in the queue'
  );
});

test('reordering the rendered queue by focus does not move the finish date', () => {
  const { x } = load();
  const data = x.parsePayload(loadFixture());
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse).slice(0, 20);
  const focusSettings = { orderMode: 'focus', focuses: [{ category: 'Working Stats', selection: 'intelligence' }] };

  const asListed = x.buildPanelModel(state({ queue: queue, settings: { orderMode: 'as-listed' } }));
  const focused = x.buildPanelModel(state({ queue: queue, settings: focusSettings }));

  assert.strictEqual(focused.finishLabel, asListed.finishLabel);
  assert.strictEqual(focused.totalLabel, asListed.totalLabel);
});

// -----------------------------------------------------------------------
// Task 3: the header splits into a title and a real toggle button.
//
// The task brief's own tests called `panel.querySelectorAll(...)` and
// `dispatchEvent`. tests/fake-document.js implements neither on an element
// created via `doc.createElement` (only `doc` itself has a
// `querySelectorAll`, and it always returns `[]`; elements have no
// `dispatchEvent` at all). Adapted to this file's real idioms: reading
// `header.children[0]`/`children[1]` directly (renderPanel appends the
// title before the toggle) and firing the registered listener with `fire()`.
// -----------------------------------------------------------------------

test('the header carries a title and a real button', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state()), handlers());
  const header = panel.children[0];
  const title = header.children[0];
  const btn = header.children[1];
  assert.strictEqual(title.className, 'tes-header-title');
  assert.ok(btn, 'hide must be a button, not text');
  assert.strictEqual(btn.className, 'tes-header-toggle');
  // tests/fake-document.js stores the tag exactly as passed to createElement
  // rather than uppercasing it the way a real browser's tagName does.
  assert.strictEqual(btn.tagName, 'button');
});

test('only the toggle button collapses the panel', () => {
  const { x } = load();
  const doc = makeDocument();
  let toggled = 0;
  const h = Object.assign({}, handlers(), { onToggle: () => { toggled += 1; } });
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state()), h);
  const header = panel.children[0];
  const title = header.children[0];
  const toggle = header.children[1];
  assert.ok(!title.listeners.click, 'the title is no longer the click target');
  fire(toggle, 'click');
  assert.strictEqual(toggled, 1);
});

test('the toggle reads show when collapsed', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ collapsed: true })), handlers());
  assert.strictEqual(panel.children[0].children[1].textContent, 'show');
});

// -----------------------------------------------------------------------
// Task 5: course bonuses in queue rows.
//
// The task brief's own tests called `panel.querySelectorAll('.tes-queue-row')`
// and, in the markup-injection test, `el.childNodes.some(...)`. Neither
// exists on the fake DOM (tests/fake-document.js's `querySelectorAll` always
// returns `[]`, and created elements have `children`, never `childNodes`) —
// adapted to `descendants()` and `.children` below.
//
// The brief's markup-injection test also assigned `x.bonusLabel(evil)` to a
// bare element's `textContent` inside the test itself, then checked
// `children` for a tag. That proves textContent-the-property never parses
// HTML, which is true of every DOM (fake or real) regardless of what the
// *renderer* does with the string — it would pass identically if the
// renderer used `.innerHTML =` instead, because this fake DOM has no
// `innerHTML` implementation to diverge on. Kept below as a cheap sanity
// check on bonusLabel's own output, plus a second test that exercises the
// real render path with an `innerHTML` trap on every created element, so a
// renderer that actually switched to `.innerHTML` would throw instead of
// silently passing.
// -----------------------------------------------------------------------

test('a queue row is a compact two-line entry with identity before metadata', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ queue: [38] })), handlers());
  const row = descendants(panel).find((c) => c.className === 'tes-queue-row');
  assert.ok(row, 'queue rows get their own class, not the shared .tes-row');
  const main = row.children.find((c) => c.className === 'tes-queue-main');
  const detail = row.children.find((c) => c.className === 'tes-queue-detail');
  assert.ok(main, 'course identity line missing');
  assert.ok(detail, 'duration/date/bonus line missing');
  assert.match(main.textContent, /^[A-Z0-9]+ · /, 'the identity line does not lead with the course prefix');
  assert.doesNotMatch(main.textContent, /\bfin\b|days|hrs|wks/, 'timing leaked onto the identity line');
  assert.match(detail.textContent, / · fin .* · /, 'metadata does not use the chosen middle-dot sequence');
  const remove = row.children.find((c) => c.className === 'tes-remove-course');
  assert.ok(remove, 'remove button missing from the row');
  assert.strictEqual(remove.dataset.courseId, '38', 'the remove action lost its course id');
});

test('queue rows start with two touching ghost-chevron buttons and expose their move state', () => {
  const { x } = load();
  const doc = makeDocument();
  const model = x.buildPanelModel(state({ queue: [22, 26, 38], settings: { orderMode: 'as-listed' } }));
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const rows = descendants(panel).filter((c) => c.className === 'tes-queue-row');
  const firstControl = rows[0].children[0];
  assert.strictEqual(firstControl.className, 'tes-reorder', 'the reorder control is not first in the row');
  assert.strictEqual(firstControl.children.length, 2);
  assert.strictEqual(firstControl.children[0].className, 'tes-move tes-move-up');
  assert.strictEqual(firstControl.children[1].className, 'tes-move tes-move-down');
  assert.strictEqual(firstControl.children[0].disabled, true, 'the first course can move above the queue boundary');
  assert.strictEqual(firstControl.children[1].disabled, true, 'a prerequisite can move below its dependent');
  assert.match(firstControl.children[0].title, /already first/i);
  assert.match(firstControl.children[1].title, /prerequisite/i);
  assert.strictEqual(firstControl.children[0].children[0].className, 'tes-chevron tes-chevron-up');
  assert.strictEqual(firstControl.children[1].children[0].className, 'tes-chevron tes-chevron-down');

  const independentControl = rows[2].children[0];
  assert.notStrictEqual(independentControl.children[0].disabled, true,
    'an unrelated course cannot move across its neighbour');
});

test('the panel model precomputes prerequisite-safe adjacent move permissions', () => {
  const { x } = load();
  const model = x.buildPanelModel(state({ queue: [22, 26, 32, 38], settings: { orderMode: 'as-listed' } }));
  const byId = new Map(model.queue.map((item) => [item.courseId, item]));
  assert.strictEqual(byId.get(22).canMoveUp, false);
  assert.strictEqual(byId.get(22).canMoveDown, false);
  assert.strictEqual(byId.get(26).canMoveUp, false);
  assert.strictEqual(byId.get(26).canMoveDown, false);
  assert.strictEqual(byId.get(32).canMoveUp, false);
  assert.strictEqual(byId.get(32).canMoveDown, true, 'an independent following course should be crossable');
  assert.strictEqual(byId.get(38).canMoveUp, true);
  assert.strictEqual(byId.get(38).canMoveDown, false);
});

test('a queue row preserves hostile-length Torn text in full', () => {
  const { x } = load();
  const data = x.parsePayload(loadFixture());
  const course = data.courses.get(38);
  const longName = `Course ${'UnbrokenName'.repeat(40)}`;
  const longBonus = `Bonus ${'UnbrokenBonus'.repeat(40)}`;
  course.name = longName;
  course.learningOutcomes = [longBonus];
  course.workingStatsGain = [];
  const doc = makeDocument();
  const model = x.buildPanelModel({
    fetchResult: { ok: true, data },
    plan: { queue: [38], collapsed: false },
    settings: {},
    view: 'schedule',
    now: NOW,
  });
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const row = descendants(panel).find((c) => c.className === 'tes-queue-row');
  assert.ok(row.children.find((c) => c.className === 'tes-queue-main').textContent.includes(longName));
  assert.ok(row.children.find((c) => c.className === 'tes-queue-detail').textContent.includes(longBonus));
});

test('a course with working stats names them', () => {
  const { x } = load();
  const data = x.parsePayload(loadFixture());
  const c = [...data.courses.values()].find((k) => x.workingStatsFor(k).size > 0);
  assert.ok(c, 'fixture must contain a course with working stats');
  assert.match(x.bonusLabel(c), /intelligence|endurance|manual labor/);
});

test('a course with no learningOutcomes says so honestly', () => {
  const { x } = load();
  const data = x.parsePayload(loadFixture());
  const bare = [...data.courses.values()].find((k) => !k.learningOutcomes || !k.learningOutcomes.length);
  assert.ok(bare, 'fixture must contain a course with no learningOutcomes (31 of 131 in the real catalogue)');
  const label = x.bonusLabel(bare);
  assert.match(label, /not listed by Torn/, 'never infer a bonus from a course name');
});

test('a course with neither working stats nor outcomes gets the fully honest label', () => {
  const { x } = load();
  const bare = { id: 1, prefix: 'X', name: 'n', learningOutcomes: [], workingStatsGain: [] };
  assert.strictEqual(x.bonusLabel(bare), 'Bonus: not listed by Torn');
});

test('working stats without outcomes are marked as a partial bonus', () => {
  const { x } = load();
  const partial = { id: 1, prefix: 'X', name: 'n', learningOutcomes: [], workingStatsGain: ['Gain 5 intelligence upon completion'] };
  assert.strictEqual(x.bonusLabel(partial), '5 intelligence · other bonus not listed by Torn');
});

test('bonus text assigned via textContent never parses into child nodes', () => {
  const { x } = load();
  const doc = makeDocument();
  const evil = { id: 1, prefix: 'X', name: 'n', learningOutcomes: ['<img src=x onerror=alert(1)>'], workingStatsGain: [] };
  const el = doc.createElement('div');
  el.textContent = x.bonusLabel(evil);
  assert.strictEqual(el.textContent, '<img src=x onerror=alert(1)>');
  assert.strictEqual(el.children.length, 0);
});

test('the rendered queue bonus line never reaches innerHTML, even with markup in the payload', () => {
  const { x } = load();
  const doc = makeDocument();
  const data = x.parsePayload(loadFixture());
  const course = data.courses.get(38);
  course.learningOutcomes = ['<img src=x onerror=alert(1)>'];
  course.workingStatsGain = [];

  // Trap innerHTML on every element the renderer creates. The fake DOM does
  // not implement innerHTML at all, so a renderer that switched to it would
  // otherwise set an unobserved plain property and this test would pass for
  // the wrong reason — the same "silently pass against nothing" trap the
  // brief's own querySelectorAll-based test would have fallen into.
  const originalCreateElement = doc.createElement;
  doc.createElement = function (tag) {
    const el = originalCreateElement(tag);
    Object.defineProperty(el, 'innerHTML', {
      set() { throw new Error('bonus text must be set via textContent, not innerHTML'); },
    });
    return el;
  };

  const model = x.buildPanelModel({
    fetchResult: { ok: true, data: data },
    plan: { queue: [38], collapsed: false },
    now: NOW,
  });
  const panel = x.renderPanel(doc, doc.body, model, handlers());
  const row = descendants(panel).find((c) => c.className === 'tes-queue-row');
  const detail = row.children.find((c) => c.className === 'tes-queue-detail');
  assert.ok(detail.textContent.endsWith(' · <img src=x onerror=alert(1)>'));
  assert.strictEqual(detail.children.length, 0, 'the evil string must never become a child node');
});

// The all-courses box used to be the last cell in the degrees grid. Task 6
// lifts it out into its own full-width banner, rendered before the grid —
// tested here through the grid view rather than only on buildDegreeGrid's
// output, because the failure mode this guards against is exactly "the
// model field moved but the renderer still draws the old cell".
//
// The brief's own version of this test reached for
// `panel.querySelectorAll('.tes-all-banner')[0]` and read `.textContent` off
// the result. tests/fake-document.js's `querySelectorAll` always returns
// `[]` (see the file's header comment), so that call would silently find
// nothing and the test would pass for the wrong reason. Adapted to this
// file's real idiom instead: `descendants()` over the rendered panel.
test('the all-remaining banner renders before the degree list, titled all remaining courses', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: 'grid' })), handlers());
  const banner = descendants(panel).find((c) => c.className === 'tes-all-banner');
  assert.ok(banner, 'no .tes-all-banner rendered');
  // allText, not banner.textContent: the fake document does not aggregate
  // children's textContent onto the parent the way a real browser does.
  assert.match(allText(banner), /all remaining courses/);
  assert.strictEqual(descendants(panel).filter((c) => c.className === 'tes-cell-all').length, 0);

  // panel.children[1] is the body renderGridView appends into (same
  // structure other tests in this file rely on) — the banner must be a
  // direct child appearing before .tes-degree-list, not merely present somewhere.
  const body = panel.children[1];
  const bannerIndex = body.children.indexOf(banner);
  const listIndex = body.children.findIndex((c) => c.className === 'tes-degree-list');
  assert.ok(bannerIndex !== -1 && listIndex !== -1, 'banner or degree list missing from the body');
  assert.ok(bannerIndex < listIndex, 'the banner does not come before the degree list');
});

// Task 7: the schedule summary used to be one text node built by
// lines.join('\n') with white-space: pre-line, so a visible separator could
// not attach to just the total without also breaking the assumptions above
// it. Split into three real elements instead.
//
// The brief's own version of these tests reached for
// `panel.querySelectorAll('.tes-summary-inputs')[0]` and `.textContent`
// straight off the panel. tests/fake-document.js's `querySelectorAll` always
// returns `[]` and does not aggregate children's textContent onto a parent,
// so both calls would silently find nothing. Adapted to this file's real
// idioms: `descendants()` and `allText()`.
//
// The brief also queued course 34 (BIO1340) as its "clean" example, but
// against this fixture 34 is already completed — queueing it produces a
// stale entry ("already completed"), which is itself something to diagnose.
// 38 is used instead: a genuinely clean single-course queue, the same one
// the ordering test above already relies on for a real finish date with no
// stale entries and no problems.
test('the summary is three real sections, not one text node', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ queue: [38] })), handlers());
  assert.ok(descendants(panel).find((c) => c.className === 'tes-summary-inputs'), 'no .tes-summary-inputs rendered');
  assert.ok(descendants(panel).find((c) => c.className === 'tes-summary-result'), 'no .tes-summary-result rendered');
});

test('the schedule overview groups every pre-course figure in one differentiated surface', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ queue: [38] })), handlers());
  const body = panel.children[1];
  const overview = body.children.find((c) => hasClass(c, 'tes-schedule-overview'));
  const firstQueue = body.children.findIndex((c) => c.className === 'tes-queue-row');
  assert.ok(overview && hasClass(overview, 'tes-overview'), 'the pre-course content has no shared overview surface');
  assert.ok(descendants(overview).find((c) => c.className === 'tes-finish'), 'finish figure escaped the overview');
  assert.ok(descendants(overview).find((c) => c.className === 'tes-boosters'), 'booster scenarios escaped the overview');
  assert.ok(descendants(overview).find((c) => hasClass(c, 'tes-summary-queue')), 'queue assumptions escaped the overview');
  assert.ok(body.children.indexOf(overview) < firstQueue, 'the overview does not precede the course rows');
});

test('the Focus controls and guidance share one differentiated intro surface', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: 'focus' })), handlers());
  const overview = descendants(panel).find((c) => hasClass(c, 'tes-focus-overview'));
  assert.ok(overview && hasClass(overview, 'tes-overview'), 'Focus has no overview surface');
  assert.ok(descendants(overview).find((c) => c.className === 'tes-focus-rank-toggle'));
  assert.ok(descendants(overview).filter((c) => hasClass(c, 'tes-note')).length >= 2,
    'the two Focus guidance paragraphs are not grouped with their control');
});

// The overview outline now separates assumptions from courses. Keeping the
// older summary divider inside that outline would double the boundary directly
// after Total queued time.
test('the wrapped schedule summary has no redundant separator line', () => {
  const { x } = load();
  const css = x.panelStyleText();

  assert.ok(
    !/\.tes-summary-(?:queue|result)[^{]*\{[^}]*border(?:-bottom)?:/.test(css),
    'the overview outline already separates the summary from course rows'
  );

  // Keep the semantic class on exactly the real queue summary even though it
  // no longer paints a line; tests and future layout rules can still identify
  // the assumptions block without relying on position.
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ queue: [38] })), handlers());
  const summaries = descendants(panel).filter((c) => hasClass(c, 'tes-summary-queue'));
  assert.strictEqual(summaries.length, 1, 'exactly one block is the queue summary');
  assert.ok(
    descendants(summaries[0]).some((c) => c.className === 'tes-summary-inputs'),
    'the semantic class belongs to the queue assumptions block'
  );
});

test('diagnostics appear only when there is something to diagnose', () => {
  const { x } = load();
  const doc = makeDocument();
  const clean = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ queue: [38] })), handlers());
  assert.strictEqual(
    descendants(clean).filter((c) => c.className === 'tes-summary-diagnostics').length,
    0,
    'a clean queue must not render a diagnostics block'
  );
});

test('every existing summary message survives the restructure', () => {
  const { x } = load();
  const doc = makeDocument();
  const empty = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ queue: [] })), handlers());
  assert.match(allText(empty), /Queue is empty/);
  assert.match(allText(empty), /Perk reduction/);
});

// -----------------------------------------------------------------------
// resetButton (v0.3.0 Task 1): the arm/confirm control this task adds.
//
// The task brief's own tests used `btn.dispatchEvent({ type: 'click' })` and
// `nav.childNodes.length`. tests/fake-document.js implements neither —
// created elements have no `dispatchEvent` at all (this file's real idiom is
// the `fire()` helper above, which calls the registered listener directly),
// and the element shape is `children`, not `childNodes`. Adapted below to
// `fire()` and `.children.length`; the assertions themselves are unchanged.
// -----------------------------------------------------------------------

test('a disarmed reset button shows its plain label and arms on click', () => {
  const { x } = load();
  const doc = makeDocument();
  const nav = doc.createElement('div');
  let armed = 0;
  let confirmed = 0;
  const btn = x.resetButton(doc, nav, 'reset', false, () => { armed += 1; }, () => { confirmed += 1; });
  assert.strictEqual(btn.textContent, 'reset');
  fire(btn, 'click');
  assert.strictEqual(armed, 1);
  assert.strictEqual(confirmed, 0, 'the first click must never apply');
});

test('an armed reset button says so and applies on the next click', () => {
  const { x } = load();
  const doc = makeDocument();
  const nav = doc.createElement('div');
  let confirmed = 0;
  const btn = x.resetButton(doc, nav, 'reset', true, () => {}, () => { confirmed += 1; });
  assert.ok(/sure/i.test(btn.textContent), 'an armed button must say what it is about to do');
  fire(btn, 'click');
  assert.strictEqual(confirmed, 1);
});

test('an armed button is marked so it does not look like the disarmed one', () => {
  const { x } = load();
  const doc = makeDocument();
  const nav = doc.createElement('div');
  const off = x.resetButton(doc, nav, 'reset', false, () => {}, () => {});
  const on = x.resetButton(doc, nav, 'reset', true, () => {}, () => {});
  assert.notStrictEqual(off.className, on.className);
});

test('resetButton appends to the row it was given', () => {
  const { x } = load();
  const doc = makeDocument();
  const nav = doc.createElement('div');
  x.resetButton(doc, nav, 'reset', false, () => {}, () => {});
  assert.strictEqual(nav.children.length, 1);
});

test('the armed reset button carries the warning colour rule in the stylesheet', () => {
  const { x } = load();
  assert.match(x.panelStyleText(), /\.tes-reset-armed\s*\{[^}]*color:\s*var\(--tm-bad-text\)/);
});

// Round-1 QA finding: the brief's own CSS block gave the reset button its own
// `.tes-nav .tes-reset { margin-left: auto; }`, alongside the pre-existing
// `.tes-nav .tes-settings { margin-left: auto; }`. Two auto-margins on the
// same flex row do not stack — each claims a share of the leftover space, so
// `⚙ settings` and `reset` would drift apart instead of sitting together as
// one right-hand group. `.tes-settings`'s rule is what has to stay the row's
// only one: it is what opens the right-hand group at all, and every button
// appended after it (the reset button included) simply follows along inside
// that same group. Asserted as a count, not by naming `.tes-reset` directly,
// so a *third* button making the same mistake fails this too.
test('.tes-nav carries exactly one margin-left: auto declaration', () => {
  const { x } = load();
  const matches = x.panelStyleText().match(/\.tes-nav[^{]*\{[^}]*margin-left:\s*auto/g) || [];
  assert.strictEqual(matches.length, 1, `expected exactly one .tes-nav rule with margin-left: auto, found ${matches.length}`);
});

// -----------------------------------------------------------------------
// v0.3.0 Task 2: resetButton wired into the nav row (schedule/focus/settings
// get one; degrees does not, since it owns no player data), plus the armed
// flag's lifecycle inside init(). The task brief's own versions of several
// tests below used `panel.querySelectorAll(...)`, `nav.childNodes`, and
// `doc.querySelectorAll('.tes-header')`/`.dispatchEvent({...})` — this file's
// fake document always returns `[]` from querySelectorAll and implements no
// dispatchEvent at all, and the collapse toggle's own class is
// `.tes-header-toggle` (a button), not `.tes-header` (the wrapping div it
// sits inside). Adapted below to `descendants()`/`fire()` and the toggle's
// real class. `bootInit` (defined above) already returns `{x, doc, gmStore}`,
// not `{doc, stored}`, so the storage-reading assertions read `gmStore`
// directly rather than through a field this file's helper never returns.
// -----------------------------------------------------------------------

test('schedule and settings render a reset button; degrees does not', () => {
  const { x } = load();
  const doc = makeDocument();
  for (const [view, expected] of [['schedule', 1], ['settings', 1], ['grid', 0]]) {
    const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view })), handlers());
    const resets = descendants(panel).filter((c) => /tes-reset/.test(c.className));
    assert.strictEqual(resets.length, expected, `view ${view}`);
  }
});

test('the reset button is the last thing in the nav row', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state()), handlers());
  const nav = descendants(panel).find((c) => c.className === 'tes-nav');
  const last = nav.children[nav.children.length - 1];
  assert.ok(/tes-reset/.test(last.className),
    'margin-left:auto only pushes the right thing if it is last');
});

test('the settings button says defaults, the schedule button says reset', () => {
  const { x } = load();
  const doc = makeDocument();
  const s = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: 'settings' })), handlers());
  const settingsReset = descendants(s).find((c) => /tes-reset/.test(c.className));
  assert.ok(/defaults/i.test(settingsReset.textContent));
  const h = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ view: 'schedule' })), handlers());
  const scheduleReset = descendants(h).find((c) => /tes-reset/.test(c.className));
  assert.ok(/^reset/i.test(scheduleReset.textContent));
});

test('an error-model panel offers no reset button', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.errorModel('boom'), x.noopHandlers);
  const resets = descendants(panel).filter((c) => /tes-reset/.test(c.className));
  assert.strictEqual(resets.length, 0);
});

test('a collapsed panel offers no reset button', () => {
  const { x } = load();
  const doc = makeDocument();
  const panel = x.renderPanel(doc, doc.body, x.buildPanelModel(state({ collapsed: true })), handlers());
  const resets = descendants(panel).filter((c) => /tes-reset/.test(c.className));
  assert.strictEqual(resets.length, 0);
});

test('one click on the schedule reset clears nothing', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [34, 35] });
  const findReset = () => descendants(doc.querySelector('#tes-panel')).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.STORAGE_KEY)).queue, [34, 35]);
  assert.ok(/sure/i.test(findReset().textContent));
});

test('two clicks clear the queue', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [34, 35] });
  const findReset = () => descendants(doc.querySelector('#tes-panel')).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  fire(findReset(), 'click');
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.STORAGE_KEY)).queue, []);
});

test('changing view disarms', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [34, 35] });
  const panelEl = () => doc.querySelector('#tes-panel');
  const findReset = () => descendants(panelEl()).find((c) => /tes-reset/.test(c.className));
  const findNavBtn = (pattern) => {
    const nav = descendants(panelEl()).find((c) => c.className === 'tes-nav');
    return nav.children.find((b) => pattern.test(b.textContent));
  };
  fire(findReset(), 'click');
  fire(findNavBtn(/degrees/i), 'click');
  fire(findNavBtn(/schedule/i), 'click');
  assert.ok(!/sure/i.test(findReset().textContent),
    'an armed button must not survive a view change');
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.STORAGE_KEY)).queue, [34, 35]);
});

test('collapsing disarms', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [34, 35] });
  const panelEl = () => doc.querySelector('#tes-panel');
  const findReset = () => descendants(panelEl()).find((c) => /tes-reset/.test(c.className));
  const findToggle = () => descendants(panelEl()).find((c) => c.className === 'tes-header-toggle');
  fire(findReset(), 'click');
  fire(findToggle(), 'click');   // collapse
  fire(findToggle(), 'click');   // reopen
  assert.ok(!/sure/i.test(findReset().textContent));
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.STORAGE_KEY)).queue, [34, 35]);
});

test('resetting the queue leaves settings alone', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [34] }, { maxCooldownHours: 18 });
  const findReset = () => descendants(doc.querySelector('#tes-panel')).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  fire(findReset(), 'click');
  assert.strictEqual(JSON.parse(gmStore.get(x.SETTINGS_KEY)).maxCooldownHours, 18);
});

// The mirror of the test above: page ownership cuts both ways, and only one
// direction had an end-to-end guard. tests/settings.test.js proves the pure
// settingsDefaults() function preserves the queue's field alone (it has none
// to touch); it says nothing about whether the settings view's own click
// path ever reaches savePlan. Both halves are asserted — a reset that
// silently did nothing would still leave the queue untouched, so the queue
// assertion alone would not catch a broken settings reset.
test('resetting settings leaves the queue alone', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [34, 35] }, { maxCooldownHours: 18 });
  const panelEl = () => doc.querySelector('#tes-panel');
  const findReset = () => descendants(panelEl()).find((c) => /tes-reset/.test(c.className));
  const findNavBtn = (pattern) => {
    const nav = descendants(panelEl()).find((c) => c.className === 'tes-nav');
    return nav.children.find((b) => pattern.test(b.textContent));
  };
  fire(findNavBtn(/settings/i), 'click');
  fire(findReset(), 'click');
  fire(findReset(), 'click');
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.STORAGE_KEY)).queue, [34, 35],
    'the settings reset must not touch the stored queue');
  assert.strictEqual(JSON.parse(gmStore.get(x.SETTINGS_KEY)).maxCooldownHours, 48,
    'the settings reset must actually restore the default, not silently no-op');
});

test('a settings defaults reset replaces answered perks with the inferred values', async () => {
  const { doc, stored } = await initWithFixture({
    perks: { meritsPercent: 4, principal: false, wsuBlock: false },
  });
  openSettings(doc);
  const findReset = () => descendants(doc.querySelector('#tes-panel')).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  fire(findReset(), 'click');

  assert.deepStrictEqual(stored().perks, {
    meritsPercent: 20,
    principal: true,
    wsuBlock: true,
  });
});

test('a settings defaults reset redraws the inferred perk values into the fields', async () => {
  const { doc } = await initWithFixture({
    perks: { meritsPercent: 4, principal: false, wsuBlock: false },
  });
  openSettings(doc);
  const findReset = () => descendants(doc.querySelector('#tes-panel')).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  fire(findReset(), 'click');

  const body = doc.querySelector('#tes-panel').children[1];
  assert.strictEqual(fieldFor(body, 'Merits reduction (%)').value, '20');
  assert.strictEqual(fieldFor(body, 'Principal rank (10%)').value, 'yes');
  assert.strictEqual(fieldFor(body, 'WSU stock block (10%)').value, 'yes');
});

test('an ambiguous reduction still refills no perks after a settings defaults reset', async () => {
  const fixture = loadFixture();
  for (const category of fixture.categories) {
    for (const course of category.courses) {
      course.actualDuration = course.originDuration * 0.8;
    }
  }
  const { doc, stored } = await initWithFixture({
    perks: { meritsPercent: 4, principal: false, wsuBlock: false },
  }, undefined, fixture);
  openSettings(doc);
  const findReset = () => descendants(doc.querySelector('#tes-panel')).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  fire(findReset(), 'click');

  assert.deepStrictEqual(stored().perks, {
    meritsPercent: null,
    principal: null,
    wsuBlock: null,
  });
  const body = doc.querySelector('#tes-panel').children[1];
  assert.strictEqual(fieldFor(body, 'Merits reduction (%)').value, '');
  assert.strictEqual(fieldFor(body, 'Principal rank (10%)').value, '');
  assert.strictEqual(fieldFor(body, 'WSU stock block (10%)').value, '');
  const recorded = findSettingsSection(body, EDUCATION_PERKS_TITLE);
  assert.match(allText(recorded), /4 possible combinations/);
});

// Task 3: the focus view's own reset. The focus nav entry is disabled unless
// Queue order is 'focus' (see the "disabled until Queue order selects focus"
// test above), so every test here seeds that or the view is unreachable and
// findReset() below would find the schedule view's button instead.
//
// The brief's own version of these two tests used
// `doc.querySelectorAll('.tes-nav button')` and
// `btn().dispatchEvent({ type: 'click' })` — tests/fake-document.js returns
// `[]` from querySelectorAll and implements no dispatchEvent at all, so both
// would silently assert against nothing. Adapted to this file's real idioms,
// descendants()/fire(), the same substitution every other end-to-end test in
// this file already makes. The brief also read a `stored` field off
// bootInit's return value; bootInit (defined above) returns `gmStore`, not
// `stored` — adapted to `gmStore.get(x.SETTINGS_KEY)`/`gmStore.get(x.STORAGE_KEY)`,
// what the schedule- and settings-reset e2e tests above already read.
test('the focus view resets its selections and nothing else', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [34, 35] }, {
    orderMode: 'focus',
    focuses: [
      { category: 'Working Stats', selection: 'intelligence' },
      { category: 'Passive Stat Bonus', selection: 'Speed' },
    ],
  });
  const panelEl = () => doc.querySelector('#tes-panel');
  const findNavBtn = (pattern) => {
    const nav = descendants(panelEl()).find((c) => c.className === 'tes-nav');
    return nav.children.find((b) => pattern.test(b.textContent));
  };
  fire(findNavBtn(/focus/i), 'click');
  const priority = descendants(panelEl()).find((c) => c.className === 'tes-focus-priority');
  const header = descendants(panelEl()).find((c) => c.className === 'tes-focus-section-header'
    && descendants(c).includes(priority));
  assert.ok(header, 'the chosen number must render in its collapsed section header');
  assert.strictEqual(
    descendants(panelEl()).filter((c) => c.className === 'tes-focus-priority').length,
    2,
    'every chosen number must be visible before reset removes the focus list');
  const findReset = () => descendants(panelEl()).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  fire(findReset(), 'click');
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.SETTINGS_KEY)).focuses, []);
  assert.deepStrictEqual(JSON.parse(gmStore.get(x.STORAGE_KEY)).queue, [34, 35],
    'the focus page does not own the queue');
});

test('every focus number is gone after a focus reset, not just the selections', async () => {
  const { x, doc, gmStore } = await bootInit({ queue: [] }, {
    orderMode: 'focus',
    focuses: [{ category: 'Working Stats', selection: 'intelligence' }],
  });
  const panelEl = () => doc.querySelector('#tes-panel');
  const findNavBtn = (pattern) => {
    const nav = descendants(panelEl()).find((c) => c.className === 'tes-nav');
    return nav.children.find((b) => pattern.test(b.textContent));
  };
  fire(findNavBtn(/focus/i), 'click');
  const priority = descendants(panelEl()).find((c) => c.className === 'tes-focus-priority');
  const header = descendants(panelEl()).find((c) => c.className === 'tes-focus-section-header'
    && descendants(c).includes(priority));
  assert.ok(header, 'the chosen number must render in its collapsed section header');
  assert.strictEqual(
    descendants(panelEl()).filter((c) => c.className === 'tes-focus-priority').length,
    1,
    'the chosen number must be visible before reset removes it');
  const findReset = () => descendants(panelEl()).find((c) => /tes-reset/.test(c.className));
  fire(findReset(), 'click');
  fire(findReset(), 'click');
  assert.strictEqual(
    descendants(panelEl()).filter((c) => c.className === 'tes-focus-priority').length,
    0);
});
