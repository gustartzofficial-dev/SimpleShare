# SimpleShare v14 — it works; these are the quirks

Your log shows the full pipeline running end to end:

```
20:35:35  video published (track 41d7dd30...)
20:35:35  announced to room (session b395c42a...)
20:34:40  receiving video from Guest YOIP
20:34:40  receiving video from Guest QDCH
20:34:40  media connection: connected
```

Publish, announce, subscribe, receive, three simultaneous streams. Everything
below is polish on a working system.

## Deploy

Copy `public/`, `dist/`, and `cloudflare-worker/src/index.js`, commit, push.
**Deploy the Worker too** -- the identity fix lives there:

```
cd cloudflare-worker && npx wrangler deploy
```

Confirm `/health` shows `"build":"stable-identity-v14"` and
`"resumableSessions":true`.

## One root cause behind three of your quirks

Refreshing minted a brand-new participant every single time:

```js
const participantId = crypto.randomUUID();   // every page load, no exceptions
```

Combined with the 20-25s disconnect grace period I added in v13, that means:

- **F5 spam creates duplicate users** -- each reload is a genuinely new member,
  and the old one lingers until its grace period expires.
- **"The app stopped working, nobody can see or share"** -- ten accumulated
  ghosts hit `MAX_PARTICIPANTS`, so `/join` returned *"Room is full"* and every
  new arrival was refused. The room wasn't broken; it was full of your own
  ghosts.
- **You couldn't see people until F5** -- the member list was populated from a
  snapshot taken at join time, before your friends arrived, and a stale entry
  could keep it from settling.

### Fixed

**Resumable identity.** Your `participantId` and `token` are now stored in
`sessionStorage` per room and presented on join. The server recognises them and
hands back the same identity instead of minting a new one. Refresh as much as
you like -- you stay one person. The log says `rejoined room` rather than
`joined room` when this happens.

**Smarter ghost sweeping.** A member with no live socket is removed once its
grace window expires, or after 30s if it never opened a socket at all.

**Grace-period members don't consume a seat.** Someone mid-reconnect no longer
counts toward the 10-person cap, so the room can't fill up with ghosts.

**Member list refreshes on join** and on every 3s poll, so it settles without a
refresh.

## The friend who couldn't stream

Not enough information yet. Have them open the room, try to share, then send
the activity log. The line to look for is what follows
`publishing video track...`:

- nothing after it -> the track never reached the SFU
- `video publish failed: ...` -> a real error we can name
- `announced to room` present but nobody sees it -> a receiving-side problem

Worth ruling out first, both free: try an incognito window (extensions have
broken `getDisplayMedia` before), and confirm they're on Chrome, Edge or
Firefox rather than Safari, whose screen-share support is patchier.

## UI changes you asked for

**Hide members.** A `Hide members` / `Show members` button in the header
collapses the sidebar so streams take the full width. Your choice persists
across visits.

**Better-aligned streams.** The grid now adapts to how many streams exist:
one fills the stage (capped so it fits without scrolling), two sit side by
side, three or more flow into a grid. Previously a lone stream rendered as a
small box in the corner because the column min-width was fixed.
