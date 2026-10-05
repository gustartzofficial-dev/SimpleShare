# SimpleShare

A screen, a link, and your people. SimpleShare is a browser room for showing a game, an idea, or whatever is on your screen. Create a room, send the invite, and share. No account, install, chat, or voice call.

Version 6 rebuilds the interface around that original idea: a warm, distinctive landing page, a focused viewing room, and a phone-friendly experience. The frontend and Worker must be updated together.

## Use a room

1. Choose **Create a room** and copy its invite.
2. Send the link to your people. Anyone with the link can join.
3. On a supported desktop browser, choose **Share screen** and select a tab, window, or display.
4. Viewers choose **Watch** on a shared screen. Up to three remote screens can be watched at once.
5. Use **Stop sharing** to release capture immediately. **Leave room** removes your membership.

The room creator has the same permissions as everyone else. Cloudflare rooms allow up to 10 participants, including temporarily reserved reconnecting members. Each participant can share one screen. There are no accounts, moderation controls, recording, camera feeds, or microphone calls.

**Explore the room** opens a clearly marked sample at `/?demo=1`. It does not join a service, send media, or show fabricated network statistics.

## What's included

- A responsive layout, touch-sized controls, safe-area spacing, collapsible phone member list, and a focused screen stage.
- Local light and dark appearances, reduced-motion support, keyboard navigation, labelled controls, and a native settings dialog.
- Validated invite links, honest clipboard fallback, useful connection errors, and explicit reconnect behavior.
- Display names, opt-in presence sounds, playback volume, click/tap-open per-screen audio sliders, focus/fullscreen, and decoded video statistics.
- Screen controls fade away while viewing and return on hover, tap, or keyboard focus. Focus mode keeps one large screen above compact thumbnails; page buttons handle larger rooms without scrolling the viewing stage.
- Active local capture remains visible when room snapshots temporarily omit its announcement.
- 720p / 30 fps, 720p / 60 fps, and 1080p / 60 fps preferences, plus motion or detail optimization. Actual capture and playback depend on the browser, source, device, and connection.
- Optional captured source audio. Whole-display system audio is excluded, including when a browser returns it despite the capture hint. No microphone is requested.
- Authenticated room snapshots and media/ICE routes, session ownership checks, bounded payloads and diagnostics, reconnect reservations, and an estimated usage guard.

## Browser and phone support

Current desktop Chromium, Firefox, and Safari are the intended browsers. Screen capture needs a secure context: HTTPS in production, or localhost for development. Capture source choices and source audio vary between browsers and operating systems; the app does not promise universal tab or application audio.

Phones and tablets are primarily viewers. If `getDisplayMedia` is unavailable, sharing is disabled with an explanation while watching and room controls remain available. An explicit audio action may be required by autoplay policies. On iPhone/iPad, playback attenuation uses a Web Audio gain node rather than relying solely on the restricted media-element volume property; see [Apple’s media guidance](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html). Native fullscreen is used where supported, with an in-room focus fallback.

The automated suite covers Chromium, Firefox, and WebKit layouts and browser behavior. Browser emulation does not replace testing on physical iOS and Android devices.

## Architecture

The default media path is Cloudflare Realtime SFU through PartyTracks. A publisher uploads once to the SFU, which forwards media to viewers.

```text
Browser
  ├─ /api/config → Vercel function → public Worker URL
  ├─ room API / WebSocket → Cloudflare Worker → RoomHub Durable Object
  └─ PartyTracks media API → authenticated Worker proxy → Realtime SFU
                                                └─ authenticated ICE / TURN
RoomHub → global BudgetTracker Durable Object → conservative usage estimate
```

`cloudflare-worker/src/profile-worker.js` is the deployed entry and re-exports the single implementation in `src/index.js`. RoomHub holds membership, announcements, session permissions, reconnect state, and WebSocket fan-out. It does not store recordings. BudgetTracker keeps daily usage buckets.

Room membership issues a private participant token. Protected calls require that token, and a media session must belong to the caller. Remote subscriptions are limited to sessions announced in the same room. These checks establish room boundaries; they do not create an account system or host moderation.

### Explicit direct mode

Connection settings or the connection error screen can create a **direct** invite containing `?room=…&p2p=1`. Everyone must use that same invite. The app never silently switches a Cloudflare room to direct mode.

Direct mode uses encrypted signaling messages through public EMQX/HiveMQ/Mosquitto MQTT brokers, WebRTC peer connections, public STUN, and a public OpenRelay TURN service when needed. Broker operators can observe connection/topic metadata. Anyone with the room invite can participate. Availability and confidentiality of the invite depend on the services and how you share it.

Publishers upload separately to every watching peer. The Worker membership cap and usage estimate do not apply to direct rooms. Direct mode is a convenience fallback, not an equivalent managed service or a way to guarantee connectivity.

## Run locally

