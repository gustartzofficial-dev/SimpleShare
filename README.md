# SimpleShare

SimpleShare is a lightweight browser-based screen-sharing application designed
for small groups.

The idea is simple:

1. Open a room.
2. Share the invite link.
3. Anyone in the room can start sharing their screen.
4. Everyone else sees the stream directly in the browser.

There are no user accounts, chat systems, servers to join, or unnecessary
meeting features.

SimpleShare focuses entirely on fast, low-friction screen sharing.

---

## Features

- Invite-link based rooms
- Up to 10 participants per room
- Multiple participants can be present in the same room
- Any participant can share their screen
- Cloud-hosted WebRTC media through Cloudflare Realtime
- PartyTracks handles WebRTC publishing and receiving
- Optional shared system/tab audio
- Screen-share quality presets:
  - 720p / 30 FPS
  - 720p / 60 FPS
  - 1080p / 60 FPS
- Motion/detail optimization for screen capture
- Live participant list
- LIVE indicators for active sharers
- Stream tiles with decoded resolution/FPS statistics
- Expandable stream tiles
- Automatic reconnection
- Room-state recovery after temporary connection loss
- Built-in diagnostics/log panel
- Bandwidth usage meter
- Automatic Cloudflare egress spending guard

---

# How it works

SimpleShare currently has one media architecture.

There is intentionally no P2P fallback and no second WebRTC implementation.

```text
Browser screen capture
        |
        v
PartyTracks.push()
        |
        v
Cloudflare Realtime SFU
        |
        +---- track metadata
        |
        v
Cloudflare Durable Object
        |
        +---- room / participant / stream state
        |
        v
Other participant
        |
        v
PartyTracks.pull()
        |
        v
MediaStreamTrack
        |
        v
<video>
