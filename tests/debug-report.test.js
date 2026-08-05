'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');
// The shared fake DOM: the sandbox document stub is too inert to record what a
// view actually appended. One copy, in tests/fake-document.js — three copies is
// how the picker's default selection went unmodelled everywhere but here.
const { makeFakeDocument } = require('./fake-document');

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

test('the debug report carries focusRankBasis through gatherDebugContext', () => {
  const { exports: x } = loadUserscript();
  const settings = x.normaliseSettings({ focusRankBasis: 'total' });
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: false, reason: 'offline', detail: 'test' },
    plan: { queue: [], collapsed: false },
    settings: settings,
  });
  assert.strictEqual(ctx.settings.focusRankBasis, 'total');
  assert.match(x.buildDebugReport(ctx), /^  Focus rank basis: total$/m);
});

// Named for what is actually guaranteed. The *word* "rfcv" can legitimately
// reach a real report: parsePayload carries Torn's own `raw.error` into the
// detail, and Torn's live string for a rejected request is "Wrong rfcv token"
// — see the test below. What can never reach it is a token *value*, and it
// cannot because no allowlisted field is ever fed one: the adapter is
// contracted to keep the token out of every detail, and the report reads no
// cookie at all.
test('no rfcv token value reaches the report', () => {
  const { exports: x } = loadUserscript();
  const input = sampleInput(x);
  input.failureDetail = 'status 403';
  input.rfcv = 'v1a2b3c4d5e6f7g8h9';
  input.rfc_v = 'v1a2b3c4d5e6f7g8h9';
  input.cookie = 'rfc_v=v1a2b3c4d5e6f7g8h9; rfc_id=i9h8g7f6e5d4c3b2a1';
  const report = x.buildDebugReport(input);
  assert.ok(!report.includes('v1a2b3c4d5e6f7g8h9'), 'an rfc_v token value reached the report');
  assert.ok(!report.includes('i9h8g7f6e5d4c3b2a1'), 'an rfc_id token value reached the report');
  assert.ok(!/rfc_?v\s*=/i.test(report), 'a token assignment reached the report');
  // With a detail that does not quote Torn, no token name appears either.
  assert.ok(!/rfcv/i.test(report), 'the report mentions rfcv unprompted');
});

test("Torn's own \"Wrong rfcv token\" diagnosis reaches the report as words, not as a token", () => {
  const { exports: x } = loadUserscript();
  const input = sampleInput(x);
  // parsePayload carries a string raw.error into the PayloadError detail, and
  // this is the live string Torn returns. Carrying it is the point — it is
  // Torn's own diagnosis and the fastest route to a fix. It names the token
  // without being one.
  input.failureReason = 'not-a-payload';
  input.failureDetail = 'Wrong rfcv token';
  const report = x.buildDebugReport(input);
  assert.ok(report.includes('Wrong rfcv token'), "Torn's diagnosis was dropped from the report");
  assert.ok(!/rfc_?v\s*=/i.test(report), 'a token assignment accompanied the diagnosis');
  // The word appears exactly once, and it is Torn's. Anything else naming the
  // token would be the script volunteering it.
  assert.strictEqual((report.match(/rfcv/gi) || []).length, 1, 'the report names rfcv somewhere else too');
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

// ─── reachability in the failure state ──────────────────────────────────
//
// The whole point of the feature. renderPanel used to return on
// `model.status === 'error'` before the nav row, so the settings view — and
// with it the only control that can build a report — was unreachable for a
// player whose acquisition failed. That is the single most likely reason
// anyone opens Greasy Fork feedback, and it also meant failureReason and
// failureDetail were null on every path that could actually produce a report.

async function failedAcquisition() {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm'; // so the adapter really fires the request
  const { exports: x } = loadUserscript({
    location: { search: '' },
    document: doc,
    // 403, and the fake document exposes no React internals, so both
    // acquisition paths fail — the state the report exists for.
    fetch: async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }),
  });
  await x.init();
  return { x, doc };
}

