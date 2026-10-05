import test from 'node:test';
import assert from 'node:assert/strict';
import { runSessionMutation, closeSessionTracks } from '../public/lib/media-session.js';
function connection(count = 8) {
  const pc = new EventTarget();
  Object.assign(pc, {
    connectionState: 'connected',
    signalingState: 'stable',
    transceivers: Array.from({ length: count }, (_, i) => ({
      mid: String(i),
      stopped: false,
      stop() {
        this.stopped = true;
      },
    })),
    getTransceivers() {
      return this.transceivers;
    },
    async createOffer() {
      return {
        type: 'offer',
        sdp: JSON.stringify(this.transceivers.map((t) => ({ mid: t.mid, stopped: t.stopped }))),
      };
    },
    async setLocalDescription(sdp) {
      this.localDescription = sdp;
      this.signalingState = 'have-local-offer';
    },
    async setRemoteDescription(sdp) {
      assert.equal(sdp.type, 'answer');
      this.signalingState = 'stable';
    },
    close() {
      this.connectionState = 'closed';
      this.signalingState = 'closed';
    },
  });
  return pc;
}
test('four simultaneous screens retain the other three when one video/audio pair closes', async () => {
  const pc = connection();
  await runSessionMutation(pc, () =>
    closeSessionTracks(pc, [{ mid: '0' }, { mid: '1' }], async (body) => {
      const offer = JSON.parse(body.sessionDescription.sdp);
      assert.deepEqual(
        offer.filter((t) => t.stopped).map((t) => t.mid),
        ['0', '1'],
      );
      assert.equal(body.tracks.length, 2);
      return { sessionDescription: { type: 'answer', sdp: 'answer' } };
    }),
  );
  assert.equal(pc.connectionState, 'connected');
  assert.equal(pc.signalingState, 'stable');
  assert.equal(pc.transceivers.filter((t) => !t.stopped).length, 6);
});
test('an uncertain close retires the poisoned session and notifies the session owner', async () => {
  const pc = connection();
  let notified = 0;
  pc.addEventListener('connectionstatechange', () => notified++);
  await assert.rejects(
    runSessionMutation(pc, () =>
      closeSessionTracks(pc, [{ mid: '0' }], async () => ({
        errorCode: 'invalid_session_description',
      })),
    ),
  );
  assert.equal(pc.connectionState, 'closed');
  assert.equal(notified, 1);
  let sent = false;
  await assert.rejects(
    runSessionMutation(pc, async () => {
      sent = true;
    }),
  );
  assert.equal(sent, false);
  assert.equal(notified, 1);
});
test('unfinished renegotiation blocks the next mutation instead of adding more tracks', async () => {
  const pc = connection();
  pc.signalingState = 'have-remote-offer';
  let sent = false;
  await assert.rejects(
    runSessionMutation(pc, async () => {
      sent = true;
    }),
  );
  assert.equal(sent, false);
  assert.equal(pc.connectionState, 'closed');
});
test('closing the final screen retires the empty allocation before another watch', async () => {
  const pc = connection(2);
  await runSessionMutation(pc, () =>
    closeSessionTracks(pc, [{ mid: '0' }, { mid: '1' }], async () => ({
      sessionDescription: { type: 'answer' },
    })),
  );
  assert.equal(pc.connectionState, 'closed');
});
test('partial close and network failure cannot leave a session available for retry', async () => {
  for (const send of [
    async () => ({
      tracks: [{ errorCode: 'close_failed' }],
      sessionDescription: { type: 'answer' },
    }),
    async () => {
      throw Error('network');
    },
  ]) {
    const pc = connection();
    await assert.rejects(
      runSessionMutation(pc, () => closeSessionTracks(pc, [{ mid: '0' }], send)),
    );
    assert.equal(pc.connectionState, 'closed');
  }
});
