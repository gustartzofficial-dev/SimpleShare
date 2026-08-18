# SimpleShare v12 — clean rewrite of the frontend

Your backend was never the problem. `/health` is green, `/debug/realtime`
creates real Cloudflare sessions, and `sessions/new` + `generate-ice-servers`
both returned 2xx from your browser. The Worker, the Durable Object, the
credentials and the SFU proxy all work.

What was broken was `public/app.js`: 946 lines carrying **three architectures at
once** — direct peer-to-peer, the old raw-SDP SFU path, and PartyTracks — plus
LiveKit leftovers in `api/`. Every previous rewrite added a layer and removed
nothing. That's why you could spend weeks fixing code that wasn't executing.

This replaces the frontend with **628 lines and one path**.

## Install

Copy these over your repo:

```
public/app.js
public/index.html
public/styles.css
dist/                     (Vercel rebuilds this anyway; included for parity)
```

Then **delete these two files** — a zip can't delete for you:

```
api/token.js      imports livekit-server-sdk, which isn't in package.json
api/ws.js         imports express and ws, also not in package.json
```

Nothing references them. `app.js` only ever calls `/api/config`, which stays.

Commit, push. Vercel redeploys the frontend by itself. **No Worker changes** —
keep the v11 Worker you already deployed.

## What's different

**One media path.** Screen → `push()` → metadata → Durable Object → other
browser → `pull()` → `<video>`. No modes, no fallbacks, no P2P, no raw SDP.
The direct-mode bug that cost you weeks is now structurally impossible: the code
to be in the wrong mode doesn't exist.

**An activity log in the bottom-right corner.** Every step writes to it — screen
captured, video published, announced to room, subscribing, receiving video. When
something breaks you'll see *which step* rather than a black tile. It opens
automatically on failure, and `?debug=1` on the URL opens it from the start plus
turns on PartyTracks' internal ICE logging.

**Timeouts on both sides.** If publishing gets no confirmation in 15s, or a
subscription gets no track in 15s, you get a real message instead of a spinner.

**No `sendEncodings`.** Quality now comes purely from the `getDisplayMedia`
capture constraints. Passing encodings into `addTransceiver` was an extra
failure point — and on your machine `tracks/new` never fired, which is exactly
where that would break. All three quality options still work.

**Polling as a safety net.** Every 3 seconds the client reconciles against
`/snapshot`, so a dropped websocket message can't leave you staring at a stale
room.

## Features kept

Invite links, up to 10 people, anyone can share, several people sharing at once,
720p30 / 720p60 / 1080p60, optional audio, click a tile to enlarge, editable
name that persists, live indicators in the people list.

Dropped on purpose: direct/P2P mode, per-viewer quality controls, simulcast RID
selection, focus view, bandwidth suspend-on-hidden, connection stats. Each was a
source of silent failure. They can come back once the baseline is boring.

## Test it

1. Open your Vercel URL, click **Create a room**.
2. Click **Share my screen**. The log should read:
   `captured screen` → `publishing video track…` → `video published (track …)`
   → `announced to room (session …)`.
3. Send the link to a friend. Their log should read:
   `… is live — subscribing` → `receiving video from …`.

If it stops partway, the last line in the log tells us exactly where — and
that's a specific question I can answer, not a black tile.

## While this settles

If you need screen sharing with your friends *right now*, use
**https://meet.jit.si** — free, browser-based, no account, no install, screen
share, several people. Open a link and send it. Don't let this project keep you
from actually talking to your friends this week.

## Where TURN fits

You do not need TURN to test. If video publishes and announces correctly but the
viewer's tile times out with *"No video after 15s"*, that's the moment TURN
matters — the setup steps are in the v11 `TURN-SETUP.md`, and the Worker code for
it is already deployed and waiting for the two secrets.
