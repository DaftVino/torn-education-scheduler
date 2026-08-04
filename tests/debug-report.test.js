'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

// A local fake DOM, as panel.test.js builds one: the sandbox document stub is
// too inert to record what a view actually appended.
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
      attributes: {},
      children: [],
      listeners: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, val) { this.attributes[name] = val; this[name] = val; },
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
    registry: registry,
  };
}

function flatten(el, out) {
  out = out || [];
  for (const child of (el.children || [])) { out.push(child); flatten(child, out); }
  return out;
}

function settingsModel(x, debugReport) {
  return {
    status: 'ok', message: null, reductionLabel: '40% off',
    queue: [], addable: [], stale: [], problems: [],
    finishLabel: null, totalLabel: null, collapsed: false,
    saveError: false, selectedCourseId: null, view: 'settings',
    settings: x.freshSettings(), settingsSaveError: false,
    perkInference: { determinate: false, totalPercent: null, note: 'note' },
    orderModes: [{ id: 'as-listed', label: 'As listed' }],
    debugReport: debugReport || null,
  };
}

function sampleInput(x) {
  return {
    scriptVersion: x.SCRIPT_VERSION,
    userAgent: 'Mozilla/5.0 (Test) Firefox/999',
    manager: 'Tampermonkey 5.0',
    failureReason: 'http-error',
    failureDetail: 'status 403',
    source: 'fiber',
    courseCount: 131,
    categoryCount: 12,
    reductionConstant: true,
    hasActiveCourse: true,
    queueLength: 2,
    queueCodes: ['BIO2380', 'BIO2390'],
    settings: x.freshSettings(),
  };
}

test('the report carries what a maintainer needs to diagnose a failure', () => {
  const { exports: x } = loadUserscript();
  const report = x.buildDebugReport(sampleInput(x));
  assert.ok(report.includes(x.SCRIPT_VERSION), 'no script version');
  assert.ok(report.includes('Tampermonkey 5.0'), 'no userscript manager');
  assert.ok(report.includes('http-error'), 'no failure reason');
  assert.ok(report.includes('status 403'), 'no failure detail');
  assert.ok(report.includes('fiber'), 'no acquisition source');
  assert.ok(report.includes('131'), 'no course count');
  assert.ok(report.includes('BIO2380'), 'no queued course codes');
  assert.ok(report.includes('13500000') || report.includes('13,500,000'), 'no settings values');
});

test('the report excludes the rfcv token in any form', () => {
  const { exports: x } = loadUserscript();
  const input = sampleInput(x);
  input.failureDetail = 'status 403';
  const report = x.buildDebugReport(input);
  assert.ok(!/rfcv/i.test(report), 'the report mentions rfcv');
  assert.ok(!/rfc_v/i.test(report), 'the report mentions rfc_v');
});

test('the report excludes a raw payload even when one is smuggled in', () => {
  const { exports: x } = loadUserscript();
  const input = sampleInput(x);
  // An unrecognised field must be ignored, not serialised. This is the
  // allowlist property: the builder reads named fields, never Object.keys.
  input.rawPayload = loadFixture();
  input.rfcv = 'SECRETTOKEN12345';
  input.completedIds = [34, 35, 36];
  input.activeCourseCompletedAt = 1767225600;
  const report = x.buildDebugReport(input);
  assert.ok(!report.includes('SECRETTOKEN12345'), 'a smuggled token reached the report');
  assert.ok(!report.includes('Introduction to Biochemistry'), 'raw payload content reached the report');
  assert.ok(!report.includes('1767225600'), 'active-course timing reached the report');
  assert.ok(!/\b34,\s*35,\s*36\b/.test(report), 'the completed-course set reached the report');
});

test('the report never names the completed-course set or active-course timing', () => {
  const { exports: x } = loadUserscript();
  const report = x.buildDebugReport(sampleInput(x));
  assert.ok(!/completedIds/i.test(report));
  assert.ok(!/completedAt/i.test(report));
  // "an active course was present" is shape, not timing — that is allowed.
  assert.ok(/active course/i.test(report), 'the shape flag is missing');
});

test('the report survives missing optional fields', () => {
  const { exports: x } = loadUserscript();
  const report = x.buildDebugReport({ scriptVersion: '0.2.0' });
  assert.ok(typeof report === 'string' && report.length > 0);
  assert.ok(!report.includes('undefined'), 'an absent field rendered as undefined');
});

