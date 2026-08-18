import { AccessToken } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';

const ROOM_RE = /^[a-zA-Z0-9_-]{20,80}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit is not configured on this deployment.' });
  }

  const room = typeof req.body?.room === 'string' ? req.body.room.trim() : '';
  if (!ROOM_RE.test(room)) {
    return res.status(400).json({ error: 'Invalid room.' });
  }

  const identity = randomUUID();
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '2h',
  });

  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });

  return res.status(200).json({
    url: LIVEKIT_URL,
    token: await token.toJwt(),
    identity,
  });
}
