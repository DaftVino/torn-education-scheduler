'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

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
  const result = await exports.fetchEducationData(fetchReturning(loadFixture()));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.courses.size, 131);
});

test('it requests the declared endpoint, same-origin', async () => {
  const { exports } = loadUserscript();
  const seen = [];
  await exports.fetchEducationData(async (url, opts) => {
    seen.push({ url, opts });
    return { ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) };
  });
  assert.strictEqual(seen[0].url, '/page.php?sid=educationInitData');
  assert.strictEqual(seen[0].opts.credentials, 'same-origin');
});

test('a network error is reported, not thrown', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(async () => { throw new Error('offline'); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'network');
  assert.match(result.detail, /offline/);
});

test('a non-200 response is reported with its status', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(fetchReturning('', { status: 503 }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'http');
  assert.match(result.detail, /503/);
});

test('an HTML login page instead of JSON is reported as not-json', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(fetchReturning('<!doctype html><html>...'));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not-json');
});

test('a payload the parser rejects surfaces the parser reason', async () => {
  const { exports } = loadUserscript();
  const result = await exports.fetchEducationData(fetchReturning({ success: false }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not-a-payload');
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
    const result = await exports.fetchEducationData(impl);
    assert.strictEqual(result.ok, false, 'must resolve with ok:false');
    assert.strictEqual(typeof result.reason, 'string');
  }
});

test('a non-JSON response never puts the response body on screen', async () => {
  const { exports } = loadUserscript();
  const secret = '<!doctype html><script>var logoutHash="deadbeefcafe";</script>';
  const result = await exports.fetchEducationData(fetchReturning(secret));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not-json');
  assert.ok(!result.detail.includes('logoutHash'), 'detail leaked page content');
  assert.ok(!result.detail.includes('deadbeefcafe'), 'detail leaked a credential');
  assert.match(result.detail, /bytes of non-JSON/);
});
