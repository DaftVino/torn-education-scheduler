'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');
const { makeFakeDocument } = require('./fake-document');

function load() {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  return { x, courses: data.courses };
}

test('a plan round-trips through encode and decode', () => {
  const { x, courses } = load();
  const settings = x.freshSettings();
  settings.maxCooldownHours = 48;
  settings.booksOwned = 12;
  settings.bookPrice = 9000000;
  settings.jobPoints = 250;
  settings.perks.meritsPercent = 20;
  settings.perks.principal = true;
  settings.perks.wsuBlock = false;
  settings.orderMode = 'shortest-first';

  const text = x.encodePlan({ queue: [34, 38, 39] }, settings);
  assert.ok(text.indexOf('TES1|') === 0, `unexpected prefix in ${text}`);

  const out = x.decodePlan(text, courses);
  assert.strictEqual(out.ok, true, out.detail);
  assert.deepStrictEqual(out.queue, [34, 38, 39]);
  assert.strictEqual(out.settings.maxCooldownHours, 48);
  assert.strictEqual(out.settings.booksOwned, 12);
  assert.strictEqual(out.settings.bookPrice, 9000000);
  assert.strictEqual(out.settings.jobPoints, 250);
  assert.strictEqual(out.settings.perks.meritsPercent, 20);
  assert.strictEqual(out.settings.perks.principal, true);
  assert.strictEqual(out.settings.perks.wsuBlock, false);
  assert.strictEqual(out.settings.orderMode, 'shortest-first');
});

test('an empty queue round-trips', () => {
  const { x, courses } = load();
  const out = x.decodePlan(x.encodePlan({ queue: [] }, x.freshSettings()), courses);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.queue, []);
});

test('decodePlan rejects an unknown course id by name', () => {
  const { x, courses } = load();
  const out = x.decodePlan('TES1|q=34,999999|c=24', courses);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unknown-course');
  assert.ok(out.detail.includes('999999'), 'the offending id is not named');
});

test('decodePlan rejects a wrong or missing version prefix', () => {
  const { x, courses } = load();
  assert.strictEqual(x.decodePlan('TES9|q=34', courses).reason, 'bad-prefix');
  assert.strictEqual(x.decodePlan('q=34', courses).reason, 'bad-prefix');
  assert.strictEqual(x.decodePlan('', courses).reason, 'bad-prefix');
  assert.strictEqual(x.decodePlan(null, courses).reason, 'bad-prefix');
  assert.strictEqual(x.decodePlan(42, courses).reason, 'bad-prefix');
});

test('decodePlan rejects non-numeric ids rather than coercing them', () => {
  const { x, courses } = load();
  const out = x.decodePlan('TES1|q=34,abc', courses);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'bad-course-id');
});

test('decodePlan treats untrusted settings as untrusted', () => {
  const { x, courses } = load();
  // Nonsense settings fall back to defaults; they never reach storage as-is.
  const out = x.decodePlan('TES1|q=34|c=-99|p=abc|o=drop-tables|m=7', courses);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.settings.maxCooldownHours, 24);
  assert.strictEqual(out.settings.bookPrice, 13500000);
  assert.strictEqual(out.settings.orderMode, 'as-listed');
  assert.strictEqual(out.settings.perks.meritsPercent, null);
});

test('decodePlan is not fooled by markup, prototype keys, or a code-shaped payload', () => {
  const { x, courses } = load();
  for (const hostile of [
    'TES1|q=34|__proto__=polluted',
    'TES1|q=34|constructor=x',
    'TES1|q=<script>alert(1)</script>',
    'TES1|q=34|o=as-listed|x=' + '9'.repeat(10000),
  ]) {
    const out = x.decodePlan(hostile, courses);
    // Either a clean rejection or a clean parse — never a throw, and never a
    // polluted object.
    assert.ok(out.ok === true || typeof out.reason === 'string');
    if (out.ok) assert.deepStrictEqual(out.queue.filter((id) => !courses.has(id)), []);
  }
  assert.strictEqual({}.polluted, undefined, 'the prototype was polluted');
});

test('decodePlan tolerates surrounding whitespace, as a paste will carry', () => {
  const { x, courses } = load();
  const out = x.decodePlan('  \n TES1|q=34,38 \n ', courses);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.queue, [34, 38]);
});

test('a duplicated id in the string survives as a single queue entry', () => {
  const { x, courses } = load();
  const out = x.decodePlan('TES1|q=34,34,38', courses);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.queue, [34, 38]);
});

