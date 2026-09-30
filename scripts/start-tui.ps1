param(
    [ValidateRange(1, 65535)]
    [int] $Port = 8787,
    [string] $Session
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bridgeExecutable = Join-Path $projectRoot 'bridge\target\debug\herdr-web-bridge.exe'
$webAssets = Join-Path $projectRoot 'web\dist'

if (!(Test-Path -LiteralPath $bridgeExecutable) -or !(Test-Path -LiteralPath (Join-Path $webAssets 'index.html'))) {
    throw 'Build the application first: npm ci --prefix web; npm run build'
}

# Debug builds otherwise look for the herdr-dev session. Respect explicit overrides.
if (!$Session -and !$env:HERDR_SOCKET_PATH) {
    $env:HERDR_SOCKET_PATH = Join-Path $env:APPDATA 'herdr\herdr.sock'
}

$bridgeArguments = @('--host', '127.0.0.1', '--port', $Port.ToString(), '--static-dir', $webAssets)
if ($Session) { $bridgeArguments += @('--session', $Session) }

Write-Host "Herdr TUI: http://127.0.0.1:$Port"
Write-Host 'Keep this terminal open. Press Ctrl+C to stop the web bridge.'
Push-Location -LiteralPath $projectRoot
try {
    & $bridgeExecutable @bridgeArguments
    if ($LASTEXITCODE -ne 0) { throw "herdr-web-bridge exited with code $LASTEXITCODE" }
} finally {
    Pop-Location
}
