'use strict';
process.env.TZ = 'Australia/Sydney';   // UTC+10/+11 — crosses the date line for an evening UTC time

const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript } = require('./load-userscript');

test('dates and times are identical under a non-UTC local zone', () => {
  const { exports: x } = loadUserscript();
  const t = Date.UTC(2026, 7, 4, 21, 0, 0) / 1000;
  assert.strictEqual(x.formatDate(t), '2026-08-04',
    'a local getter would report 2026-08-05 here — the date, not just the hour');
  assert.strictEqual(x.formatTime(t), '21:00');
});

test('the harness honours a TZ the test set', () => {
  assert.strictEqual(process.env.TZ, 'Australia/Sydney',
    'if this fails, load-userscript.js is overwriting TZ and the test above proves nothing');
});
