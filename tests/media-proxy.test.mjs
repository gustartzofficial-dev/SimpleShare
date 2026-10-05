import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedMediaFetch } from '../cloudflare-worker/src/media-proxy.js';
test('the Worker bounds a stalled Cloudflare request and its response body', async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => ({ arrayBuffer: () => new Promise(() => {}) }),
  ]) {
    const response = await boundedMediaFetch('https://test', {}, { timeout: 20, fetchImpl });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).errorCode, 'upstream_unavailable');
  }
});
test('media upstream response status and JSON are preserved without relying on Content-Length', async () => {
  const response = await boundedMediaFetch(
    'https://test',
    {},
    { fetchImpl: async () => Response.json({ sessionId: 'new' }, { status: 201 }) },
  );
  assert.equal(response.status, 201);
  assert.equal((await response.json()).sessionId, 'new');
});
