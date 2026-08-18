# SimpleShare v5 — PartyTracks bridge

SimpleShare keeps the existing architecture:

- **Vercel** hosts the SimpleShare frontend.
- **Cloudflare Worker + Durable Object** handles room presence.
- **Cloudflare Realtime SFU** carries Cloud-mode media.
- **PartyTracks** is now the WebRTC/SFU bridge. It owns publish/pull negotiation, recovery, network changes, ICE restarts, and track lifecycle instead of SimpleShare hand-writing Cloudflare SDP logic.
- **Direct mode** remains available for small peer-to-peer rooms.

## No new account or secret

Keep the settings you already have.

### Cloudflare Worker secrets

- `CF_REALTIME_APP_ID`
- `CF_REALTIME_APP_SECRET` (or the existing `CF_REALTIME_APP_TOKEN` name; the Worker accepts either)

### Vercel environment variable

- `ROOM_API_URL=https://simpleshare.gustartzofficial.workers.dev`

## Deploy

Push this project to the same public GitHub repo.

### Vercel

Use the repository root. Vercel runs `npm run build`, which bundles PartyTracks into the browser app.

### Cloudflare

Keep the Git-connected Worker root directory as:

`cloudflare-worker`

Build command can be `npm run build` and deploy command `npx wrangler deploy`.

The Worker name in `wrangler.toml` remains `simpleshare`, matching the existing Worker.

## Verify

Open:

`https://simpleshare.gustartzofficial.workers.dev/health`

Expected fields include:

```json
{
  "ok": true,
  "build": "partytracks-baseline-v6",
  "mediaBridge": "partytracks",
  "roomsBinding": true,
  "realtimeConfigured": true
}
```

## What changed

Cloud mode no longer uses SimpleShare's custom `/api/sfu/...` WebRTC negotiation path. The browser creates one `PartyTracks` client per participant and publishes/pulls screen tracks through `/partytracks/*` on the Worker. The Worker authenticates the room participant before passing those requests to Cloudflare Realtime using `routePartyTracksRequest()`.

The room Durable Object continues to publish only track metadata (`sessionId` / `trackName`) and presence. Remote browsers feed that metadata into `PartyTracks.pull()`, which handles the actual SFU subscription and renegotiation.

Publisher profiles remain 720p30, 720p60, and 1080p60. Simulcast encodings remain economy-oriented, and each viewer can request the preferred layer independently.