test('a failed acquisition still names the failure and still reaches the settings view', async () => {
  const { doc } = await failedAcquisition();
  const panel = doc.querySelector('#tes-panel');
  assert.ok(panel, 'no panel was drawn for a failed acquisition');
  const nodes = flatten(panel);
  const text = nodes.map((n) => n.textContent).join(' ');
  assert.match(text, /Couldn't load your education data/, 'the failure was not named');
  assert.match(text, /403/, 'the underlying reason was not carried into the panel');
  assert.ok(nodes.some((n) => n.textContent === '⚙ settings'), 'the settings view is unreachable in the error state');
});

test('a player whose acquisition failed can build a report, and it carries a real reason', async () => {
  const { doc } = await failedAcquisition();
  const click = (label) => {
    const target = flatten(doc.querySelector('#tes-panel')).find((n) => n.textContent === label);
    assert.ok(target, `no "${label}" control on screen`);
    for (const fn of (target.listeners.click || [])) fn();
  };
  click('⚙ settings');
  click('build debug report');

  const pre = flatten(doc.querySelector('#tes-panel')).find((n) => n.className === 'tes-report');
  assert.ok(pre, 'the debug report is unreachable in the state it exists for');
  const text = pre.textContent;

  // The Failure block is the reason this feature exists; "not recorded" here
  // would mean the report is decorative.
  assert.ok(!/Reason: not recorded/.test(text), 'the report recorded no failure reason');
  assert.ok(!/Detail: not recorded/.test(text), 'the report recorded no failure detail');
  assert.match(text, /Reason: \S/, 'no failure reason');
  assert.match(text, /403/, 'the failing status did not reach the report');
  // And it is still the same allowlist.
  assert.ok(!text.includes('abcdefghijklm'), 'the session token reached the report');
  assert.ok(!/https?:\/\//.test(text), 'a URL reached the report');
});

test('the perks note is reachable in the error state, so an unreadable page is still enterable', async () => {
  const { doc } = await failedAcquisition();
  const click = (label) => {
    const target = flatten(doc.querySelector('#tes-panel')).find((n) => n.textContent === label);
    assert.ok(target, `no "${label}" control on screen`);
    for (const fn of (target.listeners.click || [])) fn();
  };
  click('⚙ settings');
  const text = flatten(doc.querySelector('#tes-panel')).map((n) => n.textContent).join(' ');
  // NO_INFERENCE's note used to be written for a state nobody could open.
  assert.match(text, /could not be read/i, 'the inference note is still stranded');
  assert.match(text, /Enter what you hold/, 'the invitation to enter perks is still stranded');
});

// ─── gatherDebugContext ─────────────────────────────────────────────────

test('gatherDebugContext reports the failure branch, which is the only one that can', () => {
  const { exports: x } = loadUserscript();
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: false, reason: 'fiber-budget-exhausted', detail: 'gave up after 20000 nodes', triedFiber: true },
    plan: { queue: [1, 2], collapsed: false },
    settings: x.freshSettings(),
  });
  assert.strictEqual(ctx.failureReason, 'fiber-budget-exhausted');
  assert.strictEqual(ctx.failureDetail, 'gave up after 20000 nodes');
  assert.strictEqual(ctx.source, null);
  // No data means no shape to describe — and, critically, no course codes.
  assert.strictEqual(ctx.courseCount, null);
  assert.strictEqual(ctx.categoryCount, null);
  assert.strictEqual(ctx.reductionConstant, null);
  assert.strictEqual(ctx.hasActiveCourse, null);
  assert.deepStrictEqual(ctx.queueCodes, []);
  assert.strictEqual(ctx.queueLength, 2);
  assert.strictEqual(ctx.scriptVersion, x.SCRIPT_VERSION);
  const report = x.buildDebugReport(ctx);
  assert.match(report, /fiber-budget-exhausted/, 'the budget/absence distinction was lost');
});

