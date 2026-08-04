'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');
// The shared fake DOM (tests/fake-document.js). The caveat this feature exists
// for lives in the rendered view, not in the model, so the view is what the
// tests below read.
const { makeFakeDocument } = require('./fake-document');

const NOW = 1767225600;

function grid(x) {
  const data = x.parsePayload(loadFixture());
  return x.buildDegreeGrid({
    courses: data.courses,
    categories: data.categories,
    completedIds: data.completedIds,
    activeCourse: data.activeCourse,
    now: NOW,
  });
}

test('the grid has one box per category plus one for all courses', () => {
  const { exports: x } = loadUserscript();
  const out = grid(x);
  assert.strictEqual(out.boxes.length, 13, 'expected twelve degrees plus all-courses');
  assert.strictEqual(out.boxes[out.boxes.length - 1].key, 'all', 'the all-courses box is not last');
  const names = out.boxes.map((b) => b.name);
  for (const expected of ['Biology', 'Business', 'Computer Science', 'Law', 'Mathematics']) {
    assert.ok(names.includes(expected), `${expected} has no box`);
  }
});

test('each degree box names its bachelor and starts from now', () => {
  const { exports: x } = loadUserscript();
  const out = grid(x);
  const biology = out.boxes.find((b) => b.name === 'Biology');
  assert.strictEqual(biology.bachelorPrefix, 'BIO3420');
  assert.ok(biology.courseCount > 0);
  assert.ok(biology.totalSeconds > 0);
  // The active course finishes at NOW, so every box starts there or later.
  assert.ok(biology.finishesAt >= NOW + biology.totalSeconds - 1);
});

test('the all-courses box matches allRemainingCourses', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const out = grid(x);
  const all = out.boxes.find((b) => b.key === 'all');
  assert.strictEqual(all.courseCount, x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse).length);
  assert.strictEqual(all.courseCount, 115);
});

// The plan predicted `sumsDiffer === true` against the real catalogue, on the
// theory that degrees share prerequisite courses. Torn's data says otherwise,
// and the reason is asserted here rather than left in a comment: no course in
// the fixture has a parentId outside its own category, and a tier-3 bachelor
// gates only on tier-2 courses in its own category, so the twelve categories
// partition the 131 courses exactly. The boxes therefore sum, to the course.
//
// Writing the prediction into an assertion would have meant either a red suite
// or an implementation bent until it produced a number the data does not
// contain. sumsDiffer is kept — it is the honest comparison, and the test below
// proves it turns on when the sharing it describes actually exists.
test('no prerequisite in the fixture crosses a category, so the boxes do sum', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const categoryOf = new Map();
  for (const category of data.categories) for (const id of category.courseIds) categoryOf.set(id, category.id);
  for (const course of data.courses.values()) {
    if (course.parentId === null || course.parentId === undefined) continue;
    assert.strictEqual(
      categoryOf.get(course.parentId), categoryOf.get(course.id),
      `${course.prefix} has a parent outside its category — the partition no longer holds`
    );
  }

  const out = grid(x);
  const degrees = out.boxes.filter((b) => b.key !== 'all');
  const summed = degrees.reduce((n, b) => n + b.courseCount, 0);
  const all = out.boxes.find((b) => b.key === 'all');
  assert.strictEqual(summed, all.courseCount, 'the categories no longer partition the catalogue');
  assert.strictEqual(out.sumsDiffer, false, 'the caveat flag claims a sharing the data does not have');

  // The seconds partition too, and the view says so in as many words: the
  // note it renders unconditionally tells the player the durations add up.
  // If that ever stops being true the sentence becomes a false claim, so the
  // equality is pinned here rather than left to the count above to imply.
  const summedSeconds = degrees.reduce((n, b) => n + b.totalSeconds, 0);
  assert.strictEqual(summedSeconds, all.totalSeconds, 'the durations no longer add up, but the view still says they do');
  assert.strictEqual(summedSeconds, 113944320, 'the fixture total moved — check the note still reads true');
});

// The catalogue that makes sumsDiffer meaningful: one course given a parent in
// another category, which every course downstream of it then drags across the
// boundary. Built by mutating the real fixture rather than by hand, so the
// only difference from the passing case above is the one link.
function sharedPrerequisiteFixture() {
  const raw = loadFixture();
  const business = raw.categories.find((c) => c.name === 'Business');
  const bus1100 = business.courses.find((c) => c.prefix === 'BUS1100');
  bus1100.parentId = 22; // MTH1220, Mathematics' tier-1 root, not completed
  return raw;
}