Use Node.js 22 or newer and npm.

```sh
npm ci
npm run build
npm run dev
```

Open [localhost:4173](http://127.0.0.1:4173), or [the sample room](http://127.0.0.1:4173/?demo=1). The sample works without credentials.

For a local Cloudflare room, start the Worker in a second terminal:

```sh
cd cloudflare-worker
npm ci
# Copy .dev.vars.example to .dev.vars and supply your own credentials.
npm run dev
```

Then supply its URL to the frontend server. The local server reads the process environment; it does not automatically load `.env`.

PowerShell:

```powershell
$env:ROOM_API_URL = "http://127.0.0.1:8787"
npm run dev
```

macOS/Linux:

```sh
ROOM_API_URL=http://127.0.0.1:8787 npm run dev
```

The local server is a development preview, bound to localhost. It is not a production server. Rebuild after source changes.

## Deploy the Worker

1. Create a Cloudflare Realtime SFU application.
2. Install Worker dependencies and authenticate Wrangler.
3. Set the SFU credentials as Worker secrets:
   ```sh
   cd cloudflare-worker
   npm ci
   npx wrangler login
   npx wrangler secret put CF_REALTIME_APP_ID
   npx wrangler secret put CF_REALTIME_APP_SECRET
   ```
4. For restrictive networks, create your own Cloudflare TURN key and set:
   ```sh
   npx wrangler secret put CF_TURN_APP_ID
   npx wrangler secret put CF_TURN_APP_TOKEN
   ```
5. In `wrangler.toml`, set `ALLOWED_ORIGINS` to the exact HTTPS frontend origins, comma-separated, without paths or trailing slashes. Include only preview origins you intentionally allow.
6. Review `MONTHLY_EGRESS_CAP_GB`, then run `npm run deploy`.

Leaving `ALLOWED_ORIGINS` unset preserves permissive origin behavior for migration. Configure it for production. CORS is browser access control, not authentication or abuse prevention: this remains a public invite-link service. Consider provider rate limits and access policies if your deployment is targeted.

`FALLBACK_TURN_DISABLED = "1"` disables the public relay fallback for Cloudflare rooms. Supply your own TURN instead. Changing it to `"0"` explicitly opts into the public fallback; direct rooms have their separate public relay configuration.

The operator diagnostic endpoint `/debug/realtime` is disabled unless you set a `DEBUG_TOKEN` secret and authenticate with `Authorization: Bearer <token>`. It can create a test SFU session. Browser activity diagnostics use `?room=…&debug=1`; they do not require or expose that operator token.

The Windows helpers under `tools/` can configure and verify TURN on your deployed Worker. The configuration helper also deploys; the verifier temporarily joins a fresh room and leaves after its authenticated ICE check.

## Deploy the frontend

The included `vercel.json` builds `dist/` and exposes `api/config.js`.

1. Import the repository into Vercel.
2. Set `ROOM_API_URL` to your deployed Worker URL.
3. Build with `npm run build`; output directory is `dist`.
4. Deploy over HTTPS and confirm its origin matches `ALLOWED_ORIGINS`.

Only the public Worker URL goes into the frontend. SFU and TURN secrets belong on the Worker.

Other hosts must serve `dist/` and implement `GET /api/config` returning `{"roomApiUrl":"https://your-worker.example"}`. Uploading the static directory alone does not provide this endpoint. Assets assume a site-root deployment.

## Usage guard and billing

The default cap is an **estimated 900 GB rolling usage guard**, not a billing guarantee.

RoomHub estimates outbound media from configured video bitrate, an audio allowance, elapsed time, and every potential room viewer. It deliberately does not trust client Watch reports. Usage uses decimal GB and daily buckets covering the preceding 31 days plus the current date, retaining the entire oldest overlapping bucket. It is more conservative than a precise sliding window and does not model Cloudflare's billing month.

When the estimate reaches the cap, new media operations are blocked and the room asks clients to stop sharing. If the meter is unavailable, new media requests fail closed and pending estimates are retained for retry. Existing SFU sessions, delayed alarms, network overhead, TURN usage, malicious clients, other applications in the account, and Workers/Durable Object costs can differ from this estimate.

Check the Cloudflare dashboard, configure account alerts, and review [current Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/). The application cannot guarantee a zero bill.

## Portrait desktop monitors

Portrait desktop monitors (at least 800 CSS pixels wide, portrait orientation, mouse/hover input) now use centered, full-width screen cards stacked vertically, with adjacent focus thumbnails. Phone and landscape desktop layouts retain their existing rules.

## Connection reliability audit

The latest audit adds bounded network deadlines, one owner for transport recovery, lazy media sessions and retired-session cleanup, ordered room updates, announcement retries, bounded transport history, and direct-mode connection IDs. Deploy both frontend and Worker. Health revision: session-lifecycle-2026-10-05.

Live diagnostics found TURN secrets present but rejected, with no relay URLs. CF_TURN_APP_ID must be a Cloudflare TURN key ID and CF_TURN_APP_TOKEN must be the API token from that same key. These are not SFU credentials or a general account API token. GitHub uploads do not configure Worker secrets. The tools verifier checks actual generated relay URLs. See RELIABILITY_AUDIT.md for findings and the unsuccessful live test on the current network.

## Multi-screen reliability update

The bundled PartyTracks 0.0.56 client is maintained in `public/vendor/partytracks.js` with a narrow negotiation fix: stop every transceiver in a close batch, validate the answer, route rejected pull promises into subscription recovery, and retire connections with uncertain SDP state. This prevents retries against poisoned sessions during simultaneous publishing and watching. `public/lib/media-session.js` contains the tested cleanup and retirement helpers.

A single failed source now pauses its own subscription instead of repeatedly resetting healthy receivers and the local publisher. Live decoded still screens are excluded from frame-stall recovery.

If ICE logs report `cannot find specified key`, Cloudflare rejected the configured TURN key. Update both `CF_TURN_APP_ID` and `CF_TURN_APP_TOKEN` on the Worker using a valid matching pair. The Worker returns Cloudflare STUN discovery plus a clear diagnostic when TURN rejects its credentials; strict networks still need a working relay. Deploy both frontend and Worker for this update.

## Upgrade from earlier versions

- Deploy the frontend and Worker together. Old clients may fail the new authenticated API checks; ask existing users to refresh.
- Keep the existing Worker name, `ROOMS` / `BUDGET` bindings, and migration tags when updating an existing deployment. Do not replay migrations or delete Durable Objects.
- Existing daily usage buckets are retained. Fixed billing-anchor variables from earlier versions are no longer used.
- Old profile/avatar and UI patch layers are removed. The new interface uses initial avatars, local appearance settings, and one source implementation.
- Rebuild `dist/` from the new source. Remove obsolete files listed in `UPLOAD.md`, especially if uploading through GitHub's web UI.
- Review origin restrictions, credentials, and the cost estimate before reopening production rooms.

## Development and verification

```sh
npm run check                    # lint, Node regressions, production build
npm run format:check             # source formatting
npx playwright install chromium firefox webkit
npm run test:browser             # browser, accessibility, and direct video tests
cd cloudflare-worker
npm ci
npm run build
npx wrangler deploy --dry-run    # bundle check; does not publish
```

Browser checks include narrow layouts, settings and focus, storage/clipboard failures, unsupported capture, capture cancellation and cleanup, audio privacy, automated accessibility, and real video between two local direct-mode browser sessions using a simulated signaling broker. They do not verify a deployed SFU or commercial relay.

See `VALIDATION.md` for the checks performed on this release.

## Project layout

| Path                                  | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `public/`                             | Frontend source, HTML, styles, favicon                            |
| `public/lib/`                         | Invite/storage, UI, sounds, direct transport, media negotiation   |
| `dist/`                               | Committed production build, local fonts/icons and license notices |
| `api/config.js`                       | Vercel public configuration endpoint                              |
| `cloudflare-worker/`                  | Room/media API, Durable Objects, deployment config                |
| `scripts/`                            | Cross-platform build and local preview                            |
| `tests/`                              | Node regressions and Playwright browser coverage                  |
| `tools/`                              | Windows TURN configuration and verification                       |
| `DESIGN.md`                           | Interface direction and design choices                            |
| `UPLOAD.md`                           | Manual GitHub upload and suggested commit                         |
| `THIRD_PARTY_NOTICES.md`, `licenses/` | Font, icon, and vendored media client attributions                |

## License

The original project dedication remains **CC0 1.0 Universal**; see `LICENSE`. Bundled Geist font and Phosphor icon assets retain their own licenses, included in `licenses/` and `THIRD_PARTY_NOTICES.md`. Runtime dependencies retain their respective upstream licenses.

### Screen publishing hotfix

If an older client reports `Video publish failed: Expected a JSON object.`, deploy the updated Worker first, then the frontend and refresh. Session creation now accepts an empty transport body and the client sends explicit JSON. Keep working TURN credentials unchanged.

## Corrected SFU session-creation hotfix

The previous empty-body hotfix was incomplete: forwarding `{}` to Cloudflare causes `Body JSON validation error: sessionDescription`. Cloudflare requires no upstream body when creating a session without an SDP offer. The corrected Worker accepts old empty client requests and current `{}` requests, then sends no upstream body. Explicit SDP and track mutation bodies are preserved.

Deploy the updated Cloudflare Worker; uploading frontend files alone will not apply this correction. No further frontend change or TURN secret change is required for this fix. Confirm `/health` reports `reliabilityRevision: session-body-v2-2026-10-05`, then refresh and retry sharing. A successful room log must show `sessions/new` returning 200 or 201, followed by successful `tracks/new`.
