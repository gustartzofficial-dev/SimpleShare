# Manual GitHub update

Suggested commit title:

```text
fix: omit empty JSON bodies when creating SFU sessions
```

The updated working project is in E:\SimpleShare-Major Update.

A clean upload copy is in release/SimpleShare-v6.0.0, with a matching ZIP beside it. Upload the CONTENTS of that copy to the repository root. Do not upload the enclosing SimpleShare-v6.0.0 folder or the ZIP as your source tree.

The clean copy includes source, rebuilt dist assets, lockfiles, tests, documentation, deployment configuration, and license notices. It excludes Git metadata, node_modules, installed agent skills, caches, test artifacts, and local credentials.

This reliability update changes frontend transport behavior and Worker media/session handling. Deploy both; no Durable Object migration is needed. Repair the rejected TURN key/token pair as described in README.md and RELIABILITY_AUDIT.md. Have all room users refresh.

## GitHub web steps

1. Open your SimpleShare repository and create a branch for the update.
2. Choose Add file → Upload files. Drag the contents of the clean release copy into the repository root. Keep the nested directories intact. Include dotfiles such as .gitignore, .github, .prettierignore, and .prettierrc.json.
3. Use the commit title above. COMMIT_MESSAGE.txt contains a suggested description.
4. Delete the obsolete files listed below through GitHub's file menus. Web uploads replace and add files, but do not remove files just because they are missing from the upload.
5. Review the changes, then merge the branch when ready.
6. Deploy the updated Worker and frontend together. GitHub uploads alone do not update the Cloudflare Worker. Confirm ROOM_API_URL, Realtime/TURN secrets, and ALLOWED_ORIGINS using README.md.
7. Ask existing room users to refresh. Test sharing and watching between two real devices after deployment.

## Files to delete from the old repository

- PATCH.diff
- scripts/check-refs.mjs
- public/compat.js
- public/gecko-audio-bridge.js
- public/secondary-audio.js
- public/ui-overhaul.js
- public/ui-overhaul-pre.js
- public/ps1-emulator.js
- public/ux-v2.js
- public/ux-v2.css
- public/layout-fix.css
- dist/ux-v2.js
- dist/ux-v2.css

These old UI, audio, and emulator layers are not used by version 6.

## Preview before uploading

From the main working folder:

```sh
npm run dev
```

Open http://127.0.0.1:4173/?demo=1 to inspect the labelled sample room, or open the homepage. The sample does not require credentials. For real rooms, follow the configuration instructions in README.md.

No changes were pushed to GitHub or deployed by this update.

## Screen-publishing hotfix

For the `Expected a JSON object` publishing regression, deploy the updated Worker first, then the frontend. The Worker fix supports older clients that still send empty session-creation POSTs. Refresh clients after frontend deployment. Leave working TURN secrets unchanged.

## Corrected SFU session-creation hotfix

The previous empty-body hotfix was incomplete: forwarding `{}` to Cloudflare causes `Body JSON validation error: sessionDescription`. Cloudflare requires no upstream body when creating a session without an SDP offer. The corrected Worker accepts old empty client requests and current `{}` requests, then sends no upstream body. Explicit SDP and track mutation bodies are preserved.

Deploy the updated Cloudflare Worker; uploading frontend files alone will not apply this correction. No further frontend change or TURN secret change is required for this fix. Confirm `/health` reports `reliabilityRevision: session-body-v2-2026-10-05`, then refresh and retry sharing. A successful room log must show `sessions/new` returning 200 or 201, followed by successful `tracks/new`.