// ─── The regimes a well-formed example never visits ──────────────────
//
// Every case above descends from a string this file produced. Task 9 in this
// release put both of its bugs in the regime its one worked example could not
// reach, so the parser is attacked here on purpose: strings with no delimiter,
// with only the prefix, with a key and no value, with a value and no key, with
// the same key twice, and with ids shaped like numbers a coercing parser would
// have accepted.

test('the prefix alone is a valid, empty plan — and anything else without a delimiter is not', () => {
  const { x, courses } = load();
  const bare = x.decodePlan('TES1', courses);
  assert.strictEqual(bare.ok, true, 'the prefix on its own is a plan with nothing in it');
  assert.deepStrictEqual(bare.queue, []);
  assert.strictEqual(bare.settings.orderMode, 'as-listed');
  // No pipe and not the prefix: there is nothing here to parse.
  assert.strictEqual(x.decodePlan('hello', courses).reason, 'bad-prefix');
  assert.strictEqual(x.decodePlan('   ', courses).reason, 'bad-prefix');
  assert.strictEqual(x.decodePlan('|q=34', courses).reason, 'bad-prefix');
  // The prefix must be the whole first field, not a leading substring of it.
  assert.strictEqual(x.decodePlan('TES10|q=34', courses).reason, 'bad-prefix');
  assert.strictEqual(x.decodePlan('xTES1|q=34', courses).reason, 'bad-prefix');
});

test('a malformed field is ignored rather than half-read', () => {
  const { x, courses } = load();
  // A key with no `=`, a value with no key, and an empty field: none of them
  // may become a setting, and none may stop the fields around them parsing.
  const out = x.decodePlan('TES1||nonsense|=48|q=34|c=48', courses);
  assert.strictEqual(out.ok, true, out.detail);
  assert.deepStrictEqual(out.queue, [34]);
  assert.strictEqual(out.settings.maxCooldownHours, 48, 'a good field was lost to a bad neighbour');
  // `=48` must not have been read as a cooldown by the key-less route.
  assert.strictEqual(x.decodePlan('TES1|=48', courses).settings.maxCooldownHours, 24);
});

test('a repeated key resolves to its last occurrence, deterministically', () => {
  const { x, courses } = load();
  // Not a case a real share string produces — but a hand-edited one does, and
  // the answer has to be one answer rather than whichever the loop reaches.
  assert.strictEqual(x.decodePlan('TES1|c=48|c=12', courses).settings.maxCooldownHours, 12);
  assert.deepStrictEqual(x.decodePlan('TES1|q=34|q=38', courses).queue, [38]);
  assert.deepStrictEqual(x.decodePlan('TES1|q=34|q=', courses).queue, [], 'the later empty queue did not win');
});

test('an empty or comma-only queue field is empty rather than a queue of nothings', () => {
  const { x, courses } = load();
  assert.deepStrictEqual(x.decodePlan('TES1|q=', courses).queue, []);
  // A comma with no id either side is not an id. It must be named as a bad
  // course id, not silently dropped and not coerced to 0.
  for (const text of ['TES1|q=,', 'TES1|q=,,,', 'TES1|q=34,', 'TES1|q=,34']) {
    const out = x.decodePlan(text, courses);
    assert.strictEqual(out.ok, false, `${text} parsed as a plan`);
    assert.strictEqual(out.reason, 'bad-course-id');
  }
});

test('an id shaped like a number a coercing parser would take is judged on its digits', () => {
  const { x, courses } = load();
  // Leading zeros are digits, so `034` is course 34 — validated against the
  // catalogue like any other id, and normalised to the integer the queue holds.
  assert.deepStrictEqual(x.decodePlan('TES1|q=034', courses).queue, [34]);
  // Everything Number() would happily accept and the catalogue never produces.
  // `q=` on its own is the empty queue, tested above; every token here is a
  // claim to be an id that a coercing parser would have honoured.
  for (const token of ['+34', '-34', '34.0', ' 34', '3 4', '0x22', '3e1', 'Infinity']) {
    const out = x.decodePlan(`TES1|q=${token}`, courses);
    assert.strictEqual(out.ok, false, `"${token}" was accepted as a course id`);
    assert.strictEqual(out.reason, 'bad-course-id', `"${token}" was rejected for the wrong reason`);
  }
});

test('an id that is all digits but astronomically large is rejected by the catalogue', () => {
  const { x, courses } = load();
  const out = x.decodePlan(`TES1|q=${'9'.repeat(500)}`, courses);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unknown-course');
});

