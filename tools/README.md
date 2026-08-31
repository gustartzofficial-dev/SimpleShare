# TURN fix tools

Use `CONFIGURE_TURN_WINDOWS.bat` first. It securely sets the two Cloudflare TURN Worker secrets, deploys the Worker, and then runs the verifier.

Use `VERIFY_TURN_WINDOWS.bat` later whenever you only want to re-check the deployed Worker.

These scripts never save the TURN ID or token to a file.
