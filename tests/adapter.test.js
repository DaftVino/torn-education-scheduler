'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

const COOKIE = 'rfc_v=abc123def4567';
const RFCV_VALUE = 'abc123def4567';

function fetchReturning(body, init) {
  const status = (init && init.status) || 200;
  return async () => ({
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test('a good response parses into the engine shape', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(fetchReturning(loadFixture()), COOKIE);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.courses.size, 131);
});

test('it requests the declared endpoint, same-origin', async () => {
  const { exports } = loadUserscript();
  const seen = [];
  await exports.fetchEducationData(async (url, opts) => {
    seen.push({ url, opts });
    return { ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) };
  }, COOKIE);
  assert.strictEqual(seen[0].url, '/page.php?sid=educationInitData&rfcv=abc123def4567');
  assert.strictEqual(seen[0].opts.credentials, 'same-origin');
});

// Regression guard: a future edit that drops the rfcv append must fail this
// test, in Node, before it ever reaches a live browser session.
test('the request URL carries an rfcv parameter derived from the token', async () => {
  const { exports } = loadUserscript();
  const seen = [];
  await exports.fetchEducationData(async (url, opts) => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) };
  }, 'rfc_v=zzz9988776655');
  assert.strictEqual(seen.length, 1);
  const url = new URL(seen[0], 'https://www.torn.com');
  assert.strictEqual(url.searchParams.get('rfcv'), 'zzz9988776655');
});

test('with no token available, it resolves no-session-token and never calls fetch', async () => {
  const { exports } = loadUserscript();
  let called = false;
  const result = await exports.fetchEducationData(async () => { called = true; }, 'unrelated=1; other=2');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no-session-token');
  assert.strictEqual(called, false, 'fetch must not be invoked when no token is available');
});

test('with an empty cookie string, it resolves no-session-token and never calls fetch', async () => {
  const { exports } = loadUserscript();
  let called = false;
  const result = await exports.fetchEducationData(async () => { called = true; }, '');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no-session-token');
  assert.strictEqual(called, false, 'fetch must not be invoked when no token is available');
});

test('a network error is reported, not thrown', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(async () => { throw new Error('offline'); }, COOKIE);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'network');
  assert.match(result.detail, /offline/);
});

test('a non-200 response is reported with its status', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(fetchReturning('', { status: 503 }), COOKIE);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'http');
  assert.match(result.detail, /503/);
});

test('an HTML login page instead of JSON is reported as not-json', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(fetchReturning('<!doctype html><html>...'), COOKIE);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not-json');
});

test('a payload the parser rejects surfaces the parser reason', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(fetchReturning({ success: false }), COOKIE);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not-a-payload');
});

test('the live QA failure — wrong rfcv token — surfaces Torn\'s own message', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(
    fetchReturning({ success: false, error: 'Wrong rfcv token' }), COOKIE
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not-a-payload');
  assert.match(result.detail, /Wrong rfcv token/);
});

test('it never rejects, whatever the transport does', async () => {
  const { exports } = loadUserscript();
  for (const impl of [
    async () => { throw new Error('boom'); },
    async () => ({ ok: true, status: 200, text: async () => { throw new Error('read failed'); } }),
    async () => null,
    // text() that resolves to a non-string: JSON.parse throws, and any
    // string method called on the result inside the catch would throw again,
    // this time with nothing to catch it.
    async () => ({ ok: true, status: 200, text: async () => undefined }),
    async () => ({ ok: true, status: 200, text: async () => ({}) }),
    async () => ({ ok: true, status: 200, text: async () => 12345 }),
  ]) {
    const result = await exports.fetchEducationData(impl, COOKIE);
    assert.strictEqual(result.ok, false, 'must resolve with ok:false');
    assert.strictEqual(typeof result.reason, 'string');
  }
});

test('a non-JSON response never puts the response body on screen', async () => {
  const { exports } = loadUserscript();
  const secret = '<!doctype html><script>var logoutHash="deadbeefcafe";</script>';
  const result = await exports.fetchEducationData(fetchReturning(secret), COOKIE);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not-json');
  assert.ok(!result.detail.includes('logoutHash'), 'detail leaked page content');
  assert.ok(!result.detail.includes('deadbeefcafe'), 'detail leaked a credential');
  assert.match(result.detail, /bytes of non-JSON/);
});

test('the token never appears in result.detail on any failure path', async () => {
  const { exports } = loadUserscript();

  const scenarios = [
    () => exports.fetchEducationData(async () => { throw new Error('offline'); }, COOKIE),
    () => exports.fetchEducationData(fetchReturning('', { status: 503 }), COOKIE),
    () => exports.fetchEducationData(fetchReturning('<!doctype html>'), COOKIE),
    () => exports.fetchEducationData(fetchReturning({ success: false, error: 'Wrong rfcv token' }), COOKIE),
    () => exports.fetchEducationData(async () => { }, 'unrelated=1'),
  ];

  for (const run of scenarios) {
    const result = await run();
    assert.strictEqual(result.ok, false);
    if (typeof result.detail === 'string') {
      assert.ok(!result.detail.includes(RFCV_VALUE), `token leaked into detail: ${result.detail}`);
    }
  }
});
