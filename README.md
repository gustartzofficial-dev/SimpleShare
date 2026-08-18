# SimpleShare v13 — the socket bug, and a Discord-style UI

## READ THIS FIRST: you must deploy the Worker

Your log says `backend ok (build cloud-only-v10)`. The v11 Worker never
deployed, and **this release fixes the actual bug in the Worker**. Copying the
frontend alone will change nothing.

```
cd cloudflare-worker
npx wrangler deploy
```

Then confirm: `https://simpleshare.gustartzofficial.workers.dev/health`
must show `"build":"socket-grace-v13"`. If it doesn't, stop and fix the deploy
before testing.

## What your log revealed

```
20:25:10  room socket connected
20:25:12  room socket closed, reconnecting in 2s
20:25:14  Room socket failed.       <- and forever after
20:25:49  publishing video track...  <- never completes
```

The socket connected, dropped two seconds later, and **every reconnect failed
from then on**. That last part was the real damage, and it was my bug:

```js
async webSocketClose(ws) {
  await this.removeParticipant(participantId);   // deletes you from the room
}
```

A closed socket deleted you from the Durable Object immediately. Your
participant token then matched nobody, so:

- every socket reconnect returned 401 -> the infinite retry loop
- **every PartyTracks request returned 401 too** -> publishing died

And you never saw an error for the publish because PartyTracks retries failed
requests forever with backoff, without surfacing anything. Hence
`publishing video track...` followed by fifteen seconds of silence.

One dropped socket bricked the entire session. This very likely explains a
chunk of the earlier history too, including 401s I originally attributed
elsewhere.

## Fixes

**Worker — disconnect grace period.** A closed socket now marks you
`disconnectedAt` and starts a 25-second timer via a Durable Object alarm.
Reconnect inside that window and you keep your identity, your token, and your
stream. Only after 25 seconds of real absence are you removed.

**Worker — websocket upgrade forwarding.** The upgrade request was being
rebuilt by hand (`method` + `headers` + `body`), which can corrupt the
handshake. It now passes the original request through with
`new Request(url, request)`. This may well be what caused the 2-second drop.

**Client — real close diagnostics.** The log now prints the WebSocket close
code and reason. Code 1006 is an abnormal network close, 1001 is the server
going away, 1000 is clean. If it still drops, that number tells us why.

**Client — bounded reconnect.** Six attempts with increasing backoff, then a
clean reload instead of hammering dead credentials every 2 seconds forever.

## The UI

Reworked to a Discord-style dark theme: `#1e1f22` / `#2b2d31` / `#313338`
surfaces, blurple accents, a proper right-hand members sidebar with live dots, a
header bar, and rounded stream tiles with hover outlines. Your own stream is
outlined in green. Click any tile to enlarge it.

The first version was deliberately plain so I could be certain the markup wasn't
hiding a bug. That's confirmed, so the styling is back.

## Install

```
public/app.js
public/index.html
public/styles.css
dist/                            (Vercel rebuilds it anyway)
cloudflare-worker/src/index.js   <- MUST be deployed separately
```

Also delete `api/token.js` and `api/ws.js` if you haven't yet.

## Then test

1. Deploy the Worker, confirm `/health` shows `socket-grace-v13`.
2. Create a **new** room, share your screen.
3. The log should read: `captured screen` -> `publishing video track...` ->
   `video published (track ...)` -> `announced to room (session ...)`.
4. Watch for `room socket closed (code ...)`. If it still drops, send me that
   code -- but it should now recover instead of dying.

If you reach `announced to room`, publishing works for the first time and the
only thing left is the receiving side.
