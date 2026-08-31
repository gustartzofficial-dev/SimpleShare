@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  SimpleShare - verify Cloudflare TURN
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-turn.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
pause
exit /b %EXITCODE%
