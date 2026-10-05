import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMedia, serialUpdates } from '../public/lib/media-request.js';
import { runSessionMutation } from '../public/lib/media-session.js';
test('a hanging media request has a deadline and cancels its network operation', async () => {
  let signal;
  await assert.rejects(
    requestMedia(
      '/test',
      {},
      {
        timeout: 20,
        fetchImpl: async (_p, init) => {
          signal = init.signal;
          return new Promise(() => {});
        },
      },
    ),
    /timed out/,
  );
  assert.equal(signal.aborted, true);
});
test('a response body that never finishes cannot hold the negotiation queue', async () => {
  await assert.rejects(
    requestMedia(
      '/test',
      {},
      {
        timeout: 20,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          clone: () => ({ text: () => new Promise(() => {}) }),
        }),
      },
    ),
    /timed out/,
  );
});
test('malformed responses and invalid sessions are reported before applying SDP', async () => {
  await assert.rejects(
    requestMedia('/test', {}, { fetchImpl: async () => new Response('bad html') }),
    /invalid response/,
  );
  await assert.rejects(
    requestMedia(
      '/test',
      {},
      {
        fetchImpl: async () =>
          Response.json(
            { errorCode: 'session_error', errorDescription: 'Session disconnected' },
            { status: 410 },
          ),
      },
    ),
    (e) => e.status === 410 && e.retryable === true && !e.sessionSafe,
  );
});
test('authorization and budget failures do not retry forever', async () => {
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(
      requestMedia(
        '/test',
        {},
        {
          fetchImpl: async () =>
            Response.json({ error: 'Unavailable', budgetBlocked: status === 503 }, { status }),
        },
      ),
      (e) => e.retryable === false,
    );
  }
});
test('a departed source does not retire a healthy stable connection', async () => {
  const pc = {
    connectionState: 'connected',
    signalingState: 'stable',
    close() {
      throw Error('should not retire');
    },
  };
  await assert.rejects(
    runSessionMutation(pc, () =>
      requestMedia(
        '/test',
        {},
        { fetchImpl: async () => Response.json({ error: 'Source gone' }, { status: 404 }) },
      ),
    ),
    /Source gone/,
  );
  assert.equal(pc.connectionState, 'connected');
});
test('room updates remain ordered across await boundaries and survive an update failure', async () => {
  const enqueue = serialUpdates(),
    events = [];
  let release;
  const first = enqueue(async () => {
    events.push('first-start');
    await new Promise((r) => (release = r));
    events.push('first-end');
  });
  const second = enqueue(async () => {
    events.push('second');
    throw Error('update failed');
  });
  const third = enqueue(async () => events.push('third'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(events, ['first-start']);
  release();
  await first;
  await assert.rejects(second);
  await third;
  assert.deepEqual(events, ['first-start', 'first-end', 'second', 'third']);
});

test('PartyTracks diagnostic history is bounded by its default configuration', async () => {
  const { PartyTracks } = await import('../public/vendor/partytracks.js');
  const engine = new PartyTracks({ iceServers: [] });
  for (let i = 0; i < 150; i++) engine.history.log({ endpoint: String(i) });
  assert.equal(engine.history.entries.length, 100);
  assert.equal(engine.history.entries[0].endpoint, '50');
});