test('sumsDiffer turns on when a prerequisite really is shared across degrees', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(sharedPrerequisiteFixture());
  const out = x.buildDegreeGrid({
    courses: data.courses, categories: data.categories, completedIds: data.completedIds,
    activeCourse: data.activeCourse, now: NOW,
  });
  const degrees = out.boxes.filter((b) => b.key !== 'all');
  const summed = degrees.reduce((n, b) => n + b.courseCount, 0);
  const all = out.boxes.find((b) => b.key === 'all');
  // MTH1220 is now counted by Business as well as by Mathematics, and by
  // nothing else: one course, counted twice.
  assert.strictEqual(all.courseCount, 115, 'the catalogue itself must not have changed');
  assert.strictEqual(summed, 116, 'the shared course is not being double-counted');
  assert.strictEqual(out.sumsDiffer, true, 'the caveat flag is not set');
});

test('a completed degree yields a zero box rather than being omitted', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const allIds = new Set([...data.courses.keys()]);
  const out = x.buildDegreeGrid({
    courses: data.courses, categories: data.categories,
    completedIds: allIds, activeCourse: null, now: NOW,
  });
  assert.strictEqual(out.boxes.length, 13);
  for (const box of out.boxes) {
    assert.strictEqual(box.courseCount, 0);
    assert.strictEqual(box.totalSeconds, 0);
    assert.strictEqual(box.finishesAt, NOW);
  }
  assert.strictEqual(out.sumsDiffer, false);
});

// The box title names its bachelor as *the* degree. Torn ships one tier-3 per
// category, so a second one makes that claim false of both — and picking
// whichever came last in the payload would relabel the box silently, which is
// the failure mode this repo refuses everywhere else it prints a fact.
test('a category with two bachelors is left unlabelled rather than labelled wrongly', () => {
  const { exports: x } = loadUserscript();
  const raw = loadFixture();
  const biology = raw.categories.find((c) => c.name === 'Biology');
  const second = biology.courses.find((c) => c.prefix === 'BIO2370');
  second.tier = 3;
  const data = x.parsePayload(raw);
  const out = x.buildDegreeGrid({
    courses: data.courses, categories: data.categories, completedIds: data.completedIds,
    activeCourse: data.activeCourse, now: NOW,
  });
  const box = out.boxes.find((b) => b.name === 'Biology');
  assert.strictEqual(box.bachelorPrefix, null, 'one of two bachelors was named as though it were the degree');
  // Every other category is untouched, so the fallback is scoped to the
  // category that lost the guarantee rather than blanking the whole grid.
  assert.strictEqual(out.boxes.find((b) => b.name === 'Law').bachelorPrefix, 'LAW3102');
});

// ─── the rendered view ──────────────────────────────────────────────
//
// A model flag nothing renders is how this feature fails silently. Earlier in
// this release a debug report shipped unreachable in the state it existed for,
// and every test asserting the model passed. So these read the DOM the player
// actually sees, through renderPanel — which also pins that the grid view is
// reachable at all.
//
// Two caveats, and they are not the same caveat:
//   - the overlapping-dates note, which is unconditional, because it is
//     unconditionally true and is the number that actually looks wrong here:
//     twelve boxes finishing in 2026 above an all-courses box finishing in
//     2029, because every box starts from today rather than from the end of
//     the box above it.
//   - the sumsDiffer note, which is conditional and currently off, because
//     Torn's categories partition the catalogue. Both directions are asserted.

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
const handlers = { onToggle() {}, onViewChange() {} };

function gridPanel(exports, model) {
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  const panel = exports.renderPanel(doc, mount, model, handlers);
  return descendants(panel);
}

function gridModel(rawPayload) {
  const { exports } = loadUserscript();
  const data = exports.parsePayload(rawPayload || loadFixture());
  const model = exports.buildPanelModel({
    fetchResult: { ok: true, data: data },
    plan: { queue: [], collapsed: false },
    view: 'grid',
    now: NOW,
  });
  return { exports: exports, model: model };
}

test('the panel model carries the grid with labels the view can print', () => {
  const { model } = gridModel();
  assert.ok(model.grid, 'the ok model carries no grid');
  assert.strictEqual(model.grid.boxes.length, 13);
  assert.strictEqual(model.grid.sumsDiffer, false);
  const biology = model.grid.boxes.find((b) => b.name === 'Biology');
  assert.strictEqual(typeof biology.durationLabel, 'string');
  assert.strictEqual(typeof biology.finishLabel, 'string');
  assert.match(biology.finishLabel, /UTC/);
});

