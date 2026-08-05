'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript } = require('./load-userscript');

test('freshSettings returns the documented defaults, and a new object each call', () => {
  const { exports: x } = loadUserscript();
  const a = x.freshSettings();
  const b = x.freshSettings();
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.perks, b.perks, 'perks object is shared between calls');
  assert.strictEqual(a.maxCooldownHours, 24);
  assert.strictEqual(a.booksOwned, 0);
  assert.strictEqual(a.bookPrice, 13500000);
  assert.strictEqual(a.jobPoints, 0);
  assert.strictEqual(a.perks.meritsPercent, null);
  assert.strictEqual(a.perks.principal, null);
  assert.strictEqual(a.perks.wsuBlock, null);
  assert.strictEqual(a.orderMode, 'as-listed');
});

test('normaliseSettings repairs one bad field without discarding the rest', () => {
  const { exports: x } = loadUserscript();
  const out = x.normaliseSettings({
    maxCooldownHours: 48,
    booksOwned: 'not a number',
    bookPrice: 9000000,
    jobPoints: 250,
    perks: { meritsPercent: 20, principal: true, wsuBlock: false },
    orderMode: 'shortest-first',
  });
  assert.strictEqual(out.maxCooldownHours, 48, 'a good field was lost');
  assert.strictEqual(out.booksOwned, 0, 'the bad field did not fall back');
  assert.strictEqual(out.bookPrice, 9000000);
  assert.strictEqual(out.jobPoints, 250);
  assert.strictEqual(out.perks.meritsPercent, 20);
  assert.strictEqual(out.perks.principal, true);
  assert.strictEqual(out.perks.wsuBlock, false);
  assert.strictEqual(out.orderMode, 'shortest-first');
});

test('normaliseSettings rejects out-of-range and nonsense input', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(x.normaliseSettings({ maxCooldownHours: -5 }).maxCooldownHours, 24);
  assert.strictEqual(x.normaliseSettings({ maxCooldownHours: 100000 }).maxCooldownHours, 24);
  assert.strictEqual(x.normaliseSettings({ bookPrice: -1 }).bookPrice, 13500000);
  assert.strictEqual(x.normaliseSettings({ jobPoints: 1.5 }).jobPoints, 0);
  assert.strictEqual(x.normaliseSettings({ orderMode: 'nonsense' }).orderMode, 'as-listed');
  assert.strictEqual(x.normaliseSettings({ perks: { meritsPercent: 21 } }).perks.meritsPercent, null);
  assert.strictEqual(x.normaliseSettings({ perks: { meritsPercent: 7 } }).perks.meritsPercent, null);
  assert.strictEqual(x.normaliseSettings({ perks: 'nope' }).perks.meritsPercent, null);
  assert.strictEqual(x.normaliseSettings(null).bookPrice, 13500000);
  assert.strictEqual(x.normaliseSettings('a string').bookPrice, 13500000);
});

test('settings round-trip through storage and survive corruption', () => {
  const { exports: x, gmStore } = loadUserscript();
  assert.strictEqual(x.loadSettings().bookPrice, 13500000, 'fresh install did not yield defaults');

  const next = x.freshSettings();
  next.booksOwned = 12;
  next.perks.principal = true;
  assert.strictEqual(x.saveSettings(next), true);
  assert.strictEqual(x.loadSettings().booksOwned, 12);
  assert.strictEqual(x.loadSettings().perks.principal, true);

  gmStore.set('tes:settings', '{not json');
  assert.strictEqual(x.loadSettings().booksOwned, 0, 'corrupt storage did not fall back');
});

test('a corrupt settings blob does not disturb the stored plan', () => {
  const { exports: x, gmStore } = loadUserscript();
  x.savePlan({ queue: [34, 38], collapsed: false });
  gmStore.set('tes:settings', '{not json');
  x.loadSettings();
  assert.deepStrictEqual(x.loadPlan().queue, [34, 38], 'the queue was collateral damage');
});

test('a fresh settings object carries an empty focus list', () => {
  const { exports: x } = loadUserscript();
  assert.deepStrictEqual(x.normaliseSettings(null).focuses, []);
});

test('focus order is preserved — it is the lexicographic rank order', () => {
  const { exports: x } = loadUserscript();
  const got = x.normaliseSettings({ focuses: [
    { category: 'Working Stats', selection: 'endurance' },
    { category: 'Passive Stat Bonus', selection: 'Speed' },
  ] }).focuses;
  assert.deepStrictEqual(got.map((f) => f.selection), ['endurance', 'Speed']);
});

test('only one focus per category survives — the first', () => {
  const { exports: x } = loadUserscript();
  const got = x.normaliseSettings({ focuses: [
    { category: 'Working Stats', selection: 'endurance' },
    { category: 'Working Stats', selection: 'intelligence' },
  ] }).focuses;
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].selection, 'endurance');
});

test('an unknown selection is dropped rather than stored', () => {
  const { exports: x } = loadUserscript();
  assert.deepStrictEqual(x.normaliseSettings({ focuses: [{ category: 'Nope', selection: 'Nope' }] }).focuses, []);
});

