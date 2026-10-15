# Start the Page Context Chat local server (page-context-chat-server.exe) in the background
# and wait until /health responds. Prints a single-line JSON result.
#
# Usage:
#   pwsh -File scripts/start_server.ps1 -Mode interaction
#   pwsh -File scripts/start_server.ps1 -Mode full -ExePath "C:\path\to\page-context-chat-server.exe"
#
# Mode -> launch flags:
#   plain        (no flag)                              health, chat, capture, ws
#   interaction  --allow-interaction                    + /click (virtual cursor)
#   js           --allow-js-execution                   + /execute (arbitrary JS)
#   full         --allow-js-execution --allow-interaction  + both

param(
    [ValidateSet("plain", "interaction", "js", "full")]
    [string]$Mode = "plain",
    [string]$ExePath = "",
    [int]$Port = 8090,
    [int]$TimeoutSeconds = 40
)

$ErrorActionPreference = "Stop"
$exeName = "page-context-chat-server.exe"

function Resolve-Exe {
    param([string]$Explicit)
    if ($Explicit) {
        if (Test-Path -LiteralPath $Explicit) {
            return (Resolve-Path -LiteralPath $Explicit).Path
        }
        return ""
    }
    # Prefer the exe bundled next to this script, then fall back to the repo's
    # release/ and build-output locations. The repo root is three levels up
    # because the skill lives at <repo>/skills/page-context-chat/scripts/.
    $candidates = @(Join-Path $PSScriptRoot $exeName)
    $repo = Resolve-Path (Join-Path $PSScriptRoot "..\..\..") -ErrorAction SilentlyContinue
    if ($repo) {
        $candidates += (Join-Path $repo "release\$exeName")
        $candidates += (Join-Path $repo "server\dist\$exeName")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return ""
}

function Get-ListeningProcessId {
    param([int]$LocalPort)
    $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
    if ($conn) { return [int]($conn | Select-Object -First 1).OwningProcess }
    return 0
}

$result = [ordered]@{
    mode      = $Mode
    exePath   = ""
    pid       = 0
    port      = $Port
    started   = $false
    alreadyUp = $false
    healthy   = $false
    error     = ""
}

$existingPid = Get-ListeningProcessId -LocalPort $Port
if ($existingPid -gt 0) {
    $result.alreadyUp = $true
    $result.pid = $existingPid
    $result.healthy = $true
    $result.error = "port already in use by pid $existingPid"
    $result | ConvertTo-Json -Compress
    exit 0
}

$exe = Resolve-Exe -Explicit $ExePath
if (-not $exe) {
    $result.error = "server exe not found; build it with build_release.ps1 or pass -ExePath"
    $result | ConvertTo-Json -Compress
    exit 1
}
$result.exePath = $exe

$serverArgs = @()
switch ($Mode) {
    "interaction" { $serverArgs += "--allow-interaction" }
    "js" { $serverArgs += "--allow-js-execution" }
    "full" { $serverArgs += "--allow-js-execution"; $serverArgs += "--allow-interaction" }
}

$logDir = Join-Path $env:TEMP "page-context-chat"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$outLog = Join-Path $logDir "server.out.log"
$errLog = Join-Path $logDir "server.err.log"

$proc = Start-Process -FilePath $exe -ArgumentList $serverArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$result.started = $true
$result.pid = $proc.Id

for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing
        if ($resp.StatusCode -eq 200) {
            $result.healthy = $true
            break
        }
    } catch { }
    if ($proc.HasExited) {
        $result.error = "process exited with code $($proc.ExitCode) before becoming healthy; see $errLog"
        break
    }
}

if (-not $result.healthy -and -not $result.error) {
    $result.error = "server did not answer /health within $TimeoutSeconds seconds; see $errLog"
}

$result | ConvertTo-Json -Compress
if ($result.healthy) { exit 0 } else { exit 1 }
