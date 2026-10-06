import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareAudioMixer } from '../public/lib/share-audio.js';
class Track extends EventTarget {
  constructor(kind) {
    super();
    this.kind = kind;
    this.readyState = 'live';
    this.enabled = true;
  }
  stop() {
    this.readyState = 'ended';
  }
}
class Stream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}
class Node {
  connections = [];
  connect(node) {
    this.connections.push(node);
  }
  disconnect() {
    this.connections = [];
  }
}
class Context {
  static instances = [];
  gains = [];
  currentTime = 1;
  closed = false;
  constructor() {
    Context.instances.push(this);
  }
  createGain() {
    const n = new Node();
    n.gain = {
      value: 1,
      setTargetAtTime(value) {
        this.value = value;
      },
    };
    this.gains.push(n);
    return n;
  }
  createMediaStreamDestination() {
    const n = new Node();
    n.stream = new Stream([new Track('audio')]);
    return n;
  }
  createDynamicsCompressor() {
    const n = new Node();
    for (const k of ['threshold', 'knee', 'ratio']) n[k] = { value: 0 };
    return n;
  }
  createMediaStreamSource(stream) {
    const n = new Node();
    n.stream = stream;
    return n;
  }
  createConstantSource() {
    const n = new Node();
    n.offset = { value: 1 };
    n.start = () => {};
    n.stop = () => {};
    return n;
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
}
const mixer = (track = null, onExtraEnded) =>
  createShareAudioMixer(track, { Context, Stream, onExtraEnded });
const extra = () => new Stream([new Track('audio'), new Track('video')]);
test('audio source changes and gain adjustments retain one outgoing track', () => {
  const primary = new Track('audio');
  const mix = mixer(primary);
  const output = mix.track;
  const first = extra(),
    second = extra();
  mix.setExtra(first);
  assert.equal(first.getVideoTracks()[0].enabled, false);
  mix.setLevels(0.25, 0.75);
  assert.deepEqual(
    Context.instances.at(-1).gains.map((n) => n.gain.value),
    [0.25, 0.75],
  );
  mix.setExtra(second);
  assert.ok(first.getTracks().every((t) => t.readyState === 'ended'));
  assert.equal(mix.track, output);
  mix.removeExtra();
  assert.ok(second.getTracks().every((t) => t.readyState === 'ended'));
  assert.equal(primary.readyState, 'live');
  assert.equal(output.readyState, 'live');
  mix.dispose();
  mix.dispose();
  assert.equal(primary.readyState, 'ended');
  assert.equal(output.readyState, 'ended');
  assert.equal(Context.instances.at(-1).closed, true);
});
test('an invalid replacement cannot remove the existing extra audio source', () => {
  const mix = mixer();
  const first = extra();
  mix.setExtra(first);
  const invalid = new Stream([new Track('video')]);
  assert.throws(() => mix.setExtra(invalid), /live audio/);
  assert.equal(mix.extraTrack, first.getAudioTracks()[0]);
  assert.equal(invalid.getTracks()[0].readyState, 'ended');
  mix.dispose();
});
test('ending extra audio and late capture disposal do not end the outgoing mix', () => {
  let ended = 0;
  const mix = mixer(null, () => ended++);
  const capture = extra();
  mix.setExtra(capture);
  capture.getAudioTracks()[0].dispatchEvent(new Event('ended'));
  assert.equal(ended, 1);
  assert.equal(mix.extraTrack, null);
  assert.equal(mix.track.readyState, 'live');
  const next = extra();
  mix.setExtra(next);
  next.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  assert.equal(ended, 2);
  assert.equal(mix.extraTrack, null);
  assert.equal(mix.track.readyState, 'live');
  mix.dispose();
  const late = extra();
  assert.throws(() => mix.setExtra(late), /live audio/);
  assert.ok(late.getTracks().every((t) => t.readyState === 'ended'));
});
