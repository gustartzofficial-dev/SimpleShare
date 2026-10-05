# Validation — SimpleShare 6.0.0

Checked locally on Windows on 2026-10-05 with Node.js 24.19.0.

| Check                            | Result                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint                           | Passed, no reported errors or warnings                                                                                                |
| Node regression tests            | 35 passed                                                                                                                             |
| Production frontend build        | Passed                                                                                                                                |
| Prettier source formatting       | Passed                                                                                                                                |
| Browser checks                   | 65 distinct cases verified across runs: 27 Chromium, 27 Firefox, 11 WebKit phone                                                      |
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
