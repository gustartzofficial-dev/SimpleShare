[CmdletBinding()]
param(
    [string]$WorkerUrl = ""
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Host ""
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Section([string]$Text) {
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$workerDir = Join-Path $repoRoot "cloudflare-worker"
$verifyScript = Join-Path $PSScriptRoot "verify-turn.ps1"

if (-not (Test-Path (Join-Path $workerDir "wrangler.toml"))) {
    Fail "Could not find cloudflare-worker\wrangler.toml. Put tools\turn-fix inside the SimpleShare repository root."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js was not found in PATH. Install Node.js first."
}
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Fail "npx was not found in PATH. Reinstall Node.js/npm first."
}

Section "Cloudflare login"
Push-Location $workerDir
try {
    & npx --yes wrangler whoami
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Wrangler is not logged in. Opening Cloudflare login..." -ForegroundColor Yellow
        & npx --yes wrangler login
        if ($LASTEXITCODE -ne 0) { Fail "Wrangler login failed." }
    }

    Section "TURN secrets"
    Write-Host "Create a TURN key in Cloudflare Dashboard -> Realtime -> TURN before continuing."
    Write-Host "Wrangler will prompt for each value. The values are stored as encrypted Worker secrets, not in GitHub." -ForegroundColor Yellow
    Write-Host ""

    Write-Host "Setting CF_TURN_APP_ID..." -ForegroundColor Cyan
    & npx --yes wrangler secret put CF_TURN_APP_ID
    if ($LASTEXITCODE -ne 0) { Fail "Could not save CF_TURN_APP_ID." }

    Write-Host ""
    Write-Host "Setting CF_TURN_APP_TOKEN..." -ForegroundColor Cyan
    & npx --yes wrangler secret put CF_TURN_APP_TOKEN
    if ($LASTEXITCODE -ne 0) { Fail "Could not save CF_TURN_APP_TOKEN." }

    Section "Deploy Worker"
    $deployLines = @()
    & npx --yes wrangler deploy 2>&1 | Tee-Object -Variable deployLines | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { Fail "Wrangler deploy failed." }

    if (-not $WorkerUrl) {
        $joined = ($deployLines | Out-String)
        $match = [regex]::Match($joined, 'https://[^\s]+\.workers\.dev')
        if ($match.Success) {
            $WorkerUrl = $match.Value.TrimEnd('/', '.', ',', ')')
        }
    }
}
finally {
    Pop-Location
}

Section "Verify"
if (-not $WorkerUrl) {
    Write-Host "I could not detect the workers.dev URL from Wrangler output." -ForegroundColor Yellow
    $WorkerUrl = Read-Host "Paste your SimpleShare Worker URL (example: https://name.account.workers.dev)"
}

if (-not $WorkerUrl) { Fail "No Worker URL was provided." }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifyScript -WorkerUrl $WorkerUrl
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Cloudflare TURN is configured. Now open SimpleShare with ?debug=1 and test sharing again." -ForegroundColor Green
exit 0
