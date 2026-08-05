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

test('a focus set round-trips through the share string, in priority order', () => {
  const { x, courses } = load();
  const settings = x.normaliseSettings({ focuses: [
    { category: 'Working Stats', selection: 'intelligence' },
    { category: 'Passive Stat Bonus', selection: 'Speed' },
  ] });
  const text = x.encodePlan({ queue: [34] }, settings);
  const got = x.decodePlan(text, courses);
  assert.strictEqual(got.ok, true, got.detail);
  // deepStrictEqual on the array checks order as well as membership, which is
  // the point: priority IS the index, so a decoder that round-tripped the
  // right two focuses in the wrong order would still be wrong.
  assert.deepStrictEqual(got.settings.focuses, settings.focuses);
  // And the reverse order is a different plan, not an equal one — guards
  // against a comparison that only checked set membership.
  assert.notDeepStrictEqual(got.settings.focuses, settings.focuses.slice().reverse());
});

test('an unknown selection refuses the whole import', () => {
  const { x, courses } = load();
  const text = x.encodePlan({ queue: [34] }, x.normaliseSettings(null)) + '|f=NopeNope';
  const got = x.decodePlan(text, courses);
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.reason, 'unknown-focus');
});

test('a focus set with a genuine selection alongside an unknown one refuses too, not partially', () => {
  const { x, courses } = load();
  const text = x.encodePlan({ queue: [34] }, x.normaliseSettings(null)) + '|f=Working Statsintelligence,NopeNope';
  const got = x.decodePlan(text, courses);
  assert.strictEqual(got.ok, false, 'a mix of one good and one bad focus imported partially');
});

test('a share string with no focus field imports with an empty focus set', () => {
  const { x, courses } = load();
  const got = x.decodePlan(x.encodePlan({ queue: [34] }, x.normaliseSettings(null)), courses);
  assert.strictEqual(got.ok, true);
  assert.deepStrictEqual(got.settings.focuses, []);
});

test('a focus field full of separators never throws', () => {
  const { x, courses } = load();
  assert.doesNotThrow(() => x.decodePlan('TES1|q=34|f=,,,', courses));
});

