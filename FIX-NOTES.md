# SimpleShare v10 — Direct mode retired, cloud forced

This is the fix for the actual bug: **your rooms were running in Direct (P2P)
mode, so the entire Cloudflare Realtime / PartyTracks path was never executing.**

## Files in this zip

```
public/index.html              <- mode picker removed
public/app.js                  <- mode forced to cloud
cloudflare-worker/src/index.js <- room mode forced to cloud
dist/                          <- rebuilt (Vercel regenerates this anyway)
```

Copy all of them over the same paths in your repo, commit, push. Vercel
redeploys the frontend automatically; **the Worker needs its own deploy**
(`cd cloudflare-worker && npx wrangler deploy`, or your Cloudflare Git
integration).

## What the bug was

`public/app.js`, in `boot()`:

```js
state.mode = params.get('mode') === 'direct' ? 'direct' : 'cloud';
```

Your invite links carry a `mode` parameter, chosen by the Cloud/Direct picker on
the landing page. And `initPartyTracks()` opened with:

```js
function initPartyTracks() {
  if (state.mode !== 'cloud') return;   // silently does nothing
```

In direct mode, `startSharing()` routes to `startDirectShare()` and
`ensureDirectPeer()` — the legacy peer-to-peer path. PartyTracks is never
constructed, the Worker's `/partytracks/*` route is never called, Cloudflare
Realtime is never contacted.

That is exactly what your Network tab showed: 26 requests, **zero** matching
`partytracks`, and no application errors in the console.

Everything that appeared to work kept working, because none of it depends on the
media path: room presence, the participant list, the LIVE badge, and the local
preview all run through the Durable Object or through `getDisplayMedia()`
directly. Only the remote video needed the SFU, and the SFU was never in play.

It also made the room mode **sticky per room ID**, server-side:

```js
const existingMode = Object.values(state.participants)[0]?.mode || requestedMode;
const roomMode = existingMode;
```

The first participant's mode won for the lifetime of that room, and the client
then did `state.mode = result.mode || state.mode` — accepting the server's
answer. So one direct-mode join permanently locked that room out of the SFU for
everyone, including people who arrived on a cloud link.

## What changed

**`public/index.html`** — the Cloud/Direct picker is gone, replaced by a hidden
`roomMode=cloud` input so the existing `querySelector` in `app.js` keeps working
without a rewrite.

**`public/app.js`**
- `state.mode = 'cloud'` unconditionally; the `?mode=` URL parameter is ignored.
  A stale `mode=direct` link now logs a warning and proceeds in cloud mode.
- New rooms are always created with `mode=cloud`.
- On join, if the server reports a non-cloud room, you get a console warning and
  a toast telling you to create a new room.
- `[SimpleShare] streaming mode: cloud` is logged on every join, so this can
  never again be invisible.
- The `visibilitychange` suspend timer went from 2.5s to 60s. Chrome reports a
  window as hidden when it's **fully covered by another window**, not just when
  you switch tabs — so testing with two overlapping windows on one machine was
  silently tearing down remote video after 2.5 seconds. Unrelated to the main
  bug, but it would have wasted your time next.

**`cloudflare-worker/src/index.js`** — `roomMode` is hardcoded to `'cloud'`, so
no room can be locked to direct mode ever again. Participant limit is now always
`MAX_PARTICIPANTS` (10) rather than 6. Health build string is `cloud-only-v10`.

The v8/v9 Worker fixes (`lockSessionToInitiator: false` and the
`generate-ice-servers` auth exemption) are still in place and unchanged. They
were real bugs — they just sat on a code path nothing was reaching.

## How to verify, in order

1. `curl -s https://simpleshare.gustartzofficial.workers.dev/health`
   → expect `"build":"cloud-only-v10"` and `"directModeRetired":true`.
2. Go to the landing page and click **Create private room**. You must create a
   **brand-new** room — old room IDs may still hold direct-mode participant
   records in their Durable Object.
3. Open F12 → Console before sharing. You should see
   `[SimpleShare] streaming mode: cloud`.
4. F12 → Network, filter `partytracks`, then start sharing. You should now see
   requests appear — `sessions/new` and `generate-ice-servers` first, then
   `tracks/new`. **All of them should be 200.**
5. Send the new link to your friend. Their browser should show `tracks/new`
   requests too (that's the pull side).

If requests now appear but return non-200, the `[partytracks]` logging from v9
is still in the Worker — run `npx wrangler tail simpleshare --format pretty` and
the exact status and upstream error will print.

## Housekeeping, not urgent

`api/token.js` imports `livekit-server-sdk` and `api/ws.js` imports `express`
and `ws` — none of which are in your `package.json`. They're dead leftovers from
the LiveKit era and nothing references them; `public/app.js` only ever calls
`/api/config`. Your builds aren't failing, so they're not hurting anything today,
but delete them when convenient. Fewer serverless functions, fewer surprises.

The legacy direct-mode code (`startDirectShare`, `ensureDirectPeer`,
`handleDirectSignal`, `applyDirectQuality`) is still present in `app.js` but now
unreachable. I left it rather than ripping it out, to keep this diff reviewable.
Once cloud video is confirmed working end to end, deleting it will make the file
substantially easier to reason about.
