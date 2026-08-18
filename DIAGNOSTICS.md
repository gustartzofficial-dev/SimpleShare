# SimpleShare — v9, diagnostics build

The v8 fix removed two real, provable bugs. If video still doesn't flow, there's
a third thing wrong, and I don't want to keep guessing at it. This build makes
the failure point visible instead.

Same drop-in as before: copy `cloudflare-worker/src/index.js` over your file,
commit, deploy.

## Two changes to the fix itself

**Removed the header-stripping I added in v8.** It rebuilt the request with
`new Request(request, { headers })` to avoid forwarding participant tokens
upstream. That was tidiness, not a fix, and it carried a real risk: if the
rebuild drops `Content-Length`, `routePartyTracksRequest` only forwards a body
when `Content-Length > 0 || Transfer-Encoding` is present — so `tracks/new`
would go upstream with **no body** and Cloudflare would answer 400. That could
have masked the actual fix. The original request now passes through untouched.

**`lockSessionToInitiator: false` and the `generate-ice-servers` auth exemption
are unchanged.** Those two were verified against the library source and are
correct regardless of what's still broken.

## Run these three checks, in order

### 1. Did the deploy land?

```
curl -s https://simpleshare.gustartzofficial.workers.dev/health
```

Expect `"build":"partytracks-fix-v9-diagnostics"`. Anything else and the Worker
never updated — everything below is meaningless until this line is right. This
is the single most common reason a fix "doesn't work."

### 2. Are the Cloudflare credentials actually valid?

New endpoint. It calls Cloudflare Realtime directly from the Worker, bypassing
PartyTracks and the browser completely:

```
curl -s https://simpleshare.gustartzofficial.workers.dev/debug/realtime
```

- `{"ok":true,...}` — App ID and Secret are good. The problem is downstream.
- `{"ok":false,"upstreamStatus":401,...}` — **this is your answer.** Your
  `CF_REALTIME_APP_SECRET` is wrong, expired, or belongs to a different App ID.
  Every `tracks/new` would return 401 no matter what I change in the code,
  because `routePartyTracksRequest` passes Cloudflare's 401 straight through.
  Regenerate both values in the Cloudflare dashboard (Realtime → SFU) and
  re-set them with `npx wrangler secret put CF_REALTIME_APP_SECRET`.
- `{"ok":false,"reason":"missing-credentials"}` — the secrets aren't bound to
  this Worker at all.

It never prints the secret, only its length.

### 3. Watch the Worker while you reproduce

In a terminal:

```
npx wrangler tail simpleshare --format pretty
```

Then have both people join a fresh room and share. Every failing PartyTracks
request now logs as:

```
[partytracks] POST /partytracks/sessions/<id>/tracks/new -> <status> :: <upstream body>
```

That line tells us exactly who is rejecting what. Failing responses also carry
an `x-ss-pt-status` header now, visible in F12 → Network → Headers.

## What I need from you

Paste back:

1. The `/health` output.
2. The `/debug/realtime` output.
3. Any `[partytracks]` lines from `wrangler tail` during a failed share.
4. Whether the sharer's own tile shows video, and whether the viewer's tile says
   "Connecting to stream…" or "Stream connection failed: …" (that second string
   contains the real error).

With those four I can tell you what's wrong instead of theorizing.

## Two things I already suspect, worth checking meanwhile

**The `focusedId` gate.** In `ensureCloudSubscription`:

```js
if (state.focusedId && state.focusedId !== ann.id) return;
```

If either person has clicked a tile into focus view — including their own local
preview — every *other* incoming stream is silently skipped. No error, no log,
just no video. Test in plain grid view with nothing focused.

**PeerConnection state.** In the viewer's console:

```js
setLogLevel('debug')
```

before sharing (PartyTracks exports it). If you see `iceconnectionstatechange`
going to `failed`, that's a NAT/TURN problem, not an auth problem, and the fix
is wiring up Cloudflare TURN — two commented lines are already in the patched
file waiting for `CF_TURN_APP_ID` / `CF_TURN_APP_TOKEN`.

---

To answer the actual question: yes, there's a solution. This is a working
architecture that thousands of Cloudflare Realtime apps run on. You have a
misconfiguration somewhere in a four-layer stack, and we've now eliminated two
layers with certainty. The remaining candidates are a small, finite list, and
step 2 above splits it roughly in half in one command.
