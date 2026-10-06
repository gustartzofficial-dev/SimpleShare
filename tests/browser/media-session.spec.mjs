import { test, expect } from '@playwright/test';
import { roomFixture, addScreens } from './helpers/room-fixture.mjs';
test('three received screens survive fourth-member publishing and batched video/audio cleanup @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  await page.mouse.click(500, 300);
  const result = await page.evaluate(async () => {
    const { PartyTracks, of } = globalThis.__roomFixture;
    const server = new RTCPeerConnection({ iceServers: [] });
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    let n = 0;
    const tick = setInterval(() => {
      ctx.fillStyle = n++ % 2 ? 'red' : 'blue';
      ctx.fillRect(0, 0, 320, 180);
    }, 50);
    const capture = canvas.captureStream(20);
    const audioContext = new AudioContext();
    await audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    const tracks = [capture.getVideoTracks()[0], destination.stream.getAudioTracks()[0]];
    const gathered = async (pc) => {
      if (pc.iceGatheringState === 'complete') return;
      await new Promise((resolve) => {
        const listener = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', listener);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', listener);
      });
    };
    const original = window.fetch;
    const subscriptions = [];
    const publishing = [];
    let errors = [];
    let pullCalls = 0;
    let closeCalls = 0;
    let remoteFrames = 0;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith('/test-sfu/')) return original(input, init);
      const body = init?.body ? JSON.parse(init.body) : {};
      let data = {};
      if (url.includes('/sessions/new')) data = { sessionId: 'test-session' };
      else if (url.includes('/renegotiate'))
        await server.setRemoteDescription(body.sessionDescription);
      else if (url.includes('/tracks/close')) {
        closeCalls++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!body.force || body.sessionDescription) throw Error('Closure must not renegotiate');
        for (const track of body.tracks) {
          const t = server.getTransceivers().find((t) => t.mid === track.mid);
          await t.sender.replaceTrack(null);
        }
        data = { tracks: body.tracks };
      } else if (body.sessionDescription) {
        await server.setRemoteDescription(body.sessionDescription);
        await server.setLocalDescription(await server.createAnswer());
        await gathered(server);
        data = { tracks: body.tracks, sessionDescription: server.localDescription };
      } else {
        pullCalls++;
        const allocated = body.tracks.map((track, i) => ({
          track,
          t: server.addTransceiver(tracks[track.trackName.endsWith('audio') ? 1 : 0], {
            direction: 'sendonly',
          }),
        }));
        await server.setLocalDescription(await server.createOffer());
        await gathered(server);
        data = {
          tracks: allocated.map(({ track, t }) => ({ ...track, mid: t.mid })),
          requiresImmediateRenegotiation: true,
          sessionDescription: server.localDescription,
        };
      }
      return new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const engine = new PartyTracks({ prefix: '/test-sfu', iceServers: [] });
    const sessionSub = engine.session$.subscribe({ error: (e) => errors.push(String(e)) });
    let client;
    const pcSub = engine.peerConnection$.subscribe((pc) => (client = pc));
    const watched = [];
    const received = [];
    const frameTimes = [[], [], []];
    const wait = async (predicate, label) => {
      const until = Date.now() + 15000;
      while (!predicate()) {
        if (Date.now() > until)
          throw Error(
            'Timed out at ' +
              label +
              ': ' +
              JSON.stringify({
                errors,
                received: received.length,
                pullCalls,
                closeCalls,
                remoteFrames,
                state: client?.connectionState,
                signal: client?.signalingState,
              }),
          );
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      for (let i = 0; i < 3; i++) {
        const pair = [];
        for (const kind of ['video', 'audio'])
          pair.push(
            engine
              .pull(of({ location: 'remote', sessionId: 'source-' + i, trackName: i + '-' + kind }))
              .subscribe({
                next: (track) => {
                  received.push(track);
                  if (kind === 'video') {
                    const video = document.createElement('video');
                    video.muted = true;
                    video.srcObject = new MediaStream([track]);
                    video.style.cssText =
                      'position:fixed;z-index:999;width:120px;height:68px;right:0;top:' +
                      i * 70 +
                      'px;pointer-events:none';
                    document.body.append(video);
                    video.play();
                    const frame = () => {
                      remoteFrames++;
                      frameTimes[i].push(performance.now());
                      video.requestVideoFrameCallback(frame);
                    };
                    video.requestVideoFrameCallback(frame);
                    watched.push(video);
                  }
                },
                error: (e) => errors.push(String(e)),
              }),
          );
        subscriptions.push(pair);
      }
      await wait(() => received.length === 6 && client.connectionState === 'connected', 'receive');
      const published = [];
      for (const track of tracks)
        publishing.push(
          engine.push(of(track)).subscribe({
            next: (meta) => published.push(meta),
            error: (e) => errors.push(String(e)),
          }),
        );
      await wait(() => published.length === 2, 'publish');
      const before = remoteFrames;
      const closureStart = performance.now();
      subscriptions[0].forEach((sub) => sub.unsubscribe());
      await wait(() => closeCalls === 1 && client.signalingState === 'stable', 'close');
      await wait(() => remoteFrames > before + 8, 'frames');
      return {
        state: client.connectionState,
        errors,
        pullCalls,
        closeCalls,
        published: published.length,
        remaining: received.slice(2).every((t) => t.readyState === 'live'),
        continuedDuringClose: frameTimes
          .slice(1)
          .every(
            (times) =>
              times.filter((time) => time >= closureStart && time <= closureStart + 450).length >=
              2,
          ),
      };
    } finally {
      publishing.forEach((sub) => sub.unsubscribe());
      subscriptions.flat().forEach((sub) => sub.unsubscribe());
      sessionSub.unsubscribe();
      pcSub.unsubscribe();
      client?.close();
      server.close();
      clearInterval(tick);
      tracks.forEach((t) => t.stop());
      oscillator.stop();
      await audioContext.close();
      window.fetch = original;
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.state).toBe('connected');
  expect(result.remaining).toBe(true);
  expect(result.continuedDuringClose).toBe(true);
  expect(result.closeCalls).toBe(1);
  expect(result.published).toBe(2);
});

