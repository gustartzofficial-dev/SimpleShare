# SimpleShare v15 — quality fix, self-closing rooms, live stats

Deploy both halves. `/health` must show `"build":"quality-v15"`.

```
cd cloudflare-worker && npx wrangler deploy
```

## The slideshow: my fault, and fixed

Two things I removed in the v12 rewrite were doing real work.

**1. No contentHint.** A screen-share track with no `contentHint` makes Chrome
default to `degradationPreference: "maintain-resolution"`. Under any pressure --
CPU, bandwidth, encoder load -- it holds full resolution and throws away
framerate. That is precisely how you get a crisp 4fps slideshow. Setting
`contentHint = "motion"` flips it to maintain-framerate: it drops resolution
instead and keeps motion smooth.

There is now a **Motion / Detail** selector next to the quality dropdown:

- **Motion (games, video)** -- smooth framerate, softer under load. Default.
- **Detail (code, docs)** -- sharp text, framerate drops when busy.

**2. No maxBitrate.** I dropped `sendEncodings` in v12 to eliminate a suspected
failure point. It wasn't the problem, and without an explicit ceiling the
browser caps screen share well below what these profiles need, starving the
picture even on a healthy connection. Ceilings are back: 2.5 Mbps at 720p30,
4 Mbps at 720p60, 8 Mbps at 1080p60. Still a single encoding -- no simulcast.

If it's still rough after this, 1080p60 may simply be more than the sender's CPU
can encode. Have them try 720p60 with Motion -- that is the sweet spot for
games, and what Discord itself defaults to for most users.

## Live stats on every tile

Each tile's corner now shows real decoded resolution and framerate, updated
every 2 seconds, measured from the actual video frames:

- **Full resolution, low fps** -> the encoder is dropping frames. CPU, or the
  wrong contentHint.
- **Collapsed resolution** -> bandwidth. This is where TURN and bitrate matter.
- **Numbers look fine but it feels bad** -> the receiving machine is struggling
  to decode or paint.

This turns "it's laggy" into something diagnosable.

## Rooms now close themselves

You described exactly the model you wanted, and it's now what happens:

- A room exists because someone is in it. Creating one gives you no special
  status -- the creator is just another user, and always was.
- When the last person leaves, the room's state is **deleted entirely** by the
  cleanup alarm. Nothing lingers for whoever opens the link next.

### What the grace period actually is

It only concerns *reconnection*, not ownership. If your connection to the room
drops, the server used to delete you instantly -- which killed your token, so
reconnecting returned 401 and your session was unrecoverable. That was the v13
bug. Now the server waits 20 seconds before removing you, so a brief blip lets
you return as the same person with the same stream. Longer than that and you're
removed normally, and if you were the last one, the room disappears with you.

## Still outstanding: the friend who can't share

I need their activity log -- specifically what appears after
`publishing video track...`. Nothing after it, a `video publish failed:` line,
or an `announced to room` that nobody sees are three different problems with
three different fixes, and I can't tell which without seeing it.

Two free checks first: an incognito window (browser extensions have broken
`getDisplayMedia` before), and confirm they're on Chrome, Edge or Firefox rather
than Safari.

## Your connection issue on a new room

The log you sent is clean end to end -- join, socket, subscribe, publish,
announce, all fine. Whatever failed happened *before* the refresh, so that log
is the one I need. If it recurs, grab the log before pressing F5.
