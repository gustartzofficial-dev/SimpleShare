# SimpleShare — PartyTracks 401/400 fix

One file changed: `cloudflare-worker/src/index.js`. No frontend changes, no
dependency changes, no Durable Object schema changes.

## Drop-in instructions

1. Copy `cloudflare-worker/src/index.js` from this zip over the same path in
   your repo (it overwrites the whole file — the only edits are inside the
   `partytracks` route block and the `/health` payload).
2. Commit and push.
3. Deploy the Worker (`cd cloudflare-worker && npx wrangler deploy`, or let
   your Cloudflare Git integration run).
4. Verify the deploy landed before testing anything else:

   ```
   curl -s https://simpleshare.gustartzofficial.workers.dev/health
   ```

   You want `"build":"partytracks-sessionlock-fix-v8"` and `"sessionLock":false`.
   If you still see `partytracks-baseline-v6`, the deploy didn't go out and
   nothing below will have changed.
5. Open a **brand new room** in two browsers and share a screen.

`PATCH.diff` in this zip is the same change as a unified diff if you'd rather
apply it with `git apply PATCH.diff` or review it line by line first.

---

## What was actually wrong

### The 401 on `/partytracks/sessions/<id>/tracks/new`

Not your auth. It came from inside `routePartyTracksRequest` in
`partytracks@0.0.56`:

```js
lockSessionToInitiator = process.env.NODE_ENV === "production"
...
// on /sessions/new:
headers.append("Set-Cookie",
  `partytracks-session-${sessionId}=${jwt}; HttpOnly; Secure; SameSite=Strict; Path=${prefix};`);
...
// on every other /sessions/* path:
const cookieHeader = request.headers.get("Cookie");
if (!cookieHeader) return unauthorizedResponse();   // -> 401 "unauthorized"
```

`lockSessionToInitiator` defaults to ON in a deployed Worker. PartyTracks issues
a JWT cookie on `sessions/new` and demands it back on every `tracks/new`,
`renegotiate`, `tracks/update` and `tracks/close`.

That cookie cannot survive this topology, for three independent reasons:

1. The PartyTracks client never sets `credentials` on its fetches
   (`#fetchWithRecordedHistory` sets only `headers` and `redirect: "manual"`).
   The default is `same-origin`, so a cross-origin `Set-Cookie` is discarded and
   never sent back.
2. `SameSite=Strict` blocks it cross-site regardless — Vercel and `workers.dev`
   are different registrable domains.
3. The Worker never sent `Access-Control-Allow-Credentials`, which would be
   required even if 1 and 2 were solved.

Cookie never stored -> never sent -> `if (!cookieHeader)` -> 401, forever, even
in a fresh room.

**Proof it was never SimpleShare's auth:** the failing URL contains a real
`<session-id>`, which could only have come from a *successful*
`POST /partytracks/sessions/new` — a request that passed the identical
`verify()` call with the identical headers moments earlier.

**Fix:** `lockSessionToInitiator: false`. Safe, because `verify()` already does
that job better. The cookie only proved "same browser that opened the session";
the participant token proves "authorized member of this room".

### The 400 on `/partytracks/generate-ice-servers`

This one was ours. PartyTracks fetches that endpoint with a bare rxjs
`fromFetch()` that bypasses its own fetch wrapper:

```js
iceServers: options.iceServers
  ? of(options.iceServers)
  : fromFetch(`${options.prefix}/generate-ice-servers`, { selector: ... })
```

So it carries neither `config.headers` nor `apiExtraParams`. No `x-room` header
arrived, so the Worker's `if (!ROOM_RE.test(room)) return json(..., 400)` fired.

This was **not** cosmetic. The 400 body was still valid JSON, so `body.iceServers`
resolved to `undefined` instead of throwing, and the peer connection was built as
`new RTCPeerConnection({ iceServers: undefined, bundlePolicy: "max-bundle" })` —
no STUN, no server-reflexive candidates, no route to a public SFU from behind
NAT. Fixing only the 401 would have cleared the console errors and still given
you black tiles.

**Fix:** exempt that one path from room auth. It returns only public STUN URLs
and exposes nothing.

### Also included

Participant credentials (`x-room`, `x-participant-id`, `x-participant-token`)
are now stripped before the request is forwarded upstream. `routePartyTracksRequest`
copies incoming headers wholesale onto its call to Cloudflare's API; there's no
reason to hand SimpleShare's room tokens to a third-party endpoint.

---

## What was already correct — don't change it

- **Secret handling.** `routePartyTracksRequest({ appId, token, request })` reads
  `CF_REALTIME_APP_SECRET` from Worker env and injects `Authorization: Bearer`
  server-side. The secret never reaches the browser. This was right.
- **The metadata flow.** `push()` emits
  `TrackMetadata { location, trackName, sessionId, mid }`; `pull()` needs
  `{ trackName, sessionId, location: 'remote' }`. `metadataForRoom()` produces
  exactly that, and the Durable Object stores `sessionId` + `videoTrackName` +
  `audioTrackName`. Storing one `sessionId` for both tracks is correct — one
  `PartyTracks` instance means one session for all pushes.
- **Header-based auth on `/partytracks/sessions/*`.** Fine. The only rule to
  remember: anything the client fetches with bare `fromFetch` cannot carry your
  headers. Today that is exactly one endpoint.

## Do not deploy `partytracks-auth-v7`

Its premise was inverted. Threading a media token through `apiExtraParams` works
mechanically (those params *are* appended to `sessions/new`, `tracks/new`,
`renegotiate`, `tracks/update`, `tracks/close`) — but it hardens a layer that was
never rejecting you and leaves the layer that was completely untouched.

---

## If it still fails after this

Check the response body of any remaining 401 in F12 → Network → Response:

- `unauthorized` (plain lowercase string) — still PartyTracks' session lock, so
  the deploy didn't land. Re-check `/health`.
- `{"error":"Unauthorized (SimpleShare room auth)"}` — now genuinely our
  `verify()`, meaning a stale/invalid participant token. Rejoin the room.

One inconsistency worth confirming while you test: on the pre-fix code, a 401 on
`push()` means `publishState()` never runs, so `upsertRoomStream()` and the
`stream-upsert` websocket message never fire — the Durable Object should never
have learned about the stream, and B should **not** have seen A as LIVE. Since
you reported that it did, that LIVE state was probably stale room state or an
earlier build rather than `partytracks-baseline-v6`. Test on a fresh room so
you're not chasing a ghost.

## Next, once video actually works

- **TURN.** STUN alone connects most users; symmetric NAT and restrictive
  corporate networks need TURN. Two commented lines are already in place in the
  patched file — create a TURN key in the Cloudflare dashboard, add
  `CF_TURN_APP_ID` / `CF_TURN_APP_TOKEN` as Worker secrets, and uncomment.
- **`Permissions-Policy`.** The `camera is not allowed` console warning is
  PartyTracks probing `enumerateDevices` and is harmless. Your current
  `camera=(), microphone=(), display-capture=(self)` is correct for a
  screen-share app — keep it. Note `microphone=()` will block mic capture if you
  ever add it; `getDisplayMedia({ audio: true })` for system audio is unaffected.
- Only then revisit simulcast and per-viewer quality.