test('one repeatedly failed source leaves other screens and the publisher intact @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  await addScreens(page, 2);
  const result = await page.evaluate(async () => {
    const f = globalThis.__roomFixture,
      s = f.state;
    s.share = { streamId: 'local-preview' };
    const publisher = s.share;
    for (let i = 0; i < 2; i++) {
      const id = 'test-' + i;
      s.watching.add(id);
      s.subs.set(id, {
        target: { sessionId: 'source-' + i },
        subs: [],
        attempt: 3,
        strikes: 1,
        subscribedAt: Date.now() - 60000,
        videoMedia: new MediaStream(),
      });
    }
    s.tiles.get('test-1').lastFrameAt = Date.now();
    await f.watchdog();
    return {
      failed: s.watching.has('test-0'),
      healthy: s.watching.has('test-1'),
      publisher: s.share === publisher,
      retryDisabled: s.tiles.get('test-0').idle.querySelector('button').disabled,
    };
  });
  expect(result).toEqual({ failed: false, healthy: true, publisher: true, retryDisabled: false });
});
test('a decoded live still screen is not mistaken for a failed subscription @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  await addScreens(page, 1);
  expect(
    await page.evaluate(async () => {
      const f = globalThis.__roomFixture,
        s = f.state,
        id = 'test-0';
      s.watching.add(id);
      const entry = {
        target: { sessionId: 'source' },
        subs: [],
        attempt: 3,
        strikes: 1,
        subscribedAt: Date.now() - 60000,
        videoMedia: { getVideoTracks: () => [{ readyState: 'live', muted: false }] },
      };
      s.subs.set(id, entry);
      Object.defineProperty(s.tiles.get(id).video, 'readyState', { value: 2 });
      await f.watchdog();
      return s.subs.get(id) === entry && entry.strikes === 0;
    }),
  ).toBe(true);
});