test('the contact line renders no URL while the placeholder is unresolved', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(x.GREASY_FORK_URL, null);
  assert.strictEqual(x.FORUM_POST_URL, null);
  const report = x.buildDebugReport(sampleInput(x));
  assert.ok(/greasy fork/i.test(report), 'the report does not say where to send it');
  assert.ok(!/https?:\/\//.test(report), 'the report contains a URL it cannot have');
});

// The tests above smuggle secrets under the names a careless blocklist would
// know to strip. These use the names a careless *allowlist* would wave
// through: fields sitting one letter away from a real one, and a whole
// session's worth of account data hung off objects the builder is handed for
// other reasons. Nothing here may survive into the string.
test('no secret survives under a field name adjacent to a real one', () => {
  const { exports: x } = loadUserscript();
  const input = sampleInput(x);
  const raw = loadFixture();

  // Plausible neighbours of allowlisted names.
  input.detail = 'rfcv=SESSIONTOKEN_ADJACENT';
  input.reason = 'threw at rfcv=SESSIONTOKEN_ADJACENT';
  input.data = raw;
  input.payload = raw;
  input.response = JSON.stringify(raw);
  input.body = JSON.stringify(raw);
  input.courses = raw.categories;
  input.categories = raw.categories;
  input.token = 'eyJhbGciOiJIUzI1NiJ9.SESSIONJWT_ADJACENT.sig';
  input.cookie = 'rfc_v=SESSIONTOKEN_ADJACENT; logoutHash=LOGOUTHASH_ADJACENT';
  input.logoutHash = 'LOGOUTHASH_ADJACENT';
  input.userID = 3141592;
  input.activeCourse = { id: 34, completedAt: 1767225600 };
  input.completed = [34, 35, 36];

  // And the same again hung off objects the builder legitimately reads into.
  input.settings.rfcv = 'SESSIONTOKEN_NESTED';
  input.settings.completedIds = [34, 35, 36];
  input.settings.perks.rfcv = 'SESSIONTOKEN_NESTED';
  input.settings.perks.activeCourse = { completedAt: 1767225600 };

  const report = x.buildDebugReport(input);

  for (const secret of [
    'SESSIONTOKEN_ADJACENT', 'SESSIONJWT_ADJACENT', 'SESSIONTOKEN_NESTED',
    'LOGOUTHASH_ADJACENT', '3141592', '1767225600',
    'Introduction to Biochemistry', 'eyJhbGciOiJIUzI1NiJ9',
  ]) {
    assert.ok(!report.includes(secret), `"${secret}" reached the report`);
  }
  assert.ok(!/rfc_?v/i.test(report), 'a token name reached the report');
  assert.ok(!/logouthash/i.test(report), 'logoutHash reached the report');
  assert.ok(!/userid/i.test(report), 'userID reached the report');
  // A report that serialised anything wholesale would dwarf this bound.
  assert.ok(report.length < 2000, 'the report is far larger than its named fields');
});

test('a smuggled object never reaches the report via a stringifying accessor', () => {
  const { exports: x } = loadUserscript();
  const input = sampleInput(x);
  // If the builder ever spreads, stringifies, or iterates the input, one of
  // these fires and the assertion below catches it.
  let touched = false;
  Object.defineProperty(input, 'rfcv', {
    enumerable: true,
    get() { touched = true; return 'SECRETTOKEN12345'; },
  });
  input.rawPayload = {
    toJSON() { touched = true; return { note: 'SECRETTOKEN12345' }; },
    toString() { touched = true; return 'SECRETTOKEN12345'; },
  };
  const report = x.buildDebugReport(input);
  assert.strictEqual(touched, false, 'the builder read a field outside its allowlist');
  assert.ok(!report.includes('SECRETTOKEN12345'), 'a smuggled token reached the report');
});

// ─── the render path ────────────────────────────────────────────────────

test('no copy button exists until the report itself is on screen', () => {
  const { exports: x } = loadUserscript();
  const doc = makeFakeDocument();
  const body = doc.createElement('div');
  x.renderSettingsView(doc, body, settingsModel(x, null), {});
  const nodes = flatten(body);
  assert.ok(!nodes.some((n) => n.textContent === 'copy'), 'a copy button was offered with nothing to read');
  assert.ok(!nodes.some((n) => n.className === 'tes-report'), 'a report block rendered when there is no report');
  assert.ok(nodes.some((n) => n.textContent === 'build debug report'), 'no way to ask for the report');
});