test('a non-array focuses field falls back to empty', () => {
  const { exports: x } = loadUserscript();
  assert.deepStrictEqual(x.normaliseSettings({ focuses: 'speed' }).focuses, []);
  assert.deepStrictEqual(x.normaliseSettings({ focuses: [null, 7, {}] }).focuses, []);
});

test('each pick takes the next free number, in the order picked', () => {
  const { exports: x } = loadUserscript();
  let f = [];
  f = x.toggleFocus(f, 'Working Stats', 'intelligence');
  f = x.toggleFocus(f, 'Passive Stat Bonus', 'Speed');
  f = x.toggleFocus(f, 'Gym Gain Bonus', 'Strength');
  assert.deepStrictEqual(f.map((e) => e.selection), ['intelligence', 'Speed', 'Strength']);
});

test('dropping a focus closes the gap rather than stranding the ones below it', () => {
  const { exports: x } = loadUserscript();
  let f = [];
  f = x.toggleFocus(f, 'Working Stats', 'intelligence');
  f = x.toggleFocus(f, 'Passive Stat Bonus', 'Speed');
  f = x.toggleFocus(f, 'Gym Gain Bonus', 'Strength');
  f = x.toggleFocus(f, 'Passive Stat Bonus', 'Speed');   // deselect the middle one
  assert.deepStrictEqual(f.map((e) => e.selection), ['intelligence', 'Strength'],
    'Strength must become priority 2, not stay at 3');
});

test('renumbering moves a focus and shifts the rest around it', () => {
  const { exports: x } = loadUserscript();
  let f = [];
  f = x.toggleFocus(f, 'Working Stats', 'intelligence');
  f = x.toggleFocus(f, 'Passive Stat Bonus', 'Speed');
  f = x.toggleFocus(f, 'Gym Gain Bonus', 'Strength');
  f = x.setFocusPriority(f, 'Gym Gain Bonus', 'Strength', 1);
  assert.deepStrictEqual(f.map((e) => e.selection), ['Strength', 'intelligence', 'Speed']);
});

// The brief's own version of this test asserted `new Set(f.map((e, i) => i)).size
// === f.length`, which is true of every array regardless of correctness — array
// indices are unique by construction, so the assertion could never fail. What
// actually needs proving is that moving an entry does not duplicate or drop it,
// and that two categories cannot collapse onto the same slot.
test('two focuses never share a number — moving one does not duplicate or drop an entry', () => {
  const { exports: x } = loadUserscript();
  let f = [];
  f = x.toggleFocus(f, 'Working Stats', 'intelligence');
  f = x.toggleFocus(f, 'Passive Stat Bonus', 'Speed');
  f = x.setFocusPriority(f, 'Passive Stat Bonus', 'Speed', 1);
  assert.strictEqual(f.length, 2, 'moving an entry must not duplicate or drop one');
  const categories = new Set(f.map((e) => e.category));
  assert.strictEqual(categories.size, 2, 'each category must occupy exactly one slot after the move');
  assert.deepStrictEqual(f.map((e) => e.selection), ['Speed', 'intelligence']);
});

// The brief's version used a one-element list, where clamping to any position
// is a no-op and proves nothing beyond "did not throw". A three-element list is
// what actually exercises the clamp in both directions, and pins where the
// clamped move lands rather than only that it survived.
test('an out-of-range or absent priority is clamped rather than throwing', () => {
  const { exports: x } = loadUserscript();
  let f = [];
  f = x.toggleFocus(f, 'Working Stats', 'intelligence');
  f = x.toggleFocus(f, 'Passive Stat Bonus', 'Speed');
  f = x.toggleFocus(f, 'Gym Gain Bonus', 'Strength');

  assert.doesNotThrow(() => x.setFocusPriority(f, 'Nope', 'Nope', 1));
  assert.deepStrictEqual(x.setFocusPriority(f, 'Nope', 'Nope', 1), f, 'an unknown focus is returned untouched');

  const clampedHigh = x.setFocusPriority(f, 'Working Stats', 'intelligence', 99);
  assert.deepStrictEqual(clampedHigh.map((e) => e.selection), ['Speed', 'Strength', 'intelligence'],
    'a position past the end clamps to last, moving the entry there rather than throwing');

  const clampedLow = x.setFocusPriority(f, 'Gym Gain Bonus', 'Strength', 0);
  assert.deepStrictEqual(clampedLow.map((e) => e.selection), ['Strength', 'intelligence', 'Speed'],
    'a position below 1 clamps to first');

  assert.doesNotThrow(() => x.setFocusPriority(f, 'Working Stats', 'intelligence', undefined));
});

test('picking a second focus in a category replaces the first, keeping its number', () => {
  const { exports: x } = loadUserscript();
  let f = [];
  f = x.toggleFocus(f, 'Working Stats', 'intelligence');
  f = x.toggleFocus(f, 'Passive Stat Bonus', 'Speed');
  f = x.toggleFocus(f, 'Working Stats', 'endurance');
  assert.deepStrictEqual(f.map((e) => e.selection), ['endurance', 'Speed'],
    'the category keeps its slot; only which selection fills it changes');
});