test('unrecognised keys are ignored, never stored', () => {
  const { x, courses } = load();
  const out = x.decodePlan('TES1|q=34|zzz=hello|__proto__=polluted|perks=x|toString=x', courses);
  assert.strictEqual(out.ok, true, out.detail);
  // The decoded settings are exactly normaliseSettings' six-key shape: nothing
  // from the string reached the object by name.
  assert.deepStrictEqual(
    Object.keys(out.settings).sort(),
    ['bookPrice', 'booksOwned', 'jobPoints', 'maxCooldownHours', 'orderMode', 'perks'],
  );
  assert.deepStrictEqual(Object.keys(out.settings.perks).sort(), ['meritsPercent', 'principal', 'wsuBlock']);
  assert.strictEqual({}.polluted, undefined, 'the prototype was polluted');
  assert.strictEqual(Object.prototype.polluted, undefined, 'the prototype was polluted');
});

test('settings that are individually valid but jointly absurd decode to exactly what was asked for', () => {
  const { x, courses } = load();
  // Every one of these is inside its own bound, and together they describe a
  // player with a year-long booster cooldown, 100,000 Books and a trillion
  // dollars each. There is no cross-field rule to catch it, so the decoder must
  // not pretend there is: it stores what it was told, and the arithmetic
  // downstream is expected to survive it. (The end-to-end half of this claim is
  // the render test at the bottom of this file.)
  const out = x.decodePlan('TES1|q=63|c=8760|b=100000|p=1000000000000|j=1000000|m=20|pr=1|w=1|o=unlocks-first', courses);
  assert.strictEqual(out.ok, true, out.detail);
  assert.strictEqual(out.settings.maxCooldownHours, 8760);
  assert.strictEqual(out.settings.booksOwned, 100000);
  assert.strictEqual(out.settings.bookPrice, 1000000000000);
  assert.strictEqual(out.settings.jobPoints, 1000000);
  assert.strictEqual(out.settings.orderMode, 'unlocks-first');
  // One past each bound falls back to the default, per field.
  const past = x.decodePlan('TES1|c=8761|b=100001|p=1000000000001|j=1000001|m=22', courses);
  assert.strictEqual(past.settings.maxCooldownHours, 24);
  assert.strictEqual(past.settings.booksOwned, 0);
  assert.strictEqual(past.settings.bookPrice, 13500000);
  assert.strictEqual(past.settings.jobPoints, 0);
  assert.strictEqual(past.settings.perks.meritsPercent, null);
});

test('a perk flag is 1 or 0 and nothing else, so an unreadable one stays unanswered', () => {
  const { x, courses } = load();
  const out = x.decodePlan('TES1|pr=true|w=yes', courses);
  assert.strictEqual(out.settings.perks.principal, null, '"true" was read as an answer');
  assert.strictEqual(out.settings.perks.wsuBlock, null, '"yes" was read as an answer');
  // And the two real values survive, including the false that is not an absence.
  const real = x.decodePlan('TES1|pr=0|w=1', courses);
  assert.strictEqual(real.settings.perks.principal, false);
  assert.strictEqual(real.settings.perks.wsuBlock, true);
});

test('decodePlan never throws, whatever it is handed', () => {
  const { x, courses } = load();
  // The contract the panel depends on: a throw here reaches init()'s catch and
  // blanks the view, which is a worse outcome than any rejection.
  const battery = [
    '', ' ', '\n', '|', '||||', 'TES1', 'TES1|', 'TES1||', 'TES1|=34', 'TES1|nonsense',
    'TES1|q', 'TES1|q=', 'TES1|q=,,,', 'TES1|q=+34', 'TES1|q=034', 'TES1|q=34\n|c=24',
    'TES1|q=' + '9'.repeat(500), 'TES1|' + 'a=1|'.repeat(5000), 'TES1|q=' + '1,'.repeat(5000),
    'TES1|__proto__=x', 'TES1|constructor=x', 'TES1|prototype=x', 'TES1|toString=x',
    'TES1|c=' + '9'.repeat(400), 'TES1|o=' + '\u0000', 'TES1|q=34|x=' + '9'.repeat(10000),
    'TES1|q=34|o=' + '\u202E'.repeat(50),
  ];
  for (const text of battery) {
    let out = null;
    assert.doesNotThrow(() => { out = x.decodePlan(text, courses); }, `threw on ${JSON.stringify(text).slice(0, 60)}`);
    assert.ok(out && (out.ok === true || typeof out.reason === 'string'), `no verdict for ${JSON.stringify(text).slice(0, 60)}`);
    if (out.ok) for (const id of out.queue) assert.ok(courses.has(id), `${id} is not in the catalogue`);
  }
  // A catalogue that is missing, or is not one, is a caller bug — and still not
  // a throw, because this function's whole job is to be safe to call.
  for (const catalogue of [null, undefined, {}, [], 'courses', new Map()]) {
    let out = null;
    assert.doesNotThrow(() => { out = x.decodePlan('TES1|q=34', catalogue); }, `threw on catalogue ${String(catalogue)}`);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'unknown-course');
  }
  assert.strictEqual({}.polluted, undefined, 'the prototype was polluted');
});

