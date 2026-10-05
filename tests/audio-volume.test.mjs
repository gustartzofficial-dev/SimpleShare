import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlaybackVolume, releasePlayback } from '../public/lib/audio-volume.js';
test('iOS volume uses a gain node when the media-element volume is fixed', () => {
  const previousAudio = globalThis.AudioContext;
  const userAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  const source = {
    connect() {},
    disconnect() {
      this.disconnected = true;
    },
  };
  const gain = {
    gain: { value: 1 },
    connect() {},
    disconnect() {
      this.disconnected = true;
    },
  };
  Object.defineProperty(navigator, 'userAgent', { value: 'iPhone', configurable: true });
  globalThis.AudioContext = class {
    destination = {};
    createMediaElementSource() {
      return source;
    }
    createGain() {
      return gain;
    }
  };
  try {
    const audio = {
      muted: false,
      addEventListener() {},
      get volume() {
        return 1;
      },
      set volume(_value) {},
    };
    const tile = { audio };
    setPlaybackVolume(tile, 0.35);
    assert.equal(audio.volume, 1);
    assert.equal(gain.gain.value, 0.35);
    assert.equal(tile.playbackVolume, 0.35);
    audio.muted = true;
    setPlaybackVolume(tile, 0.35);
    assert.equal(gain.gain.value, 0);
    releasePlayback(tile);
    assert.equal(source.disconnected, true);
    assert.equal(gain.disconnected, true);
  } finally {
    globalThis.AudioContext = previousAudio;
    if (userAgent) Object.defineProperty(navigator, 'userAgent', userAgent);
    else delete navigator.userAgent;
  }
});
test('ordinary browser volume is clamped without a Web Audio graph', () => {
  const tile = { audio: { volume: 1 } };
  setPlaybackVolume(tile, 3);
  assert.equal(tile.audio.volume, 1);
  setPlaybackVolume(tile, -1);
  assert.equal(tile.audio.volume, 0);
  setPlaybackVolume(tile, 0.25);
  assert.equal(tile.audio.volume, 0.25);
  assert.equal(tile.audioGain, undefined);
});
