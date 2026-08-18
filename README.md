# SimpleShare

Minimal Discord-style screen sharing: create a private link, invite people, and let anyone in the room publish a screen. No chat, camera call, account, or recording UI.

## Architecture

- Vercel serves the static app and `/api/token`.
- LiveKit Cloud is the SFU/media transport.
- Every participant publishes their own screen from their own connection.
- Multiple people can share simultaneously.
- LiveKit adaptive stream + simulcast selects smaller layers for smaller tiles.
- Dynacast pauses publisher layers nobody is consuming.
- When a viewer focuses one stream, SimpleShare disables delivery of the other remote video streams for that viewer; returning to the grid enables them again.
- Background video is paused by adaptive stream where supported.

## Economy-first quality profiles

The sharer chooses a maximum profile before starting:

- **720p30 (default):** 1.8 Mbps max; 360p15 saver layer at 350 kbps.
- **720p60:** 3.0 Mbps max; 360p20 saver layer at 500 kbps.
- **1080p60:** 5.5 Mbps max; 360p15 + 720p30 lower layers.

These are bitrate ceilings, not guaranteed usage. WebRTC/LiveKit can use less based on content and network conditions. The UI shows a rough maximum downstream-per-viewer/hour estimate.

Each viewer can independently choose Auto, 360p saver, 720p, or 1080p where available. Auto is recommended: adaptive stream still lowers quality for small tiles and can raise it for a focused stream.

Shared audio is opt-in to avoid unnecessary bandwidth.

## Vercel environment variables

Set these in **Project → Settings → Environment Variables** and redeploy:

```text
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Never expose `LIVEKIT_API_SECRET` in browser code.

## Deploy

```bash
npm install
npx vercel --prod
```

Or import the repository into Vercel. The production build is copied from `public/` to `dist/`.
