import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamAudioPreferences, effectiveStreamAudio } from '../public/lib/stream-audio.js';

const memory = () => {
  const values = new Map();
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
};
test('per-owner mute and zero volume survive recreation and browser refresh', () => {
  const storage = memory();
  let preferences = createStreamAudioPreferences(storage);
  preferences.set('room:muted-owner', { muted: true, volume: 0.4 });
  preferences.set('room:zero-owner', { volume: 0 });
  preferences = createStreamAudioPreferences(storage);
  assert.deepEqual(preferences.get('room:muted-owner'), { muted: true, volume: 0.4 });
  assert.deepEqual(preferences.get('room:zero-owner'), { muted: false, volume: 0 });
  assert.deepEqual(preferences.get('another-room:zero-owner'), { muted: false, volume: 1 });
});
test('master controls cannot override per-stream silence and gain levels multiply', () => {
  assert.deepEqual(effectiveStreamAudio({ muted: true, volume: 1 }, { muted: false, volume: 1 }), {
    muted: true,
    volume: 1,
  });
  assert.deepEqual(effectiveStreamAudio({ muted: false, volume: 0 }, { muted: false, volume: 1 }), {
    muted: true,
    volume: 0,
  });
  assert.deepEqual(
    effectiveStreamAudio({ muted: false, volume: 0.5 }, { muted: true, volume: 0.8 }),
    { muted: true, volume: 0.4 },
  );
  assert.deepEqual(
    effectiveStreamAudio({ muted: false, volume: 0.5 }, { muted: false, volume: 0.8 }),
    { muted: false, volume: 0.4 },
  );
});
test('malformed or blocked storage is safe and listening history is bounded', () => {
  const storage = memory();
  storage.set('simpleshare-stream-audio', '{bad JSON');
  const preferences = createStreamAudioPreferences(storage);
  for (let i = 0; i < 80; i++) preferences.set('owner-' + i, { muted: true });
  assert.equal(JSON.parse(storage.get('simpleshare-stream-audio')).length, 64);
  const blocked = createStreamAudioPreferences({
    get() {
      throw Error('denied');
    },
    set() {
      throw Error('denied');
    },
  });
  assert.equal(blocked.set('owner', { volume: -1 }).volume, 0);
});
