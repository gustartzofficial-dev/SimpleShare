# SimpleShare v3.0.1

A tiny Discord-style screen-sharing app with two transport modes:

- **Cloud** — Cloudflare Realtime SFU. Reliable, scalable, one upload per sharer.
- **Direct** — browser-to-browser WebRTC mesh. No SFU media egress; best for 2–4 people, hard capped at 6.

There is no chat, camera UI, account system, recording, or meeting workflow. Any participant can share a screen and multiple participants can stream simultaneously.

## v3.0.1 reliability patch

- Vercel `ROOM_API_URL` is now trimmed and automatically gets `https://` if you pasted only the hostname.
- The room page performs a Worker `/health` preflight before joining.
- Failed joins no longer leave a fake `1 person` state or allow screen sharing.
- Worker/API errors now include the actual HTTP status instead of collapsing into a generic message.
- Realtime upstream failures report which SFU operation failed.
- Worker accepts `CF_REALTIME_APP_TOKEN` or `CF_REALTIME_APP_SECRET` (plus legacy `CALLS_APP_SECRET`) to avoid credential-name mismatches.
- The Cloudflare Worker package now includes a safe `npm run build`, so Git builds do not fail if Cloudflare auto-selects that command.

## What changed in v3

- Replaced LiveKit with Cloudflare Realtime SFU.
- Added Direct peer-to-peer rooms as a zero-SFU-media alternative.
- Multiple simultaneous screen shares in both modes.
- 720p30, 720p60, and 1080p60 publishing profiles.
- Per-viewer quality controls.
- Cloud mode uses simulcast layers and switches layers per viewer.
- Focus mode stops receiving non-focused Cloud streams to reduce egress.
- Cloud streams pause while the browser tab is hidden and resume automatically.
- Direct mode uses one persistent peer connection per participant pair, pre-created screen transceivers, perfect-negotiation handling, ICE restart, and per-peer bitrate/framerate controls.
- Stream/participant changes are pushed over a room WebSocket. No F5 is required.
- Cloud subscription has retry logic for the short timing window where a just-published track has not reached the SFU edge yet.
- Remote audio begins muted so autoplay cannot block the video. A single `Enable stream audio` control unlocks audio when needed.
- New compact Discord-inspired room layout and mobile layout.

## Architecture

The project has two deployable pieces:

1. **Vercel** serves the static UI.
2. **Cloudflare Worker + Durable Object** stores ephemeral room presence, carries signaling/control messages, and securely proxies Cloudflare Realtime API calls. Your Realtime App token never reaches a browser.

Room state lives only while the room exists. Media is never stored by SimpleShare.

## 1. Deploy the Cloudflare room API

You already need a Cloudflare Realtime SFU App ID and App Token.

```bash
cd cloudflare-worker
npm install
npx wrangler login
npx wrangler secret put CF_REALTIME_APP_ID
npx wrangler secret put CF_REALTIME_APP_TOKEN
npm run deploy
```

When prompted, paste the matching value for each secret.

Wrangler will print a Worker URL similar to:

```text
https://simpleshare-room-api.your-subdomain.workers.dev
```

Keep that URL.

## 2. Deploy the frontend to Vercel

Import the project into Vercel or run `vercel` from the project root.

In **Vercel → Project → Settings → Environment Variables**, add:

```text
ROOM_API_URL=https://simpleshare-room-api.your-subdomain.workers.dev
```

Apply it to Production (and Preview if you want preview deployments to work), then redeploy.

The Cloudflare App Token does **not** belong in Vercel and does **not** belong in browser code.

## Quality profiles

| Profile | Capture ceiling | Video bitrate ceiling |
|---|---:|---:|
| 720p30 | 1280×720 @ 30 | ~1.8 Mbps |
| 720p60 | 1280×720 @ 60 | ~3.0 Mbps |
| 1080p60 | 1920×1080 @ 60 | ~5.5 Mbps |

These are ceilings, not guaranteed bitrates. WebRTC congestion control can transmit less.

### Cloud mode economy behavior

- 720p publishing creates high + 360p simulcast layers.
- 1080p publishing creates 1080p + 720p + 360p layers.
- `Auto` selects a layer from the stream tile size/focus state.
- Focusing a stream closes the viewer's other Cloud subscriptions.
- Hidden browser tabs pause Cloud subscriptions.
- System/tab audio is optional and off by default.

### Direct mode economy behavior

- Each sharer sends directly to each viewer.
- Viewer quality requests are applied to that viewer's individual RTP sender.
- Browser congestion control remains active below the configured ceiling.
- Direct mode is capped at 6 participants because mesh upload/encoding cost grows with every viewer.

## Browser support notes

Screen capture always requires the browser's screen/window/tab picker. System audio availability depends on the browser and what the user chooses to share. Chrome/Edge generally provide the broadest screen-audio support.

## Security notes

- Invite room IDs are generated with browser cryptographic randomness.
- The Realtime App token stays in a Cloudflare Worker secret.
- SFU API operations require a per-participant random room token.
- The Worker verifies that subscription requests only pull sessions currently announced in the same room.
- Direct mode is true peer-to-peer media and can expose peer network addressing as part of WebRTC connectivity.
- Cloud mode is encrypted in transit using WebRTC, but this build does not implement application-level end-to-end encryption above the SFU.

## Patch: Cloudflare raw-SDP publish path

Build tag: `sfu-whip-publish-v3`

Cloud screen publishing now follows Cloudflare's maintained WHIP-style flow: the browser sends its SDP offer to the SimpleShare Worker as `application/sdp`; the Worker creates the Realtime session and calls `tracks/new` with `autoDiscover: true`. This avoids forwarding a nested sessionDescription object from the browser through the Worker.
