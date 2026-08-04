'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

const constant = (ratio) => ({ ratio, constant: true, ratios: [ratio] });

test('inferPerks decomposes uniquely below 10% and above 30%', () => {
  const { exports: x } = loadUserscript();
  for (const total of [0, 2, 4, 6, 8, 32, 34, 36, 38, 40]) {
    const out = x.inferPerks(constant(1 - total / 100));
    assert.strictEqual(out.determinate, true, `${total}% should be unique but was not`);
    assert.strictEqual(out.totalPercent, total);
    assert.strictEqual(out.candidates, 1);
    assert.strictEqual(
      out.meritsPercent + (out.principal ? 10 : 0) + (out.wsuBlock ? 10 : 0),
      total,
      `${total}% decomposition does not add up`
    );
  }
});

test('inferPerks refuses to guess between 10% and 30%', () => {
  const { exports: x } = loadUserscript();
  for (let total = 10; total <= 30; total += 2) {
    const out = x.inferPerks(constant(1 - total / 100));
    assert.strictEqual(out.determinate, false, `${total}% was reported as determinate`);
    assert.strictEqual(out.reason, 'ambiguous');
    assert.ok(out.candidates >= 3, `${total}% should have 3+ candidates, had ${out.candidates}`);
  }
});

test('inferPerks forces both 10% perks at the top of the range', () => {
  const { exports: x } = loadUserscript();
  // 0.6 is the real fixture's 40% reduction, i.e. 20 + 10 + 10.
  const out = x.inferPerks(constant(0.6));
  assert.strictEqual(out.totalPercent, 40);
  assert.strictEqual(out.determinate, true);
  assert.strictEqual(out.meritsPercent, 20);
  assert.strictEqual(out.principal, true);
  assert.strictEqual(out.wsuBlock, true);
});

test('inferPerks declines when the ratio varies by course', () => {
  const { exports: x } = loadUserscript();
  const out = x.inferPerks({ ratio: null, constant: false, ratios: [0.6, 0.7] });
  assert.strictEqual(out.determinate, false);
  assert.strictEqual(out.reason, 'varies');
});

test('inferPerks declines on a total the perks cannot produce', () => {
  const { exports: x } = loadUserscript();
  const odd = x.inferPerks(constant(0.95)); // 5%, not reachable in 2% merit steps plus 10s
  assert.strictEqual(odd.determinate, false);
  assert.strictEqual(odd.reason, 'unrecognised');
  const tooBig = x.inferPerks(constant(0.1)); // 90%
  assert.strictEqual(tooBig.determinate, false);
  assert.strictEqual(tooBig.reason, 'unrecognised');
});

test('inferPerks handles a missing or malformed reduction without throwing', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(x.inferPerks(null).determinate, false);
  assert.strictEqual(x.inferPerks({}).determinate, false);
});

test('inferPerks does not call a reduction it could not read one that varies', () => {
  const { exports: x } = loadUserscript();
  // "varies" is a claim about the player's account. Only evidence of two or
  // more real ratios earns it; everything else is our failure to read, and
  // saying otherwise states something we have no evidence for.
  for (const unreadable of [
    null,
    undefined,
    {},
    'nonsense',
    { ratio: null, constant: false, ratios: [] },        // every baseDuration <= 0
    { ratio: null, constant: false, ratios: [0.6] },     // one ratio, so nothing varies
    { ratio: 0.6, constant: false, ratios: [0.6] },      // constant not asserted
  ]) {
    const out = x.inferPerks(unreadable);
    assert.strictEqual(out.determinate, false);
    assert.strictEqual(out.reason, 'unreadable', `${JSON.stringify(unreadable)} was reported as varying`);
  }

  // Two genuine ratios is the one case that is really a per-course reduction.
  assert.strictEqual(x.inferPerks({ ratio: null, constant: false, ratios: [0.6, 0.7] }).reason, 'varies');
});

test('inferPerks never lets a NaN ratio become a percentage', () => {
  const { exports: x } = loadUserscript();
  // typeof NaN === 'number', so a typeof guard passes it straight through and
  // the panel ends up printing "Your NaN% reduction".
  const out = x.inferPerks({ ratio: NaN, constant: true, ratios: [NaN] });
  assert.strictEqual(out.determinate, false);
  assert.strictEqual(out.reason, 'unreadable');
  assert.strictEqual(out.totalPercent, null);
  assert.ok(!Number.isNaN(out.totalPercent), 'a NaN total reached the model');

  for (const infinite of [Infinity, -Infinity]) {
    assert.strictEqual(x.inferPerks({ ratio: infinite, constant: true, ratios: [infinite] }).reason, 'unreadable');
  }
});

test('the real fixture infers all three perks', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const out = x.inferPerks(data.reduction);
  assert.strictEqual(out.totalPercent, 40);
  assert.strictEqual(out.determinate, true);
});