test('gatherDebugContext reports shape only on success, never the payload', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: true, data: data, source: 'fetch' },
    plan: { queue: [], collapsed: false },
    settings: x.freshSettings(),
  });
  assert.strictEqual(ctx.source, 'fetch');
  assert.strictEqual(ctx.failureReason, null);
  assert.strictEqual(ctx.failureDetail, null);
  assert.ok(Number.isInteger(ctx.courseCount) && ctx.courseCount > 0, 'no course count');
  assert.ok(Number.isInteger(ctx.categoryCount) && ctx.categoryCount > 0, 'no category count');
  assert.strictEqual(typeof ctx.hasActiveCourse, 'boolean');
  // The keys are the allowlist, and nothing payload-shaped is among them.
  assert.deepStrictEqual(Object.keys(ctx).sort(), [
    'categoryCount', 'courseCount', 'failureDetail', 'failureReason', 'focusSelections',
    'focusStale', 'focusUnmapped', 'hasActiveCourse', 'manager', 'queueCodes', 'queueLength',
    'reductionConstant', 'scriptVersion', 'settings', 'source', 'userAgent',
  ]);
  const report = x.buildDebugReport(ctx);
  assert.ok(!report.includes('Introduction to Biochemistry'), 'a course name reached the report');
});

test('gatherDebugContext refuses a non-string course prefix rather than stringifying it', () => {
  const { exports: x } = loadUserscript();
  // normaliseCourse copies raw.prefix across without a type check, so this is
  // the one payload-derived value that could reach the report as an object.
  const hostile = { toString() { return 'PREFIX_FROM_TOSTRING'; } };
  const courses = new Map([[7, { id: 7, prefix: hostile, name: 'x', status: 'available', duration: 1 }]]);
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: true, source: 'fiber', data: { courses: courses, categories: [], reduction: { constant: true }, activeCourse: null } },
    plan: { queue: [7], collapsed: false },
    settings: x.freshSettings(),
  });
  assert.deepStrictEqual(ctx.queueCodes, ['7'], 'a non-string prefix was passed through');
  assert.ok(!x.buildDebugReport(ctx).includes('PREFIX_FROM_TOSTRING'), 'toString was invoked on payload data');
});

test('gatherDebugContext bounds the detail Torn wrote, and marks the truncation', () => {
  const { exports: x } = loadUserscript();
  // parsePayload splices raw.error into the detail whole, and that string is
  // Torn's, not ours. The player pastes this in public by hand.
  const huge = 'E'.repeat(5000);
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: false, reason: 'not-a-payload', detail: huge },
    plan: { queue: [] },
    settings: null,
  });
  assert.ok(ctx.failureDetail.length < 400, `the detail was not bounded (${ctx.failureDetail.length} chars)`);
  assert.match(ctx.failureDetail, /truncated, 5000 chars total/, 'the truncation was silent');
  assert.ok(ctx.failureDetail.startsWith('EEEE'), 'the start of the detail was lost');
  const report = x.buildDebugReport(ctx);
  assert.ok(report.length < 2000, 'the report is unbounded despite the clamp');
});

test('gatherDebugContext drops a non-string reason rather than coercing it', () => {
  const { exports: x } = loadUserscript();
  // The catch blocks build a detail from `(e && e.message)`, and a thrown
  // value is whatever threw it — an object with a toString reaches here.
  const hostile = { toString() { return 'REASON_FROM_TOSTRING'; } };
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: false, reason: hostile, detail: { toString() { return 'DETAIL_FROM_TOSTRING'; } } },
    plan: { queue: [] },
    settings: null,
  });
  assert.strictEqual(ctx.failureReason, null, 'a non-string reason was passed through');
  assert.strictEqual(ctx.failureDetail, null, 'a non-string detail was passed through');
  const report = x.buildDebugReport(ctx);
  assert.ok(!report.includes('REASON_FROM_TOSTRING'), 'toString was invoked on a thrown value');
  assert.ok(!report.includes('DETAIL_FROM_TOSTRING'), 'toString was invoked on a thrown value');
  assert.match(report, /Reason: not recorded/, 'the dropped field did not render as absent');
});

