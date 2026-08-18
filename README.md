# SimpleShare

A deliberately small, Discord-inspired screen-sharing room: create a room, share the invite link, and let anyone in the room start a stream. There is no camera call, microphone call, chat, account system, or recording feature.

## Current architecture

- **Vercel** hosts the static app and the `/api/token` endpoint.
- **LiveKit Cloud** is the SFU/media layer.
- Every participant can publish a screen simultaneously.
- Every published screen is rendered as its own stream card and appears/disappears from LiveKit room events without reloading the page.
- Clicking a stream card's expand button focuses that stream; viewers can return to the grid at any time.
- `adaptiveStream` and `dynacast` are enabled.
- Screen sharing is tuned for an **up-to-1280×720, 30 FPS** source with a 2.5 Mbps top encoding and a 360p simulcast layer for smaller tiles / constrained connections.
- Shared tab/system audio is requested where the browser supports it.

## Required Vercel environment variables

```text
LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Set them for Production (and Preview if you test preview deployments), then redeploy.

## Deploy

```bash
npm install
npx vercel --prod
```

Or connect the repo to Vercel and use the normal production deployment flow.

## Build

```bash
npm run build
```

The build copies `public/` to `dist/`. Vercel serves `dist/` and deploys `api/token.js` as the server function.

## Privacy notes

The invite URL acts as the room secret. Media is transported through LiveKit's WebRTC infrastructure and is not recorded by this application. The current build does **not** enable application-level end-to-end encryption; if you need the SFU itself to be unable to decrypt media, add LiveKit E2EE as a separate feature.
