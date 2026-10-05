import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomInvite, canonicalInvite, ROOM_RE } from '../public/lib/room.js';
const room = '1234567890abcdef12345678';
test('valid invite preserves the room and explicit direct mode', () => {
  assert.deepEqual(
    parseRoomInvite(`https://example.com/?room=${room}&p2p=1&debug=1`, 'https://local.test'),
    { room, direct: true },
  );
});
test('room codes and surrounding whitespace work', () => {
  assert.deepEqual(parseRoomInvite('  ' + room + '  ', 'https://local.test'), {
    room,
    direct: false,
  });
});
test('invites navigate locally and discard unrelated query parameters', () => {
  assert.equal(
    canonicalInvite('https://local.test/?debug=1&room=old', room, true),
    `https://local.test/?room=${room}&p2p=1`,
  );
});
for (const input of [
  '',
  'javascript:alert(1)',
  'ftp://example.com/?room=' + room,
  'https://example.com/?room=short',
  'https://example.com/?room=../../secret',
  'https://example.com/',
])
  test('reject invalid invite: ' + input, () => {
    assert.throws(() => parseRoomInvite(input, 'https://local.test'));
  });
test('identifiers are bounded and unguessable length', () => {
  assert.equal(ROOM_RE.test('a'.repeat(19)), false);
  assert.equal(ROOM_RE.test('a'.repeat(81)), false);
  assert.equal(ROOM_RE.test(room), true);
  assert.throws(() => canonicalInvite('https://local.test', 'tiny'));
});