test('the grid view renders a box per degree, naming the bachelor', () => {
  const { exports, model } = gridModel();
  const nodes = gridPanel(exports, model);
  // Exact class names, not a prefix test: `tes-cell-title` starts with
  // `tes-cell` too, and counting those would pass on a view that drew no boxes.
  const cells = nodes.filter((n) => n.className === 'tes-cell' || n.className === 'tes-cell tes-cell-all');
  assert.strictEqual(cells.length, 13, 'expected thirteen boxes on screen');
  const titles = nodes.filter((n) => n.className === 'tes-cell-title').map((n) => n.textContent);
  assert.ok(titles.includes('Biology (BIO3420)'), `no Biology box title: ${titles.join(' | ')}`);
  assert.ok(titles.includes('All courses'), 'no all-courses box title');
  const details = nodes.filter((n) => n.className === 'tes-cell-detail').map((n) => n.textContent);
  assert.ok(details.some((t) => /115 courses/.test(t)), 'the all-courses box does not print its count');

  // The date is what this view is for, so it is asserted where the player
  // reads it rather than only on the model. Biology's box carries its own
  // count, its own duration and its own finish date, all three in one cell.
  const biology = model.grid.boxes.find((b) => b.name === 'Biology');
  const biologyDetail = details.find((t) => t.indexOf(biology.finishLabel) !== -1);
  assert.ok(biologyDetail, `no cell carries Biology's finish date (${biology.finishLabel})`);
  assert.match(biologyDetail, /^6 courses — 84 days\n/, 'the cell does not lead with its count and duration');
  assert.match(biologyDetail, /Thu, 26 Mar 2026 00:00:00 UTC$/, 'the cell does not end with the finish date');

  // A finished degree is a box that says so, not a box reading "0 courses —
  // 0 hours" beside today's date, which reads as an estimate rather than a
  // completion. Sports Science is complete in the fixture.
  const sports = model.grid.boxes.find((b) => b.name === 'Sports Science');
  assert.strictEqual(sports.courseCount, 0, 'the fixture no longer has a completed degree to check');
  assert.ok(details.includes('Already complete'), 'a completed degree does not say so on screen');
  assert.ok(!details.some((t) => /0 courses/.test(t)), 'a completed degree renders as an empty estimate');
});

// The dates are what a reader will try to add up: twelve boxes finishing in
// 2026 above an all-courses box finishing in 2029. Nothing on screen explains
// that except this line, so it is not optional and it is not conditional.
test('the grid view says the dates overlap, because every box starts from today', () => {
  const { exports, model } = gridModel();
  const text = gridPanel(exports, model).map((n) => n.textContent || '').join('\n');
  assert.match(text, /each starts from today/i, 'nothing explains why the dates overlap');
  assert.match(text, /cannot be read as a sequence/i, 'the note does not say what not to conclude');
  // The note must not deny that the durations add up — against this catalogue
  // they do, to the second, and a player who checked would catch the panel
  // contradicting itself. The equality is pinned above.
  assert.match(text, /durations do add up/i, 'the note does not say the durations add up');
  assert.doesNotMatch(text, /not the sum of the others/i, 'the note denies an equality the data has');
  // The dates that make the note necessary are really on screen and really
  // that far apart, so this is not a note about a problem the view does not
  // have: eleven degrees land in 2026, the all-courses box in 2029.
  const boxes = model.grid.boxes;
  const latestDegree = Math.max(...boxes.filter((b) => b.key !== 'all').map((b) => b.finishesAt));
  assert.ok(boxes.find((b) => b.key === 'all').finishesAt > latestDegree + 86400 * 365,
    'the all-courses box is not far enough past the degrees for the note to be needed');
});

test('the grid view prints the reason the boxes do not add up when they do not', () => {
  const { exports, model } = gridModel(sharedPrerequisiteFixture());
  assert.strictEqual(model.grid.sumsDiffer, true, 'the fixture no longer produces a shared prerequisite');
  const text = gridPanel(exports, model).map((n) => n.textContent || '').join('\n');
  assert.match(text, /do not add up/i, 'the caveat is missing from the rendered view');
  assert.match(text, /share prerequisite/i, 'the caveat does not say why');
});

test('the grid view omits the sums caveat when the boxes do add up', () => {
  const { exports, model } = gridModel();
  assert.strictEqual(model.grid.sumsDiffer, false);
  const text = gridPanel(exports, model).map((n) => n.textContent || '').join('\n');
  assert.doesNotMatch(text, /do not add up/i, 'the caveat renders even when the boxes sum');
  assert.doesNotMatch(text, /share prerequisite/i, 'the caveat renders even when the boxes sum');
});

// Called directly rather than through renderPanel, and deliberately so:
// renderPanel reaches renderGridView only on a non-error model, and every
// non-error model carries a grid, so this branch is a guard on the model
// contract (a renderer must not meet an undefined) rather than a state the
// panel can produce today. Testing it through renderPanel would assert a
// reachability that does not exist.
test('the grid view says so rather than rendering nothing when handed no grid', () => {
  const { exports } = loadUserscript();
  const doc = makeFakeDocument();
  const body = doc.createElement('div');
  exports.renderGridView(doc, body, exports.errorModel('boom'), handlers);
  const text = descendants(body).map((n) => n.textContent || '').join('\n');
  assert.match(text, /no degree estimates/i, 'a grid-less model renders an empty view');
});