test('the report is rendered in full before the copy button appears beside it', () => {
  const { exports: x } = loadUserscript();
  const doc = makeFakeDocument();
  const body = doc.createElement('div');
  const report = x.buildDebugReport(sampleInput(x));
  x.renderSettingsView(doc, body, settingsModel(x, report), {});
  const nodes = flatten(body);
  const pre = nodes.find((n) => n.className === 'tes-report');
  assert.ok(pre, 'the report block is missing');
  assert.strictEqual(pre.tagName, 'pre');
  assert.strictEqual(pre.textContent, report, 'the panel shows something other than what would be copied');
  const copyIndex = nodes.findIndex((n) => n.textContent === 'copy');
  assert.ok(copyIndex !== -1, 'no copy button beside a rendered report');
  assert.ok(copyIndex > nodes.indexOf(pre), 'the copy button precedes the report it copies');
});

test('the settings view renders no link element while the guide URL is unresolved', () => {
  const { exports: x } = loadUserscript();
  const doc = makeFakeDocument();
  const body = doc.createElement('div');
  x.renderSettingsView(doc, body, settingsModel(x, null), {});
  for (const node of flatten(body)) {
    assert.notStrictEqual(node.tagName, 'a', 'a link was rendered with no URL to point at');
    assert.ok(!('href' in node.attributes), 'an href was set with no URL to point at');
  }
});

test('the schedule view renders no foot link while the guide URL is unresolved', () => {
  const { exports: x } = loadUserscript();
  const doc = makeFakeDocument();
  const body = doc.createElement('div');
  x.renderScheduleView(doc, body, {
    status: 'ok', message: null, reductionLabel: '40% off',
    queue: [], addable: [], stale: [], problems: [],
    finishLabel: null, totalLabel: null, collapsed: false,
    saveError: false, selectedCourseId: null, view: 'schedule',
  }, { onAdd() {}, onRemove() {}, onPickerChange() {} });
  for (const node of flatten(body)) {
    assert.notStrictEqual(node.tagName, 'a', 'a link was rendered with no URL to point at');
    assert.ok(!node.className || node.className !== 'tes-foot', 'an empty foot line was rendered');
  }
});

test('the panel builds a real report on demand and it still carries no secret', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const { exports: x } = loadUserscript({
    location: { search: '' }, // keeps the bootstrap from auto-running init()
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  await x.init();

  const panel = doc.querySelector('#tes-panel');
  assert.ok(panel, 'no panel was drawn');
  // Switch to settings, then ask for the report, driving the real handlers.
  const click = (label) => {
    const target = flatten(doc.querySelector('#tes-panel')).find((n) => n.textContent === label);
    assert.ok(target, `no "${label}" control on screen`);
    for (const fn of (target.listeners.click || [])) fn();
  };
  click('⚙ settings');
  click('build debug report');

  const pre = flatten(doc.querySelector('#tes-panel')).find((n) => n.className === 'tes-report');
  assert.ok(pre, 'the report was not rendered after being asked for');
  const text = pre.textContent;

  // It says something real about this session...
  assert.ok(text.includes(x.SCRIPT_VERSION), 'no script version');
  assert.ok(/Courses: \d+/.test(text), 'no course count');
  assert.ok(/greasy fork/i.test(text), 'no instruction on where to send it');

  // ...and nothing about the account behind it.
  assert.ok(!/rfc_?v/i.test(text), 'a token name reached the rendered report');
  assert.ok(!text.includes('abcdefghijklm'), 'the session token reached the rendered report');
  assert.ok(!text.includes('Introduction to Biochemistry'), 'payload content reached the rendered report');
  assert.ok(!/completedAt/i.test(text), 'active-course timing reached the rendered report');
  assert.ok(!/https?:\/\//.test(text), 'a URL reached the rendered report');

  // Toggling it off puts it away again, copy button and all.
  click('hide debug report');
  const after = flatten(doc.querySelector('#tes-panel'));
  assert.ok(!after.some((n) => n.className === 'tes-report'), 'the report stayed on screen');
  assert.ok(!after.some((n) => n.textContent === 'copy'), 'the copy button outlived its report');
});