test('a panel with no live handlers renders no controls that do nothing', () => {
  const { exports: x } = loadUserscript();
  const doc = makeFakeDocument();
  const mount = doc.createElement('div');
  // init() passes the module's own noopHandlers for a draw() that threw.
  // Everything on that panel is inert, so nav buttons would only invite a
  // click that reads as the script being broken twice over.
  const panel = x.renderPanel(doc, mount, x.errorModel('it broke'), x.noopHandlers);
  const nodes = flatten(panel);
  assert.ok(nodes.some((n) => n.textContent === 'it broke'), 'the failure was not named');
  assert.ok(!nodes.some((n) => n.className === 'tes-nav'), 'an inert nav row was rendered');
  assert.ok(!nodes.some((n) => n.textContent === '⚙ settings'), 'an inert settings button was rendered');
});

// ─── focus registry health ──────────────────────────────────────────────
//
// focusStale/focusUnmapped/focusSelections join the allowlist
// as counts only. The allowlist IS the signature: a field reaching the
// report at all is the claim that it is safe, so these three must never
// carry anything but a number, and the label + value pinned below is what
// would actually catch a regression — a bare /focus/i match would pass on
// the section title alone even if the counts were wrong or missing.

test('the report names the focus registry health with the numbers focusRegistry actually returns', () => {
  const { exports: x } = loadUserscript();
  const row = x.FOCUS_TAXONOMY[0];
  const expectedStale = x.FOCUS_TAXONOMY.filter((r) => r.courseId === row.courseId).length;
  // Every OTHER courseId the taxonomy references gets a course whose
  // outcomes exactly match what is claimed for it, so it contributes zero to
  // both counts — otherwise every taxonomy row whose course is simply absent
  // from this small synthetic map would also read as stale, and the
  // expected count above would not isolate the one row this test controls.
  const outcomesByCourse = new Map();
  for (const r of x.FOCUS_TAXONOMY) {
    if (!outcomesByCourse.has(r.courseId)) outcomesByCourse.set(r.courseId, new Set());
    outcomesByCourse.get(r.courseId).add(r.outcome);
  }
  const courses = new Map();
  for (const [courseId, outcomeSet] of outcomesByCourse) {
    courses.set(courseId, {
      id: courseId, prefix: 'ZZ', name: 'Marker Course A', status: 'available', duration: 1,
      // The chosen row's course loses its claimed outcomes entirely — every
      // taxonomy row sharing its courseId goes stale.
      learningOutcomes: courseId === row.courseId ? [] : Array.from(outcomeSet),
    });
  }
  // This course has an outcome the taxonomy does not account for at all.
  courses.set(999001, {
    id: 999001, prefix: 'ZZ', name: 'Marker Course B', status: 'available', duration: 1,
    learningOutcomes: ['A benefit the taxonomy has never heard of'],
  });
  const reg = x.focusRegistry(courses);
  assert.strictEqual(reg.stale, expectedStale, 'test setup did not actually produce a stale row');
  assert.strictEqual(reg.unmapped, 1, 'test setup did not actually produce an unmapped outcome');

  const settings = x.freshSettings();
  settings.focuses = x.normaliseFocuses([{ category: row.category, selection: row.selection }]);

  const ctx = x.gatherDebugContext({
    fetchResult: { ok: true, source: 'fetch', data: { courses: courses, categories: [], reduction: { constant: true }, activeCourse: null } },
    plan: { queue: [], collapsed: false },
    settings: settings,
  });
  assert.strictEqual(ctx.focusStale, expectedStale);
  assert.strictEqual(ctx.focusUnmapped, 1);
  assert.strictEqual(ctx.focusSelections, 1);

  const report = x.buildDebugReport(ctx);
  assert.match(report, new RegExp(`Stale classifications: ${expectedStale}\\b`), 'the stale count is missing or wrong');
  assert.match(report, /Unmapped outcomes: 1\b/, 'the unmapped count is missing or wrong');
  assert.match(report, /Selections made: 1\b/, 'the selection count is missing or wrong');
});

