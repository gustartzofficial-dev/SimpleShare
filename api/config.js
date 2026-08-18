export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const roomApiUrl = (process.env.ROOM_API_URL || '').replace(/\/$/, '');
  res.status(200).json({ roomApiUrl });
}