test('FOCUS_CONCAT_INDEX has no collisions across the whole focus taxonomy', () => {
  // decodePlan's f= field concatenates category and selection with no
  // separator between them, and splits back only by matching the result
  // against this index. If two distinct (category, selection) pairs ever
  // concatenated to the same token, decodePlan would silently resolve one to
  // the other and import a focus the player did not paste — computed here
  // from FOCUS_TAXONOMY and WORKING_STATS rather than hardcoded, so this
  // fails loudly on a genuine collision instead of drifting with the sheet.
  const { x } = load();
  const distinctPairs = new Set(x.FOCUS_TAXONOMY.map((row) => `${row.category} ${row.selection}`));
  const expected = distinctPairs.size + x.WORKING_STATS.length;
  assert.strictEqual(
    x.FOCUS_CONCAT_INDEX.size,
    expected,
    'a (category, selection) pair collided with another once concatenated',
  );
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
  assert.strictEqual(out.settings.orderMode, 'focus');
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
  assert.strictEqual(bare.settings.orderMode, 'focus');
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

test('the offending token is quoted back bounded and printable, never whole', () => {
  const { x, courses } = load();
  // The detail becomes importError and renders on the panel. It is the only
  // part of a pasted string that gets quoted back, so it is the only part that
  // needs sizing — the habit gatherDebugContext already established for Torn's
  // own error string, which comes from a *less* hostile source than this.
  const long = x.decodePlan(`TES1|q=${'A'.repeat(1000000)}`, courses);
  assert.strictEqual(long.reason, 'bad-course-id');
  assert.ok(long.detail.length < 120, `a 1,000,000-character token produced a ${long.detail.length}-character detail`);
  assert.match(long.detail, /truncated, 1000000 chars/, 'the truncation is not marked');
  // A short token is quoted whole, with no truncation noise.
  const short = x.decodePlan('TES1|q=abc', courses);
  assert.match(short.detail, /"abc" is not a course id/);
  assert.ok(!/truncated/.test(short.detail), 'a short token was reported as truncated');

  // Invisible characters are replaced rather than echoed. A bidi override
  // reverses the display of everything after it on the line it lands in, so an
  // error message carrying one can be made to read as something else — and
  // since the player could never have seen the character in their paste,
  // removing it costs them nothing.
  const bidi = x.decodePlan('TES1|q=' + '\u202E' + 'abc', courses);
  assert.ok(!bidi.detail.includes('\u202E'), 'a bidi override reached the panel');
  assert.match(bidi.detail, /\uFFFDabc/, 'the replacement did not preserve the rest of the token');
  for (const ch of ['\u0000', '\u001B', '\u009F', '\u200B', '\u200E', '\u2066', '\uFEFF']) {
    const out = x.decodePlan(`TES1|q=${ch}9`, courses);
    assert.strictEqual(out.reason, 'bad-course-id');
    assert.ok(!out.detail.includes(ch), `${JSON.stringify(ch)} reached the panel`);
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
  // The decoded settings are exactly normaliseSettings' seven-key shape: nothing
  // from the string reached the object by name.
  assert.deepStrictEqual(
    Object.keys(out.settings).sort(),
    ['bookPrice', 'booksOwned', 'focuses', 'jobPoints', 'maxCooldownHours', 'orderMode', 'perks'],
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
    .filter((el) => el.className === 'tes-queue-row')
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

test('a share/import round trip under a non-default order mode leaves the stored queue byte-identical', async () => {
  // Ordering is a display preference; storage keeps the raw order. The share
  // box is pre-filled and one click hands its value to onImportPlan, so if
  // the box were ever built from the *ordered* queue, the display order
  // would get written back to storage on the very first click — with no
  // bulk undo. shortest-first genuinely reorders these four (all children of
  // course 34, which is not in the queue, so they are mutually unconstrained
  // and sort purely on duration): 39 (725760s) < 38 == 41 (1088640s, original
  // order breaks the tie) < 40 (1451520s).
  const { doc, gmStore, exports } = await initWithFixture(
    { orderMode: 'shortest-first' },
    { queue: [38, 39, 40, 41], collapsed: false }
  );

  // Already on the schedule view (init()'s default) — openView('schedule')
  // would find no nav button for the view already on screen.
  assert.deepStrictEqual(
    renderedQueueIds(doc),
    [39, 38, 41, 40],
    'shortest-first did not reorder the rendered queue — this test would not catch the regression'
  );

  const settings = openView(doc, 'settings');
  const box = shareBox(settings);
  assert.match(
    box.value,
    /(^|\|)q=38,39,40,41(\||$)/,
    `share box held the display order instead of the stored order: ${box.value}`
  );

  fire(importButton(settings), 'click');

  assert.deepStrictEqual(
    JSON.parse(gmStore.get(exports.STORAGE_KEY)).queue,
    [38, 39, 40, 41],
    'a share/import round trip reordered the stored queue'
  );
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

test('with no course data there is nothing to check a plan against, and the panel says so', async () => {
  // The branch a reachable-but-unasserted path always is. The settings view is
  // reachable on an acquisition failure — that was itself a regression this
  // release fixed — so the share box is on screen with no catalogue behind it,
  // and clicking import has to report that rather than throw, blank the panel,
  // or accept a plan it cannot validate a single id of.
  const doc = makeFakeDocument();
  const { exports: x } = loadUserscript({
    location: { search: '' },
    document: doc,
    // No session cookie on the document and a 403 if one were found, so the
    // fetch path fails; the fake document exposes no React internals, so the
    // fiber path fails too.
    fetch: async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }),
  });
  await x.init();

  const settings = openView(doc, 'settings');
  const box = shareBox(settings);
  assert.ok(box, 'the share box is unreachable in the state the settings view exists for');
  assert.strictEqual(box.value, '', 'a share string was offered for a plan the panel could not build');

  const btn = importButton(settings);
  assert.ok(btn, 'the import button is unreachable on a failed acquisition');
  assert.doesNotThrow(() => fire(btn, 'click'), 'importing with no catalogue threw');

  const after = panelBody(doc);
  const message = descendants(after).find((el) => /No course data loaded/.test(el.textContent || ''));
  assert.ok(message, 'importing with no catalogue said nothing at all');
  // And the failure line is still there: the panel did not lose its own state
  // reporting this one.
  assert.ok(
    descendants(after).some((el) => /Couldn't load your education data/.test(el.textContent || '')) ||
      descendants(doc.querySelector('#tes-panel')).some((el) => /Couldn't load your education data/.test(el.textContent || '')),
    'the acquisition failure stopped being reported',
  );
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
