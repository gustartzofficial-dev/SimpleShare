# Windows TURN helpers

Run these from the repository's tools folder with Node.js installed. They use the cloudflare-worker directory immediately above tools.

- CONFIGURE_TURN_WINDOWS.bat authenticates Wrangler if needed, prompts for your Cloudflare TURN ID and token, stores them as Worker secrets, deploys the Worker, and runs verification. This changes your deployed Worker.
- VERIFY_TURN_WINDOWS.bat checks an existing deployment without redeploying. It reads health, joins a fresh temporary room, requests ICE servers using the participant token, then leaves the room.

The verifier prints relay URLs, not secret values. A successful check confirms credentials are present and TURN URLs are returned; it does not prove that two devices on a restrictive network can exchange media.

Configure CF_REALTIME_APP_ID / CF_REALTIME_APP_SECRET and ALLOWED_ORIGINS using the main README before using the deployment helper. Secret values are not written to files by these scripts.

You can also call the PowerShell scripts directly:

```powershell
.\tools\verify-turn.ps1 -WorkerUrl "https://your-worker.workers.dev"
.\tools\configure-turn.ps1 -WorkerUrl "https://your-worker.workers.dev"
```

After verification, test a real room on two devices and inspect the activity log with the room URL's debug=1 parameter.
