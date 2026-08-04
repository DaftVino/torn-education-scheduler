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
