[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\release'),
  [string]$NodeVersion = '22.22.0'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The portable package must be built on Windows so native dependencies and Chromium match the target platform.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'The portable package requires a 64-bit Windows build host.'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
  [IO.Path]::GetFullPath($OutputDirectory)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}
$buildRoot = Join-Path $repoRoot 'build\windows-portable'
$cacheRoot = Join-Path $repoRoot 'build\cache'

Push-Location $repoRoot
try {
  $package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
  $appVersion = [string]$package.version
  $archiveBase = "agent-meetings-v$appVersion-windows-x64-portable"
  $portableRoot = Join-Path $buildRoot $archiveBase
  $appRoot = Join-Path $portableRoot 'app'
  $runtimeRoot = Join-Path $portableRoot 'runtime'
  $configRoot = Join-Path $portableRoot 'config'
  $dataRoot = Join-Path $portableRoot 'data'

  Write-Host 'Installing exact dependencies from package-lock.json...'
  Invoke-Checked -Command 'npm.cmd' -Arguments @('ci', '--ignore-scripts')
  Invoke-Checked -Command 'npm.cmd' -Arguments @('test')
  Invoke-Checked -Command 'npm.cmd' -Arguments @('run', 'build')

  Remove-Item $buildRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item $appRoot, $runtimeRoot, $configRoot, $dataRoot, $cacheRoot, $outputRoot -ItemType Directory -Force | Out-Null

  Copy-Item -Path @('package.json', 'package-lock.json') -Destination $appRoot
  Write-Host 'Installing production dependencies in the package staging directory...'
  Invoke-Checked -Command 'npm.cmd' -Arguments @('ci', '--omit=dev', '--ignore-scripts', '--prefix', $appRoot)
  Copy-Item -Path @('dist', 'public') -Destination $appRoot -Recurse

  $nodeArchiveName = "node-v$NodeVersion-win-x64.zip"
  $nodeArchive = Join-Path $cacheRoot $nodeArchiveName
  $nodeShasums = Join-Path $cacheRoot "node-v$NodeVersion-SHASUMS256.txt"
  $nodeBaseUrl = "https://nodejs.org/dist/v$NodeVersion"

  if (-not (Test-Path $nodeArchive)) {
    Write-Host "Downloading Node.js $NodeVersion for Windows x64..."
    Invoke-WebRequest "$nodeBaseUrl/$nodeArchiveName" -OutFile $nodeArchive
  }
  Invoke-WebRequest "$nodeBaseUrl/SHASUMS256.txt" -OutFile $nodeShasums

  $escapedName = [Regex]::Escape($nodeArchiveName)
  $checksumLine = Get-Content $nodeShasums | Where-Object { $_ -match "^([a-fA-F0-9]{64})\s+$escapedName$" } | Select-Object -First 1
  if (-not $checksumLine) {
    throw "Unable to find $nodeArchiveName in Node.js SHASUMS256.txt"
  }
  $expectedNodeHash = ([Regex]::Match($checksumLine, '^([a-fA-F0-9]{64})')).Groups[1].Value.ToLowerInvariant()
  $actualNodeHash = (Get-FileHash $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualNodeHash -ne $expectedNodeHash) {
    Remove-Item $nodeArchive -Force
    throw "Node.js archive checksum mismatch. Expected $expectedNodeHash, got $actualNodeHash"
  }

  $nodeExtractRoot = Join-Path $buildRoot 'node-runtime'
  Expand-Archive $nodeArchive -DestinationPath $nodeExtractRoot -Force
  $nodeSourceRoot = Join-Path $nodeExtractRoot "node-v$NodeVersion-win-x64"
  Copy-Item (Join-Path $nodeSourceRoot 'node.exe') $runtimeRoot
  Copy-Item (Join-Path $nodeSourceRoot 'LICENSE') (Join-Path $runtimeRoot 'NODE-LICENSE.txt')

  $previousBrowsersPath = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH')
  try {
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $runtimeRoot 'ms-playwright'
    Write-Host 'Downloading the Playwright Chromium runtime into the package...'
    Invoke-Checked -Command (Join-Path $runtimeRoot 'node.exe') -Arguments @(
      (Join-Path $appRoot 'node_modules\playwright\cli.js'),
      'install',
      'chromium'
    )
  } finally {
    if ($null -eq $previousBrowsersPath) {
      Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue
    } else {
      $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowsersPath
    }
  }

  if (-not (Get-ChildItem (Join-Path $runtimeRoot 'ms-playwright') -Recurse -Filter 'chrome.exe' -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    throw 'Playwright completed without installing a Chromium chrome.exe.'
  }

  $windowsAssets = Join-Path $repoRoot 'packaging\windows'
  Copy-Item (Join-Path $windowsAssets 'meetings.config.yml') $configRoot
  Copy-Item (Join-Path $windowsAssets 'settings.env') $configRoot
  Copy-Item (Join-Path $repoRoot 'meetings.config.example.yml') $configRoot
  Copy-Item (Join-Path $windowsAssets 'agent-meetings.cmd') $portableRoot
  Copy-Item (Join-Path $windowsAssets 'start-agent-meetings.cmd') $portableRoot
  Copy-Item (Join-Path $windowsAssets 'browser-login.cmd') $portableRoot
  Copy-Item (Join-Path $windowsAssets 'README-Windows.md') $portableRoot
  Copy-Item (Join-Path $windowsAssets 'data-README.txt') (Join-Path $dataRoot 'README.txt')
  foreach ($launcher in @('agent-meetings.cmd', 'start-agent-meetings.cmd', 'browser-login.cmd')) {
    $launcherPath = Join-Path $portableRoot $launcher
    $launcherContent = (Get-Content $launcherPath -Raw) -replace "`r?`n", "`r`n"
    [IO.File]::WriteAllText($launcherPath, $launcherContent, [Text.Encoding]::ASCII)
  }
  if (Test-Path (Join-Path $repoRoot 'LICENSE')) {
    Copy-Item (Join-Path $repoRoot 'LICENSE') $portableRoot
  }

  $resolvedPlaywrightVersion = [string](Get-Content (Join-Path $appRoot 'node_modules\playwright\package.json') -Raw | ConvertFrom-Json).version
  @(
    "Agent Meetings: $appVersion"
    "Node.js: $NodeVersion"
    "Playwright: $resolvedPlaywrightVersion"
    'Chromium: bundled by Playwright install chromium'
    'Target: Windows 10/11 x64'
    "Built (UTC): $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
  ) | Set-Content (Join-Path $portableRoot 'VERSIONS.txt') -Encoding utf8

  $zipPath = Join-Path $outputRoot "$archiveBase.zip"
  $checksumPath = "$zipPath.sha256"
  Remove-Item $zipPath, $checksumPath -Force -ErrorAction SilentlyContinue
  Write-Host "Creating $zipPath..."
  Compress-Archive -Path $portableRoot -DestinationPath $zipPath -CompressionLevel Optimal

  $zipHash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  "$zipHash  $([IO.Path]::GetFileName($zipPath))" | Set-Content $checksumPath -Encoding ascii

  Write-Host ''
  Write-Host 'Windows portable package created successfully:'
  Write-Host "  $zipPath"
  Write-Host "  $checksumPath"
} finally {
  Pop-Location
}
