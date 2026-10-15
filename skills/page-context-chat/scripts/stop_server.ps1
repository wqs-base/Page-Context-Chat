# Stop the Page Context Chat local server listening on the given port.
# Prints a single-line JSON result.
#
# Usage:
#   pwsh -File scripts/stop_server.ps1
#   pwsh -File scripts/stop_server.ps1 -Port 8090

param(
    [int]$Port = 8090
)

$ErrorActionPreference = "Stop"

$result = [ordered]@{
    port    = $Port
    stopped = $false
    pid     = 0
    error   = ""
}

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
    $result.error = "nothing is listening on port $Port"
    $result | ConvertTo-Json -Compress
    exit 0
}

$ownerPid = [int]($conn | Select-Object -First 1).OwningProcess
$result.pid = $ownerPid

try {
    Stop-Process -Id $ownerPid -Force
    Start-Sleep -Milliseconds 700
    $stillUp = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    $result.stopped = -not $stillUp
    if (-not $result.stopped) {
        $result.error = "process $ownerPid is still listening on port $Port"
    }
} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Compress
if ($result.stopped) { exit 0 } else { exit 1 }
