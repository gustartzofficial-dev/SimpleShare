@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  SimpleShare - configure Cloudflare TURN
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-turn.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
  echo TURN setup did not complete successfully. See the message above.
) else (
  echo TURN setup and verification completed successfully.
)
echo.
pause
exit /b %EXITCODE%
