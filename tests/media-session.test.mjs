import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runSessionMutation,
  closeSessionTracks,
  activateSessionTrack,
} from '../public/lib/media-session.js';
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
      assert.equal(body.force, true);
      assert.equal(body.sessionDescription, undefined);
      assert.equal(body.tracks.length, 2);
      return { tracks: body.tracks };
    }),
  );
  assert.equal(pc.connectionState, 'connected');
  assert.equal(pc.signalingState, 'stable');
  assert.equal(pc.transceivers.filter((t) => !t.stopped).length, 8);
});
test('an uncertain close retires the poisoned session and notifies the session owner', async () => {
  const pc = connection();
  let notified = 0;
  pc.addEventListener('connectionstatechange', () => notified++);
  await assert.rejects(
    runSessionMutation(pc, () =>
      closeSessionTracks(pc, [{ mid: '0' }], async () => ({
        sessionDescription: { type: 'offer', sdp: 'unexpected' },
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
    closeSessionTracks(pc, [{ mid: '0' }, { mid: '1' }], async (body) => ({ tracks: body.tracks })),
  );
  assert.equal(pc.connectionState, 'closed');
});
test('partial forced close and network failure preserve the stable session for retry', async () => {
  for (const send of [
    async () => ({
      tracks: [{ errorCode: 'close_failed' }],
    }),
    async () => {
      throw Error('network');
    },
  ]) {
    const pc = connection();
    await assert.rejects(
      runSessionMutation(pc, () => closeSessionTracks(pc, [{ mid: '0' }], send)),
    );
    assert.equal(pc.connectionState, 'connected');
  }
});

test('closing one source does not renegotiate or stop the shared transport transceiver', async () => {
  const pc = connection(4);
  pc.createOffer = async () => {
    throw new Error('Surviving streams must not renegotiate during closure');
  };
  const stopped = [];
  const detached = [];
  for (const t of pc.transceivers) {
    t.receiver = { track: { stop: () => stopped.push(t.mid) } };
    t.sender = {
      replaceTrack: async (track) => {
        assert.equal(track, null);
        detached.push(t.mid);
      },
    };
  }
  await runSessionMutation(pc, () =>
    closeSessionTracks(pc, [{ mid: '0' }, { mid: '1' }], async (body) => {
      assert.deepEqual(body, { tracks: [{ mid: '0' }, { mid: '1' }], force: true });
      return { tracks: body.tracks };
    }),
  );
  assert.equal(pc.connectionState, 'connected');
  assert.equal(pc.signalingState, 'stable');
  assert.equal(
    pc.transceivers.some((t) => t.stopped),
    false,
  );
  assert.deepEqual(stopped, []);
  assert.deepEqual(detached, ['0', '1']);
});

test('partial closure retries only unresolved mids and releases an already-closed track', async () => {
  const pc = connection(3);
  let calls = 0;
  const send = async (body) => {
    calls++;
    if (calls === 1)
      return {
        tracks: [
          { mid: '0', errorCode: 'close_track_error' },
          { mid: '1', errorCode: 'internal_error' },
        ],
      };
    assert.deepEqual(body.tracks, [{ mid: '1' }]);
    return { tracks: [{ mid: '1' }] };
  };
  await assert.rejects(
    runSessionMutation(pc, () => closeSessionTracks(pc, [{ mid: '0' }, { mid: '1' }], send)),
  );
  assert.equal(pc.connectionState, 'connected');
  await runSessionMutation(pc, () => closeSessionTracks(pc, [{ mid: '0' }, { mid: '1' }], send));
  assert.equal(calls, 2);
  await closeSessionTracks(pc, [{ mid: '0' }, { mid: '1' }], () => {
    throw Error('Duplicate close');
  });
  await runSessionMutation(pc, () =>
    closeSessionTracks(pc, [{ mid: '2' }], async (body) => ({ tracks: body.tracks })),
  );
  assert.equal(pc.connectionState, 'closed');
});

test('a newly allocated track on a reused mid can be closed again', async () => {
  const pc = connection(2);
  let calls = 0;
  const send = async (body) => {
    calls++;
    return { tracks: body.tracks };
  };
  await closeSessionTracks(pc, [{ mid: '0' }], send);
  await closeSessionTracks(pc, [{ mid: '0' }], send);
  assert.equal(calls, 1);
  activateSessionTrack(pc, '0');
  await closeSessionTracks(pc, [{ mid: '0' }], send);
  assert.equal(calls, 2);
  assert.equal(pc.connectionState, 'connected');
});
