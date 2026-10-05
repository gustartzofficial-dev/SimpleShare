# Manual GitHub update

Suggested commit title:

```text
fix: fit shared screens to portrait desktop monitors
```

The updated working project is in E:\SimpleShare-Major Update.

A clean upload copy is in release/SimpleShare-v6.0.0, with a matching ZIP beside it. Upload the CONTENTS of that copy to the repository root. Do not upload the enclosing SimpleShare-v6.0.0 folder or the ZIP as your source tree.

The clean copy includes source, rebuilt dist assets, lockfiles, tests, documentation, deployment configuration, and license notices. It excludes Git metadata, node_modules, installed agent skills, caches, test artifacts, and local credentials.

The portrait-monitor fix changes only the frontend layout. If the previous media reliability update is already deployed, redeploy only the frontend for this fix. This package also retains that reliability update, which changed the frontend media client and Worker ICE response handling. Deploy both. No Durable Object migration is needed. If the log says "cannot find specified key", replace the Worker CF_TURN_APP_ID and CF_TURN_APP_TOKEN with a matching, valid Cloudflare TURN key and token. STUN fallback preserves discovery but cannot replace a relay on restrictive networks.

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
