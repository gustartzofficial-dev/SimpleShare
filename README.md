# SimpleShare v19 — the consistency bug

There was one flaw behind the "sometimes it works, sometimes it never does"
behaviour, and it is fixed.

## The flaw

**PartyTracks assigns a new `sessionId` every time it rebuilds its peer
connection.** From its own type definitions:

> An observable of the active peerConnection and its associated sessionId.
> This flows from the peerConnection$, and will emit with the new peerConnection
> **and a new sessionId** when the peerConnection changes.

Rebuilds happen constantly in normal use: an ICE hiccup, a Wi-Fi handover, a
laptop waking, or simply the last subscription dropping -- `session$` is
`shareReplay({ refCount: true })`, so with no subscribers it tears the whole
connection down.

Your own log caught one:

```
20:38:24  Guest YOIP stopped sharing
20:38:24  media connection: connecting
20:38:24  media connection: new
```

connected -> connecting -> new. That is a full rebuild.

**And the client ignored the new id:**

```js
async function addStream(ann) {
  state.streams.set(ann.id, ann);           // stores the NEW metadata
  if (state.subs.has(ann.id)) { return; }   // but never resubscribes
```

The sharer re-announced with a fresh `sessionId`, the viewer overwrote its
stored copy and returned early -- still pulling the old, dead session. Nothing
threw. No error appeared. Video simply never arrived again until a reload.

**And it disabled its own safety net.** The 3-second poll compared incoming
metadata against `state.streams` -- which line 1 had already overwritten with
the new values. New matched new, so the poll saw no change and never repaired
anything.

Whether any given session hit this was pure timing: who stopped sharing when,
whose network blipped. Hence the inconsistency.

Reproduced and verified:

```
announced session after reconnect: SESSION-2
OLD logic subscribed to: SESSION-1  <-- dead session, silent failure
NEW logic subscribed to: SESSION-2  OK
```

## Four fixes

**1. Resubscribe when the target changes.** Each subscription now records the
exact `{sessionId, videoTrackName, audioTrackName}` it is bound to. If an
announcement differs, the old subscription is torn down and rebuilt. Logged as
`... reconnected with a new session — resubscribing`.

**2. The poll compares against reality.** It now checks the live subscription's
target rather than `state.streams`, so it can actually detect and repair drift.

**3. A permanent session subscription.** The client now holds a standing
subscriber on `session$`, so refCount never reaches zero and the connection
stops being torn down whenever the last stream ends. When the id does change
anyway, it is logged and the sharer republishes its metadata automatically.

**4. A frame watchdog.** Every 8 seconds, any tile that is subscribed and still
announced but has received no frames for ~16 seconds is torn down and
resubscribed. This catches every remaining variant of the same class of failure,
including ones neither of us has thought of.

## Also fixed

A race between the 3-second poll and the websocket handler could run two
subscriptions for one stream simultaneously. Rebuilds are now guarded by an
in-flight set.

## Deploy

Frontend carries all four fixes. The Worker only has its build string bumped,
but deploy it anyway so `/health` reads `"build":"consistency-v19"` and you can
confirm what is live.

## What you should see

Reconnections now announce themselves in the log instead of silently killing a
stream:

```
media session rebuilt (b395c42a… → 7f21d004…)
Lusca reconnected with a new session — resubscribing
receiving video from Lusca
```

If a stream still dies with none of those lines appearing, that is new
information -- send the log.
