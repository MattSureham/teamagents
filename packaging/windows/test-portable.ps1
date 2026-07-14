[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Portable smoke tests must run on Windows.'
}

$archive = (Resolve-Path $ArchivePath).Path
$checksumFile = "$archive.sha256"
if (-not (Test-Path $checksumFile)) {
  throw "Checksum file not found: $checksumFile"
}

$expectedHash = ((Get-Content $checksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) {
  throw "Portable archive checksum mismatch. Expected $expectedHash, got $actualHash"
}

$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) 'Agent Meetings Portable Smoke Test'
Remove-Item $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item $smokeRoot -ItemType Directory -Force | Out-Null
Expand-Archive $archive -DestinationPath $smokeRoot

$portableRoot = Get-ChildItem $smokeRoot -Directory | Select-Object -First 1
if (-not $portableRoot) {
  throw 'Portable archive did not contain a top-level directory.'
}
$root = $portableRoot.FullName
$node = Join-Path $root 'runtime\node.exe'
$cli = Join-Path $root 'app\dist\cli\index.js'
$expectedVersion = [string](Get-Content (Join-Path $root 'app\package.json') -Raw | ConvertFrom-Json).version
$env:AGENT_MEETINGS_CONFIG = Join-Path $root 'config\meetings.config.yml'
$env:AGENT_MEETINGS_ENV_FILE = Join-Path $root 'config\settings.env'
$env:AGENT_MEETINGS_HOME = Join-Path $root 'data'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $root 'runtime\ms-playwright'
$env:NODE_ENV = 'production'

Push-Location $root
$server = $null
try {
  $version = (& $node $cli --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -ne $expectedVersion) {
    throw "Unexpected CLI version: $version"
  }

  & cmd.exe /d /s /c "call `"$root\agent-meetings.cmd`" --version"
  if ($LASTEXITCODE -ne 0) {
    throw 'agent-meetings.cmd failed from a path containing spaces.'
  }

  & $node $cli config validate
  if ($LASTEXITCODE -ne 0) {
    throw 'Portable config validation failed.'
  }

  Push-Location (Join-Path $root 'app')
  try {
    & $node --input-type=module --eval "import { chromium } from 'playwright'; const browser = await chromium.launch({ headless: true }); await browser.close();"
    if ($LASTEXITCODE -ne 0) {
      throw 'Bundled Chromium failed to launch.'
    }
  } finally {
    Pop-Location
  }

  $stdout = Join-Path $smokeRoot 'server.stdout.log'
  $stderr = Join-Path $smokeRoot 'server.stderr.log'
  $server = Start-Process $node -ArgumentList @("`"$cli`"", 'serve') -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($server.HasExited) {
      break
    }
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:4200/health' -TimeoutSec 2
      if ($health.status -eq 'ok') {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $healthy) {
    $serverOutput = if (Test-Path $stdout) { Get-Content $stdout -Raw } else { '' }
    $serverError = if (Test-Path $stderr) { Get-Content $stderr -Raw } else { '' }
    throw "Portable server failed health check.`n$serverOutput`n$serverError"
  }

  $homeResponse = Invoke-WebRequest 'http://127.0.0.1:4200/' -UseBasicParsing -TimeoutSec 5
  if ($homeResponse.StatusCode -ne 200 -or $homeResponse.Content -notmatch 'TeamAgents') {
    throw 'Portable web UI smoke test failed.'
  }
  if (-not (Test-Path (Join-Path $root 'data\meetings'))) {
    throw 'Portable server did not create its data directory inside the package.'
  }
  if (-not (Select-String -Path (Join-Path $root 'browser-login.cmd') -Pattern 'browser-setup' -Quiet)) {
    throw 'browser-login.cmd does not invoke browser setup.'
  }
} finally {
  if ($server -and -not $server.HasExited) {
    & taskkill.exe /pid $server.Id /T /F 2>$null | Out-Null
  }
  Pop-Location
}

Write-Host 'Windows portable smoke tests passed.'