test('the focus fields carry counts, never course names or outcome text', () => {
  const { exports: x } = loadUserscript();
  // The real fixture's learningOutcomes are riddled with taxonomy phrases
  // ("passive bonus") and working-stat phrases ("upon completion"), and its
  // courses carry real names ("Introduction to Biochemistry"). Running it
  // straight through gatherDebugContext, with no smuggling required, is the
  // adversarial case: if focusStale/focusUnmapped ever became strings built
  // from this data instead of counts, one of these would leak.
  const { exports: xu } = loadUserscript();
  const data = xu.parsePayload(loadFixture());
  const settings = xu.freshSettings();
  const ctx = xu.gatherDebugContext({
    fetchResult: { ok: true, source: 'fetch', data: data },
    plan: { queue: [], collapsed: false },
    settings: settings,
  });
  assert.strictEqual(typeof ctx.focusStale, 'number', 'focusStale was not a count');
  assert.strictEqual(typeof ctx.focusUnmapped, 'number', 'focusUnmapped was not a count');
  assert.strictEqual(typeof ctx.focusSelections, 'number', 'focusSelections was not a count');
  const report = xu.buildDebugReport(ctx);
  assert.ok(!/upon completion/.test(report), 'a working-stat outcome string reached the report');
  assert.ok(!/passive bonus/i.test(report), 'a taxonomy outcome string reached the report');
  assert.ok(!report.includes('Introduction to Biochemistry'), 'a course name reached the report via the focus fields');
});

test('a synthetic course name and outcome string smuggled onto the focus input never reach the report', () => {
  const { exports: x } = loadUserscript();
  const courses = new Map([
    [1, {
      id: 1, prefix: 'ZZ', name: 'SMUGGLED_COURSE_NAME_MARKER', status: 'available', duration: 1,
      learningOutcomes: ['SMUGGLED_OUTCOME_MARKER upon completion'],
    }],
  ]);
  const settings = x.freshSettings();
  const ctx = x.gatherDebugContext({
    fetchResult: { ok: true, source: 'fetch', data: { courses: courses, categories: [], reduction: { constant: true }, activeCourse: null } },
    plan: { queue: [], collapsed: false },
    settings: settings,
  });
  const report = x.buildDebugReport(ctx);
  assert.ok(!report.includes('SMUGGLED_COURSE_NAME_MARKER'), 'a course name reached the report');
  assert.ok(!report.includes('SMUGGLED_OUTCOME_MARKER'), 'an outcome string reached the report');
});

test('absent focus data reads "not recorded" rather than undefined', () => {
  const { exports: x } = loadUserscript();
  const report = x.buildDebugReport({ scriptVersion: '0.2.0' });
  assert.ok(!report.includes('undefined'), 'an absent field rendered as undefined');
  assert.match(report, /Stale classifications: not recorded/);
  assert.match(report, /Unmapped outcomes: not recorded/);
  assert.match(report, /Selections made: not recorded/);
});

test('gatherDebugContext says so when the manager and browser cannot be read', () => {
  const { exports: x } = loadUserscript();
  // Neither navigator nor GM_info exists in the sandbox — the same absence a
  // manager that does not expose GM_info produces. Both are behind typeof
  // guards, so this must be "not recorded", not a ReferenceError.
  const ctx = x.gatherDebugContext({ fetchResult: null, plan: null, settings: null });
  assert.strictEqual(ctx.manager, null);
  assert.strictEqual(ctx.userAgent, null);
  assert.strictEqual(ctx.settings, null);
  const report = x.buildDebugReport(ctx);
  assert.match(report, /Userscript manager: not recorded/);
  assert.match(report, /Browser: not recorded/);
  assert.ok(!report.includes('undefined'), 'an absent field rendered as undefined');
});
