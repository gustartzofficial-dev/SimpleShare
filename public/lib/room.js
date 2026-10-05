export const ROOM_RE = /^[A-Za-z0-9_-]{20,80}$/;
export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  },
};
export function parseRoomInvite(raw, base) {
  const text = String(raw || '').trim();
  if (ROOM_RE.test(text)) return { room: text, direct: false };
  let url;
  try {
    url = new URL(text, base);
  } catch {
    throw new Error('Paste a complete room link or a valid room code.');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Use an http or https room link.');
  const room = url.searchParams.get('room');
  if (!ROOM_RE.test(room || ''))
    throw new Error('That link doesn’t contain a valid room. Copy the invite from SimpleShare.');
  return { room, direct: url.searchParams.get('p2p') === '1' };
}
export function canonicalInvite(base, room, direct = false) {
  if (!ROOM_RE.test(room)) throw new Error('Invalid room code.');
  const url = new URL('/', base);
  url.searchParams.set('room', room);
  if (direct) url.searchParams.set('p2p', '1');
  return url.toString();
}