test('encodePlan drops anything in the queue that is not an integer id', () => {
  const { x, courses } = load();
  const text = x.encodePlan({ queue: [34, '38', null, undefined, NaN, 1.5, 39] }, x.freshSettings());
  assert.deepStrictEqual(x.decodePlan(text, courses).queue, [34, 39]);
  // A missing or malformed plan is an empty queue, not a throw.
  for (const plan of [null, undefined, {}, { queue: 'nope' }, []]) {
    assert.deepStrictEqual(x.decodePlan(x.encodePlan(plan, null), courses).queue, []);
  }
  assert.strictEqual(x.SHARE_PREFIX, 'TES1');
});

// ─── The wiring ──────────────────────────────────────────────────────
//
// Task 10 shipped an ordering control that reached no queue, and the whole
// suite stayed green because every test called the pure function directly.
// These tests click the button.

function descendants(el) {
  const out = [];
  (function walk(node) {
    out.push(node);
    for (const child of (node.children || [])) walk(child);
  })(el);
  return out;
}

const fire = (el, type) => { for (const fn of (el.listeners[type] || [])) fn(); };

async function initWithFixture(seedSettings, seedPlan) {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const loaded = loadUserscript({
    location: { search: '' }, // keeps the bootstrap from auto-running init()
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  if (seedSettings !== undefined) loaded.gmStore.set(loaded.exports.SETTINGS_KEY, JSON.stringify(seedSettings));
  // Seeded before init(), because loadPlan() runs inside it.
  if (seedPlan !== undefined) loaded.gmStore.set(loaded.exports.STORAGE_KEY, JSON.stringify(seedPlan));
  await loaded.exports.init();
  return { ...loaded, doc: doc };
}

// The panel body, which is the second child of the panel whenever it is open.
const panelBody = (doc) => doc.querySelector('#tes-panel').children[1];

// Clicks the nav button for a view and returns the redrawn body.
function openView(doc, name) {
  const nav = panelBody(doc).children.find((c) => c.className === 'tes-nav');
  const btn = nav.children.find((b) => b.textContent.includes(name));
  assert.ok(btn, `no nav button for the ${name} view`);
  fire(btn, 'click');
  return panelBody(doc);
}

const shareBox = (body) => descendants(body).find((el) => el.className === 'tes-share');
const importButton = (body) => descendants(body).find((el) => /import/i.test(el.textContent) && el.listeners.click);

function renderedQueueIds(doc) {
  return descendants(panelBody(doc))
    .filter((el) => el.className === 'tes-row')
    .map((row) => (row.children || []).find((c) => c.dataset && c.dataset.courseId !== undefined))
    .filter(Boolean)
    .map((btn) => Number(btn.dataset.courseId));
}

// The rendered queue lives in the schedule view, so reading it after an
// import means switching back to it first.
const scheduleQueueIds = (doc) => { openView(doc, 'schedule'); return renderedQueueIds(doc); };

test('the share box carries the plan the panel is showing', async () => {
  const { doc } = await initWithFixture({ orderMode: 'as-listed', maxCooldownHours: 48 }, { queue: [1, 63], collapsed: false });
  const box = shareBox(openView(doc, 'settings'));
  assert.ok(box, 'the settings view renders no share box');
  assert.ok(box.value.startsWith('TES1|'), `the share box does not hold a share string: ${box.value}`);
  assert.match(box.value, /(^|\|)q=1,63(\||$)/, `the current queue is not in the share string: ${box.value}`);
  assert.match(box.value, /(^|\|)c=48(\||$)/, `the current settings are not in the share string: ${box.value}`);
});

test('importing a plan changes the queue the panel renders', async () => {
  // The wiring assertion. Every test above this line calls decodePlan
  // directly, so deleting the handler would leave all of them green.
  const { doc, gmStore, exports } = await initWithFixture({ orderMode: 'as-listed' }, { queue: [1], collapsed: false });
  const body = openView(doc, 'settings');
  assert.deepStrictEqual(scheduleQueueIds(doc), [1], 'the seeded plan did not render');

  const settings = openView(doc, 'settings');
  shareBox(settings).value = 'TES1|q=63,112|c=48|b=7|p=9000000|j=250|o=as-listed|m=20|pr=1|w=0';
  fire(importButton(settings), 'click');

  assert.deepStrictEqual(scheduleQueueIds(doc), [63, 112], 'the imported queue never reached the panel');
  assert.deepStrictEqual(JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue, [63, 112], 'the imported queue was not stored');
  const stored = JSON.parse(gmStore.get(exports.SETTINGS_KEY));
  assert.strictEqual(stored.maxCooldownHours, 48, 'the imported settings were not stored');
  assert.strictEqual(stored.booksOwned, 7);
  assert.strictEqual(stored.perks.principal, true);
  assert.strictEqual(stored.perks.wsuBlock, false, 'an imported false was lost');
  assert.ok(body, 'the settings body was never built');
});

test('a rejected import leaves the existing plan alone and says why on screen', async () => {
  const { doc, gmStore, exports } = await initWithFixture(undefined, { queue: [1], collapsed: false });
  const settingsBefore = gmStore.get(exports.SETTINGS_KEY);
  const settings = openView(doc, 'settings');
  shareBox(settings).value = 'TES1|q=63,999999';
  fire(importButton(settings), 'click');

  const after = panelBody(doc);
  const error = descendants(after).find((el) => el.className === 'tes-save-error' && /import/i.test(el.textContent));
  assert.ok(error, 'a rejected import said nothing on screen');
  assert.match(error.textContent, /unknown-course/, 'the reason is not on screen');
  assert.match(error.textContent, /999999/, 'the offending id is not on screen');

  assert.deepStrictEqual(JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue, [1], 'a rejected import edited the stored plan');
  assert.strictEqual(gmStore.get(exports.SETTINGS_KEY), settingsBefore, 'a rejected import wrote settings');
  assert.deepStrictEqual(scheduleQueueIds(doc), [1], 'a rejected import changed the rendered queue');
});

test('an import that is refused and then corrected clears the error', async () => {
  const { doc } = await initWithFixture(undefined, { queue: [1], collapsed: false });
  const settings = openView(doc, 'settings');
  shareBox(settings).value = 'not a plan at all';
  fire(importButton(settings), 'click');
  const failed = panelBody(doc);
  assert.ok(descendants(failed).find((el) => /bad-prefix/.test(el.textContent || '')), 'the prefix failure is not on screen');

  shareBox(failed).value = 'TES1|q=63';
  fire(importButton(failed), 'click');
  const fixed = panelBody(doc);
  assert.ok(
    !descendants(fixed).find((el) => el.className === 'tes-save-error' && /import/i.test(el.textContent)),
    'the import error survived a successful import',
  );
  assert.deepStrictEqual(scheduleQueueIds(doc), [63]);
});

test('a plan whose settings are jointly absurd imports without taking the panel down', async () => {
  // The regime the round-trip tests cannot reach: every field inside its bound
  // and the combination nonsense — a year of booster cooldown, 100,000 Books at
  // a trillion dollars each. The panel has to render a plan, not an error.
  const { doc } = await initWithFixture(undefined, { queue: [1], collapsed: false });
  const settings = openView(doc, 'settings');
  shareBox(settings).value = 'TES1|q=63|c=8760|b=100000|p=1000000000000|j=1000000|m=20|pr=1|w=1|o=unlocks-first';
  fire(importButton(settings), 'click');

  const schedule = openView(doc, 'schedule');
  assert.deepStrictEqual(renderedQueueIds(doc), [63], 'the absurd-but-valid plan did not render');
  const failure = descendants(schedule).find((el) => el.className === 'tes-error');
  assert.ok(!failure, `the panel fell over: ${failure && failure.textContent}`);
  const finish = descendants(schedule).find((el) => el.className === 'tes-finish');
  assert.ok(finish && finish.textContent.length > 0, 'no finish line survived the import');
});

test('an imported plan never reaches the panel as markup', async () => {
  const { doc } = await initWithFixture(undefined, { queue: [1], collapsed: false });
  const settings = openView(doc, 'settings');
  shareBox(settings).value = 'TES1|q=<img src=x onerror=alert(1)>|o=<script>';
  fire(importButton(settings), 'click');
  const after = panelBody(doc);
  // Refused, and the refusal is text — nothing on the panel ever holds markup,
  // because nothing in this script writes innerHTML.
  const error = descendants(after).find((el) => el.className === 'tes-save-error' && /import/i.test(el.textContent));
  assert.ok(error, 'the markup-shaped plan was not refused visibly');
  assert.ok(!descendants(after).some((el) => 'innerHTML' in el), 'something in the render path set innerHTML');
});
