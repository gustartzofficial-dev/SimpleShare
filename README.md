# SimpleShare

A deliberately minimal group screen sharing app. No accounts, chat, camera call, room list, recordings, or database.

## What changed from the original 1-to-1 MVP

- A room can have up to 12 participants.
- Everyone joins with the same secret invite link; there is no permanent host/viewer role.
- Any participant can start sharing their screen.
- One screen is live at a time, preserving the intentionally simple experience.
- When the active sharer stops, anyone else can immediately share.

## How it works

- The first browser creates a high-entropy secret room link.
- A Vercel WebSocket Function keeps an in-memory participant list and relays only WebRTC signaling messages.
- Each browser forms peer-to-peer WebRTC connections with the other participants in the room.
- The active sharer sends their screen stream to every connected participant.
- The server coordinates which participant is currently sharing, but it does not receive the screen media itself.
- Rooms have no database record and disappear when the last participant disconnects.

## Deploy to Vercel

1. Push this folder to a GitHub/GitLab/Bitbucket repository.
2. Import the repository into Vercel.
3. Deploy with the default settings. The included `vercel.json` builds the static frontend to `dist/`.
4. No environment variables are required.

Or from the CLI:

```bash
npm install
npx vercel
```

## Local development

```bash
npm install
npx vercel dev
```

Open the local URL in multiple browser windows or devices. Create a room once and open the same invite link everywhere.

## Privacy note

"Private" here means the application stores no room content and WebRTC media is encrypted in transport. The signaling function necessarily sees temporary room membership and connection metadata while relaying signaling messages. This starter uses public Google STUN servers and intentionally does not include TURN, so some restrictive corporate/mobile networks may fail to connect.

For higher connection success rates, add TURN credentials to `rtcConfig.iceServers` in `public/app.js`. A TURN server relays encrypted WebRTC packets when direct peer-to-peer connectivity is impossible.

## Scale note

This version uses a peer-to-peer mesh. That is excellent for small private rooms because the server does not relay media, but the sharer's upload bandwidth grows with every viewer. The app caps rooms at 12 people; for consistently larger rooms, switch the media layer to an SFU such as LiveKit, Cloudflare Calls, mediasoup, or similar.

## Browser behavior

Browsers always require the person sharing to explicitly approve screen capture and choose which screen/window/tab to share. System/tab audio support varies by browser and operating system.
