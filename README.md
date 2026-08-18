# SimpleShare

SimpleShare is a deliberately minimal group screen-sharing app: create a private room, send the secret link, and anyone in the room can share their screen. There is no chat, camera UI, account system, or meeting interface.

## Architecture (v2)

This version uses **LiveKit's WebRTC SFU** for media instead of a hand-built peer-to-peer mesh.

- Vercel hosts the static app and `/api/token` endpoint.
- `/api/token` creates a short-lived LiveKit room token on the server.
- The browser publishes a screen-share track to LiveKit.
- LiveKit forwards that track to every participant in the room.
- Only the screen-share feature is exposed in the UI.
- Any participant may share when nobody else is currently sharing.

This removes the main reliability problem of the original mesh version: direct browser-to-browser media can fail on restrictive NAT/firewall networks when no TURN relay is available, and one sharer must upload a separate stream for every viewer.

## Deploy to Vercel

1. Create a LiveKit Cloud project at https://cloud.livekit.io/ (or use a self-hosted LiveKit server).
2. In the LiveKit project, copy the WebSocket URL, API key, and API secret.
3. In Vercel -> Project -> Settings -> Environment Variables, add:

   - `LIVEKIT_URL` (example: `wss://your-project.livekit.cloud`)
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`

4. Install and build:

```bash
npm install
npm run build
```

5. Deploy production:

```bash
npx vercel --prod
```

Use your stable production domain when sharing invite links.

## Privacy

Invite URLs contain a high-entropy random room ID. LiveKit transports the realtime media; SimpleShare itself does not record or store the screen stream. API secrets remain server-side in Vercel environment variables and are never sent to the browser. Participants receive short-lived room-scoped tokens.

For a production service, review your LiveKit region, retention/logging, E2EE requirements, abuse controls, and rate limits as part of your privacy policy.
