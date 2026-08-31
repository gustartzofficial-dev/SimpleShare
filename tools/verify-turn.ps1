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

function Good([string]$Message) {
    Write-Host $Message -ForegroundColor Green
}

function Warn([string]$Message) {
    Write-Host $Message -ForegroundColor Yellow
}

if (-not $WorkerUrl) {
    $WorkerUrl = Read-Host "Paste your SimpleShare Worker URL (example: https://name.account.workers.dev)"
}
if (-not $WorkerUrl) { Fail "No Worker URL was provided." }

$WorkerUrl = $WorkerUrl.Trim().TrimEnd('/')
if ($WorkerUrl -notmatch '^https://') { Fail "Worker URL must start with https://" }

Write-Host ""
Write-Host "Checking $WorkerUrl" -ForegroundColor Cyan

try {
    $health = Invoke-RestMethod -Uri "$WorkerUrl/health" -Method Get -TimeoutSec 20
} catch {
    Fail "Could not read /health: $($_.Exception.Message)"
}

Write-Host "Worker build:       $($health.build)"
Write-Host "Realtime configured: $($health.realtimeConfigured)"
Write-Host "TURN configured:     $($health.turnConfigured)"
Write-Host "Fallback relay:      $($health.fallbackRelay)"

if (-not $health.realtimeConfigured) {
    Fail "Cloudflare Realtime/SFU credentials are not configured on this Worker."
}
if (-not $health.turnConfigured) {
    Fail "TURN is still not configured. CF_TURN_APP_ID and CF_TURN_APP_TOKEN are missing or were set on a different Worker/environment."
}
Good "Health check says Cloudflare TURN credentials are present."

Write-Host ""
Write-Host "Checking generated ICE servers..." -ForegroundColor Cyan
try {
    $iceResponse = Invoke-WebRequest -Uri "$WorkerUrl/partytracks/generate-ice-servers" -Method Get -TimeoutSec 20 -UseBasicParsing
} catch {
    Fail "ICE endpoint failed: $($_.Exception.Message)"
}

$relaySource = $iceResponse.Headers['x-ss-relay']
if (-not $relaySource) { $relaySource = '(header not present)' }

try {
    $ice = $iceResponse.Content | ConvertFrom-Json
} catch {
    Fail "ICE endpoint returned non-JSON data."
}

$list = @()
if ($null -ne $ice.iceServers) {
    $list = @($ice.iceServers)
} else {
    $list = @($ice)
}

$urls = New-Object System.Collections.Generic.List[string]
foreach ($entry in $list) {
    foreach ($u in @($entry.urls)) {
        if ($null -ne $u -and [string]$u -ne '') { [void]$urls.Add([string]$u) }
    }
}

$turnUrls = @($urls | Where-Object { $_ -match '^turns?:' })
$cloudflareTurn = @($turnUrls | Where-Object { $_ -match 'cloudflare\.com' })
$openRelay = @($turnUrls | Where-Object { $_ -match 'openrelay\.metered\.ca' })

Write-Host "Relay source header: $relaySource"
Write-Host "ICE URLs found:      $($urls.Count)"
Write-Host "TURN URLs found:     $($turnUrls.Count)"
foreach ($u in $turnUrls) { Write-Host "  $u" }

if ($turnUrls.Count -eq 0) {
    Fail "The Worker says TURN is configured, but generate-ice-servers returned no TURN URLs."
}

if ($relaySource -eq 'fallback' -or ($openRelay.Count -gt 0 -and $cloudflareTurn.Count -eq 0)) {
    Fail "The Worker is still serving the OpenRelay fallback instead of Cloudflare TURN. Re-check the two TURN secrets and the Worker/environment you deployed."
}

if ($cloudflareTurn.Count -eq 0) {
    Warn "TURN exists, but its hostname was not recognized as Cloudflare. Inspect the URLs above."
} else {
    Good "Cloudflare TURN URLs are being returned."
}

if ($relaySource -eq 'cloudflare') {
    Good "Relay source: cloudflare"
} else {
    Warn "x-ss-relay did not explicitly say cloudflare. This can happen if the current Worker response path does not add that diagnostic header, so the TURN URLs above are the stronger check."
}

Write-Host ""
Good "SUCCESS: the deployed Worker is ready to give restrictive networks a TURN relay."
Write-Host "Next test: open a SimpleShare room with ?debug=1 on the affected PC and share your screen."
Write-Host "Expected improvement: ICE should gather a relay candidate even if STUN/UDP still fails."
exit 0
