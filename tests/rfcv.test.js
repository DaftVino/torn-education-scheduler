'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript } = require('./load-userscript');

// readRfcvToken gets its own file rather than living in payload.test.js —
// it is cookie-string parsing, unrelated to the education payload shape,
// and payload.test.js is already dense with fixture-driven cases.

function readRfcvToken(cookieString) {
  const { exports } = loadUserscript();
  return exports.readRfcvToken(cookieString);
}

test('extracts the token from rfc_v', () => {
  assert.strictEqual(readRfcvToken('rfc_v=abc123def4567'), 'abc123def4567');
});

test('falls back to rfc_id when only that is present', () => {
  assert.strictEqual(readRfcvToken('rfc_id=zzz9988776655'), 'zzz9988776655');
});

test('prefers rfc_v when both are present with different values', () => {
  assert.strictEqual(
    readRfcvToken('rfc_id=1111111111111; rfc_v=2222222222222'),
    '2222222222222'
  );
});

test('returns null for an empty string', () => {
  assert.strictEqual(readRfcvToken(''), null);
});

test('returns null for a cookie jar without either name', () => {
  assert.strictEqual(readRfcvToken('foo=bar; baz=qux'), null);
});

test('returns null for rfc_v with an empty value', () => {
  assert.strictEqual(readRfcvToken('rfc_v=;'), null);
});

test('returns null for rfc_v with an empty value even when rfc_id is also absent', () => {
  assert.strictEqual(readRfcvToken('rfc_v='), null);
});

test('falls back to rfc_id when rfc_v is present but empty', () => {
  assert.strictEqual(readRfcvToken('rfc_v=; rfc_id=abc123def4567'), 'abc123def4567');
});

test('is not fooled by a cookie named xrfc_v', () => {
  assert.strictEqual(readRfcvToken('xrfc_v=abc123def4567'), null);
});

test('is not fooled by a cookie named rfc_value', () => {
  assert.strictEqual(readRfcvToken('rfc_value=abc123def4567'), null);
});

test('is not fooled by xrfc_v or rfc_value even alongside the real cookie', () => {
  assert.strictEqual(
    readRfcvToken('xrfc_v=wrong0000000; rfc_value=wrong1111111; rfc_v=abc123def4567'),
    'abc123def4567'
  );
});

test('copes with surrounding whitespace around names and values', () => {
  assert.strictEqual(readRfcvToken('  rfc_v = abc123def4567 ; other=1'), 'abc123def4567');
});

test('copes with many unrelated cookies around it', () => {
  const jar = [
    'session=abcdef123456',
    'theme=dark',
    'locale=en-US',
    'rfc_v=abc123def4567',
    'analytics_id=99999999',
    'consent=true',
  ].join('; ');
  assert.strictEqual(readRfcvToken(jar), 'abc123def4567');
});

test('handles a value that itself contains an equals sign', () => {
  assert.strictEqual(readRfcvToken('rfc_v=abc123=def45'), 'abc123=def45');
});
