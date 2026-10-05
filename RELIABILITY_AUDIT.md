# Reliability audit — 2026-10-05

Live frontend configuration points to https://simpleshare.gustartzofficial.workers.dev. Both TURN secrets are present, but authenticated ICE generation returns zero TURN URLs and reports that Cloudflare rejected the configured credentials. The supplied log records upstream 404, "cannot find specified key". The Worker name and secret binding names are unchanged in the inspected project history. A presence check did not establish credential validity.

The response cannot distinguish a deleted key, wrong TURN key ID, mismatched token, or account/key access mismatch without inspecting Cloudflare. Expiring generated client credentials are different from rejection of the long-term key/token.

## Verified defects and fixes

| Finding                                                            | Impact                                                 | Fix                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| TURN discovery yields no relay                                     | Strict networks may remain connecting                  | Clear diagnostics and improved verifier; owner must correct secrets                      |
| Client and Worker requests lacked deadlines                        | A stalled response could hold negotiation indefinitely | 12-second client / 10-second Worker deadlines, including response bodies                 |
| Proxy depended on Content-Length                                   | Some media requests could lose their JSON body         | Always validate and forward JSON; strip participant headers upstream                     |
| Multiple recovery paths rebuilt the same engine                    | Healthy streams could be interrupted repeatedly        | Transport owns recovery; 45-second no-progress guard retires only its current connection |
| SFU sessions created before anyone watched/shared                  | Disconnected allocations could expire before use       | Lazy engine creation and disposal after the final consumer leaves                        |
| Retired ownership accumulated to the 12-session limit              | Subsequent recovery could be refused                   | Authenticated owner-scoped release of unadvertised sessions                              |
| Old metadata could emit during session replacement                 | Viewers could subscribe to a dead session              | Clear metadata and filter emissions by current session                                   |
| Unlimited history and transceiver replay                           | Long-lived rooms retained old SDP and connections      | 100 history entries and 32 replayed transceivers                                         |
| Asynchronous room updates could overlap                            | Old updates could overwrite new state                  | Ordered updates and rejection of superseded socket messages                              |
| Announcement errors had no retry                                   | Published capture could stay invisible                 | Serialized announcements with backoff                                                    |
| Terminal auth/budget errors retried indefinitely                   | Users could stay connecting                            | Surface terminal errors without unhandled observable failures                            |
| Direct ICE selected the outgoing peer when both directions existed | Mutual sharing could use the wrong connection          | IDs on offers/answers/ICE, separate batches, bounded early-ICE buffer                    |
| Peer discovery depended on background interval timers              | Room discovery could be delayed                        | Immediate greeting reply to new peers                                                    |

Existing room boundaries, session ownership, membership limits, usage protection, and phone/portrait-monitor layouts remain covered by tests. This pass makes no visual redesign.

## Live diagnostic result

Four temporary members used only synthetic 320×180 canvas video through the updated transport against the currently deployed Worker. All four remained connecting during the observation window; none published successfully. No private screen was captured. Memberships were removed and browser contexts closed.

This is consistent with missing relay connectivity on this network, but does not prove TURN is the only network failure. Local simulated-SFU WebRTC passes cannot substitute for a successful live relay test. Test again after repairing TURN and deploying the update.

## Repair and verify

1. Upload the clean release contents and deploy both frontend and Worker. No Durable Object migration is needed.
2. Confirm frontend ROOM_API_URL targets the Worker where you edit the secrets.
3. In Cloudflare Realtime → TURN, choose or create a key. Set Worker CF_TURN_APP_ID to that TURN key ID and CF_TURN_APP_TOKEN to the API token from the same key. These differ from SFU application credentials and general account API tokens. Store them as encrypted Worker secrets.
4. Run the verifier in tools/README.md. Require actual TURN URLs, not just turnConfigured=true in /health.
5. Updated /health reports reliabilityRevision=session-lifecycle-2026-10-05 and states that TURN configuration is only a secret-presence check.
6. Have everyone refresh, especially direct-mode users. Test two devices on different networks, then four-person sharing.

Primary references: [TURN credential generation](https://developers.cloudflare.com/realtime/turn/generate-credentials/), [SFU negotiation](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## Screen-publishing follow-up

A reported `Video publish failed: Expected a JSON object.` was reproduced with an authenticated session-creation POST carrying a zero-byte body stream. The previous unit fixture used no body at all, which missed the transport representation. The Worker returned 400 before any upstream SFU call. Session creation now accepts a zero-byte body as `{}`; the browser also sends explicit JSON. This exception is limited to session creation and preserves bounded parsing, authentication, registration, and rejection of malformed bodies and empty track mutations. Deploy the Worker first to support already-open clients, then deploy the rebuilt frontend and refresh. This correction does not require changing TURN credentials.
