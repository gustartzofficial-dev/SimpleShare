# Release notes

## 6.0.0 — 2026-10-05

### Room refinements

- Made screen overlays disappear while viewing, with hover, tap, and keyboard access.
- Replaced persistent per-screen volume sliders with click/tap-open controls and added iPhone/iPad gain-based attenuation.
- Rebuilt focus around one large screen above compact thumbnails, with page controls instead of stage scrollbars.
- Fixed collapsed idle screen tiles and protected active local previews from stale room snapshots or removal events.
- Simplified the room header to the brand icon and adapted focused viewing to portrait and landscape phone layouts.

### Interface

- Rebuilt the landing page and room with a warm cream, ink, and terracotta visual direction, a custom window mark, editorial typography, and an original CSS illustration.
- Added local light/dark appearance, keyboard/focus improvements, reduced-motion support, phone safe-area spacing, a collapsible member list, and usable touch controls.
- Added an explicitly labelled, network-free sample room.
- Consolidated sharing, listening, appearance, and connection settings.

### Sharing and reliability

- Serialized screen-picker requests and stopped captured tracks immediately when sharing ends.
- Applied quality preferences after source selection for broader browser compatibility.
- Discarded whole-monitor audio even when capture hints are ignored.
- Fixed stale direct-mode tiles after remote sharing stops.
- Preserved explicit transport in invite links and removed silent backend-to-direct switching.
- Added validated invitations, selected-text clipboard fallback, actionable connection errors, bounded activity logs, and better reconnect/subscription cleanup.
- Self-hosted fonts and only the icons used by the application.

### Worker

- Required participant authentication for room snapshots and ICE/media requests.
- Enforced media session ownership, room boundaries for remote subscriptions, one screen per participant, and bounded session/payload sizes.
- Fixed prototype-key authentication, stream/session hijacking, abandoned membership, and reconnect-cap loopholes.
- Added exact configured origin restrictions and protected operator diagnostics.
- Replaced the fixed billing-period override with the conservative rolling usage estimator; retained pending accounting on failure and blocked new media when the meter is unavailable.
- Prevented usage-only ticks from unnecessarily changing room snapshot revisions.
- Consolidated the deployed entry onto the maintained RoomHub and BudgetTracker implementation.

### Maintenance

- Removed obsolete UI, audio, and emulator patch layers.
- Added cross-platform builds, lockfiles, formatting/linting, Node regressions, browser/accessibility tests, and a GitHub verification workflow.
- Rewrote README and added manual upload guidance, validation scope, and asset license notices.
