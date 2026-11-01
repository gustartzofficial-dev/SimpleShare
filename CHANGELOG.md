# Release notes

## 6.2.0 — 2026-11-01

- Preserve per-stream mute and zero volume across replacement audio tracks, reconnects, recreated tiles and refreshes. Cloud and direct streams now use one attachment path that applies listening choices before autoplay.
- Separate per-stream levels from master playback controls, retain individual mute choices when master mute is released, and ignore stale playback failures from replaced sources. Persist bounded room/publisher listening preferences locally.
- Replace the in-stage owner banner with independent top-right notification popups that also appear on the homepage, preserve the stream layout and fit mobile screens.
- Add authenticated maintenance-warning settings to the owner console. Enable, edit or disable the warning without interrupting sharing. Reject stale notice revisions after an update or removal.
- Provide both a full release and a changed-files-only upload, compared against the 6.1.0 release manifest. Deploy both the Worker and frontend; existing admin and TURN secrets remain unchanged.

## 6.1.0 — 2026-10-29

- Replace the rolling 31-day bandwidth guard with a monthly UTC billing cycle, configurable from the owner console, with explicit cycle dates and short-month handling.
- Add a private Worker-hosted owner console at `/admin` with rate-limited password authentication, expiring server-side sessions, same-origin action checks, and a persistent change history.
- Add a confirmed manual counter reset that reopens the application, bypasses stale blocked caches, and excludes delayed pre-reset accounting. Preserve the monthly schedule.
- Add expiring plain-text owner messages for all updated rooms on the deployment, including configured direct rooms, with dismissal and early removal.
- Apply the usage guard consistently to legacy and current media APIs; serialize meter mutations and atomically save manual reset state.
- Add monthly migration/rollover, authorization, reset, cross-room announcement, browser accessibility and mobile regressions. No new bindings or migrations; deploy Worker and frontend, and configure `ADMIN_PASSWORD` as a Worker secret.

## 6.0.0 — 2026-10-06 follow-up

- Restored a second tab/app audio source with live screen/extra level controls, one stable mixed outgoing track, cancellation-safe selection and complete capture cleanup.
- Close selected SFU tracks with `force: true` and no SDP exchange so surviving streams retain their transport. Recognize already-closed results, retry unresolved mids in order, and preserve stable sessions on forced-close failures.
- Added actual-browser media continuity and audio source/lifecycle regressions.

## 6.0.0 — 2026-10-05

### Corrected SFU request body

- Omit the upstream body for session creation without an SDP offer. Sending `{}` makes Cloudflare return `decoding_error: Body JSON validation error: sessionDescription`. Corrected both proxy routes and added strict contract regressions.
- The Worker health revision is now `session-body-v2-2026-10-05`.

### Screen-publishing hotfix

- Fixed `Video publish failed: Expected a JSON object.` when an empty session-creation POST arrives as a zero-byte body stream. The frontend now sends `{}` explicitly; the Worker accepts an empty body only for session creation. Malformed JSON and empty track mutations remain rejected.
- Added Worker and Chromium/Firefox request regressions.

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
