# Validation — SimpleShare 6.0.0

Checked locally on Windows on 2026-10-05 with Node.js 24.19.0.

| Check                            | Result                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint                           | Passed, no reported errors or warnings                                                                                                |
| Node regression tests            | 56 passed                                                                                                                             |
| Production frontend build        | Passed                                                                                                                                |
| Prettier source formatting       | Passed                                                                                                                                |
| Browser checks                   | 79 distinct cases verified across runs: 34 Chromium, 34 Firefox, 11 WebKit phone                                                      |
| Automated accessibility          | No axe violations for the tested WCAG A/AA rules on home, sample room, and desktop settings in the tested appearances                 |
| Worker syntax checks             | Passed for core and deployed entry                                                                                                    |
| Wrangler deployment dry run      | Passed; no deployment performed                                                                                                       |
| Local workerd runtime smoke      | Passed: Durable Object membership/persistence, 10-person cap, authenticated snapshot, native WebSocket, immediate leave, clean rejoin |
| Dependency audit at installation | npm reported zero known vulnerabilities in root and Worker dependency trees                                                           |

The room refinement follow-up adds overlay visibility, volume popover, iOS gain-path unit coverage, focused thumbnail paging, landscape idle tiles, icon-only branding, and local-preview preservation regressions. The final targeted browser run contains 35 cases. A Firefox screenshot exceeded the earlier 30-second timeout; the affected case was rerun serially with the 60-second test allowance.

## Browser coverage

- Home layout at 320, 390, 768, and 1440 pixels.
- Validated invite navigation, room creation, and missing-configuration errors.
- Network-free labelled sample, settings focus/Escape, appearance persistence, blocked storage, clipboard rejection, and mobile member controls.
- Unsupported mobile capture, double capture requests, track cleanup, picker cancellation, and whole-monitor audio exclusion.
- Actual video exchanged between two local direct-mode browser sessions in Chromium and Firefox, using canvas capture, a simulated MQTT signaling broker, and local WebRTC. Stopping sharing removes the remote tile; leaving updates the roster.
- WebKit phone portrait/landscape layout, viewing controls, settings, accessibility, fading touch controls, volume popover, focus thumbnails, and idle tile actions.
- Snapshot and removal events leave live local capture intact; explicit stop releases its track.
- Focus and grid paging fit the viewing stage without scrollbars, including short landscape viewports.
- Visual inspection of stable desktop/home and phone room screenshots.

## Scope still requiring deployment checks

No production Cloudflare credentials were supplied. The release was not pushed or deployed. Tests do not establish live SFU interoperability, Cloudflare TURN connectivity, public broker/relay uptime, physical phone performance, every browser audio-capture combination, or exact provider billing.

Before reopening a production deployment, update the Worker and frontend together and test on two real devices, including a phone viewer and a restrictive network. Check provider usage separately from the application's conservative estimate.

Local test outputs and screenshots are under work/qa in the working folder. They are excluded from the clean upload package. The repository includes the tests and reproducible check commands.

## Multi-screen reliability hotfix

The supplied log shows `invalid_session_description` (406) before the fourth publication, successful publication at 11:26:12, and `session_error` (410) on subsequent pulls after the shared connection lost connectivity. It also shows TURN discovery returning 404 (`cannot find specified key`). This indicates a failed negotiation/session recovery sequence, not evidence of a four-member service limit.

Code inspection found that PartyTracks 0.0.56 stopped only the first transceiver in a batched close, did not validate close failures, and failed to catch the rejected pull dispatcher promise. The patched client closes all batch members and retires uncertain sessions. One failed source no longer triggers application-wide resets; live decoded still screens are treated as healthy.

The local four-screen browser regression uses the actual patched PartyTracks client and browser WebRTC with a simulated SFU HTTP endpoint backed by another RTCPeerConnection. It receives three video/audio pairs, publishes a fourth video/audio pair, closes one received pair in a batch, and checks continued video frames and live remaining tracks. This is local negotiation coverage, not a deployed Cloudflare load test.

Node regression suite: 41 passed. Lint, formatting, production build, Worker syntax, and Wrangler dry-run passed. Real deployed SFU/TURN verification still requires valid credentials and testing between devices.

The hotfix browser checks cover three received screens plus local video/audio publishing in Chromium and Firefox, batched closure without losing the remaining video, stalled-source isolation, and still-screen preservation. Test videos are visibly positioned so Firefox can render frame callbacks. Earlier fixture timing and overlapping-run server/trace conflicts were resolved by a single isolated run.

Final isolated hotfix browser run: 33 passed (11 Chromium, 11 Firefox, 11 WebKit phone).

## Portrait desktop monitor follow-up

A dedicated portrait layout applies only at widths of 800 CSS pixels or more with portrait orientation and mouse/hover input. Full-width 16:9 screen cells stack in a centered column; focus thumbnails stay adjacent. Narrow phone and landscape desktop layouts retain their existing rules. Lint, all 41 Node tests, and the production build passed. Chromium and Firefox coverage checks stacked card proportions, visible Watch controls, adjacent focus thumbnails, overflow, and resizing back to normal layouts.

## Complete reliability audit

The full local browser run passed 76 of 77 cases and exposed delayed direct-room discovery in Firefox. The immediate greeting reply fixed that issue. The final targeted transport run passed all 14 cases, including both directions of real direct video, three remote screens plus publishing, idle engine disposal, terminal authorization handling, and announcement retry. Combined with the full run, 79 distinct browser cases were verified across runs. Node regression suite: 54 cases.

Live deployed TURN diagnostic: secret bindings present, credential generation rejected, zero TURN URLs. A temporary four-participant live synthetic-video SFU attempt remained connecting with no successful publication; memberships and browsers were cleaned up. This network still needs successful live relay validation after the key/token pair is corrected. See RELIABILITY_AUDIT.md for findings and repair steps.

## Screen-publishing hotfix verification

The zero-byte POST regression failed before the fix (400 instead of 200) and passes after it. All 55 unit tests, lint, formatting, and the rebuilt production frontend pass. The regression also confirms empty track mutations and a `null` JSON session body still return 400 without being forwarded.

The hotfix browser run passed 13 of 14 cases; Firefox's four-screen case timed out during local connection setup, then passed when rerun alone (16 seconds). All four-screen and publishing-request cases are verified across these runs. The Worker deployment dry run also passed; no deployment was performed.

## Corrected upstream session contract

All 56 unit tests, lint, and frontend build pass. The corrected test failed before the fix and passes with an SFU mock that rejects `{}` exactly as the production log reports. Coverage includes no-body, zero-byte and `{}` client requests, empty upstream bodies for both session routes, preservation of SDP offers and authenticated registration, and rejection of malformed/empty mutation requests. Browser code is unchanged by this correction; the prior browser checks do not establish live SFU success. This Worker has not been deployed by the agent; verify the new health revision and actual media after deployment.
