# Check whether the Page Context Chat local server is up and whether the Chrome
# extension is connected. Prints a single-line JSON result and sets an exit code.
#
# Usage:
#   pwsh -File scripts/check_connection.ps1
#
# veredict values:
#   server_not_running   server is not answering /health            (exit 2)
#   connected            extension connected + active tab captured (exit 0)
#   connected_no_page    extension connected, active tab not http(s)(exit 0)
#   capture_timeout      extension connected but did not reply       (exit 4)
#   extension_unavailable no extension connected over WebSocket      (exit 3)
#   unexpected           /capture returned something else            (exit 5)

param(
    [int]$Port = 8090,
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:$Port"

function Invoke-Probe {
    param([string]$Method, [string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method $Method -TimeoutSec $TimeoutSeconds -UseBasicParsing
        return @{ Status = [int]$resp.StatusCode; Body = $resp.Content }
    } catch {
        $webResponse = $_.Exception.Response
        if ($webResponse) {
            $status = 0
            try { $status = [int]$webResponse.StatusCode } catch { }
            $body = ""
            try {
                $reader = New-Object System.IO.StreamReader($webResponse.GetResponseStream())
                $body = $reader.ReadToEnd()
            } catch { }
            return @{ Status = $status; Body = $body }
        }
        return @{ Status = 0; Body = $_.Exception.Message }
    }
}

$result = [ordered]@{
    server         = $false
    extension      = $false
    pageCapturable = $false
    url            = ""
    title          = ""
    verdict        = ""
    httpStatus     = 0
    detail         = ""
}

$health = Invoke-Probe -Method "GET" -Url "$base/health"
if ($health.Status -ne 200) {
    $result.verdict = "server_not_running"
    $result.detail = "GET /health failed (status=$($health.Status))"
    $result | ConvertTo-Json -Compress
    exit 2
}
$result.server = $true

$cap = Invoke-Probe -Method "POST" -Url "$base/capture"
$result.httpStatus = $cap.Status
$payload = $null
try { $payload = $cap.Body | ConvertFrom-Json } catch { }

switch ($cap.Status) {
    200 {
        $result.extension = $true
        $result.pageCapturable = $true
        if ($payload -and $payload.context) {
            $result.url = [string]$payload.context.url
            $result.title = [string]$payload.context.title
        }
        $result.verdict = "connected"
        $result.detail = "extension connected and active tab captured"
        $code = 0
    }
    422 {
        $result.extension = $true
        $result.verdict = "connected_no_page"
        $result.detail = "extension connected; active tab is not a capturable http/https page"
        $code = 0
    }
    503 {
        $result.verdict = "extension_unavailable"
        $result.detail = "no extension connected over WebSocket"
        $code = 3
    }
    504 {
        $result.extension = $true
        $result.verdict = "capture_timeout"
        $result.detail = "extension connected but did not answer within timeout"
        $code = 4
    }
    default {
        $result.verdict = "unexpected"
        $result.detail = "POST /capture returned status $($cap.Status)"
        $code = 5
    }
}

$result | ConvertTo-Json -Compress
exit $code
