<#
.SYNOPSIS
  One-click build & run AYA for debugging.

.DESCRIPTION
  Checks the toolchain, installs npm deps / git submodules when missing,
  provisions runtime assets (resources/adb, resources/aya.dex), compiles
  main / preload / renderer bundles and finally launches Electron.

  dev  (default): main + preload are built with MODE=development so windows
                  load http://localhost:8080 from the Vite dev server.
  prod          : full production build, windows load dist/renderer/index.html.

.PARAMETER Mode
  dev | prod

.PARAMETER Clean
  Remove dist/ before building.

.PARAMETER SkipInstall
  Never touch npm dependencies.

.PARAMETER SkipAssets
  Do not provision resources/adb and resources/aya.dex.

.PARAMETER InspectPort
  Node inspector port for the main process (default 9229).

.PARAMETER CdpPort
  Chrome DevTools Protocol port used to attach to renderer windows (default 9222).

.EXAMPLE
  .\script\dev.ps1
  .\script\dev.ps1 -Clean
  .\script\dev.ps1 -Mode prod
#>
[CmdletBinding()]
param(
  [ValidateSet('dev', 'prod')]
  [string]$Mode = 'dev',
  [switch]$Clean,
  [switch]$SkipInstall,
  [switch]$SkipAssets,
  [switch]$KillRunning,
  [int]$InspectPort = 9229,
  [int]$CdpPort = 9222
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ok  $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { throw $msg }

function Invoke-Shell([string]$file, [string[]]$shellArgs) {
  & $file @shellArgs
  if ($LASTEXITCODE -ne 0) {
    Fail "'$file $($shellArgs -join ' ')' exited with code $LASTEXITCODE"
  }
}

function Get-JavaMajor([string]$javaExe) {
  try {
    $out = & $javaExe -version 2>&1 | Select-Object -First 1
    if ($out -match '"(\d+)') { return [int]$Matches[1] }
  } catch {
    return 0
  }
  return 0
}

function Resolve-Jdk17 {
  $candidates = @()
  if ($env:JAVA_HOME) { $candidates += $env:JAVA_HOME }
  $candidates += @(
    "$env:LOCALAPPDATA\Programs\Microsoft\jdk-17*",
    'C:\Program Files\Microsoft\jdk-17*',
    'C:\Program Files\Java\jdk-17*',
    'C:\Program Files\Eclipse Adoptium\jdk-17*',
    'C:\Program Files\Zulu\zulu-17*',
    'C:\Program Files\BellSoft\LibericaJDK-17*'
  )
  foreach ($c in $candidates) {
    foreach ($dir in (Resolve-Path $c -ErrorAction SilentlyContinue)) {
      $java = Join-Path $dir 'bin\java.exe'
      if ((Test-Path $java) -and (Get-JavaMajor $java) -ge 17) { return $dir.Path }
    }
  }
  return $null
}

function Resolve-AndroidSdk {
  $candidates = @()
  if ($env:ANDROID_HOME) { $candidates += $env:ANDROID_HOME }
  if ($env:ANDROID_SDK_ROOT) { $candidates += $env:ANDROID_SDK_ROOT }
  if (Test-Path 'server/local.properties') {
    $line = Get-Content 'server/local.properties' |
      Where-Object { $_ -match '^\s*sdk\.dir\s*=' } |
      Select-Object -First 1
    if ($line) {
      $sdkDir = $line -replace '^\s*sdk\.dir\s*=\s*', ''
      $sdkDir = $sdkDir -replace '\\\\', '\'
      $sdkDir = $sdkDir -replace '\\:', ':'
      $candidates += $sdkDir.Trim()
    }
  }
  $candidates += @(
    'D:\Android\SDK',
    "$env:LOCALAPPDATA\Android\Sdk"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c 'platform-tools'))) { return (Resolve-Path $c).Path }
  }
  return $null
}

$devServer = $null
$script:electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'

function Get-ConflictingInstances {
  $list = @()
  $aya = Get-Process -Name 'AYA' -ErrorAction SilentlyContinue
  if ($aya) { $list += @($aya) }
  if (Test-Path $script:electronExe) {
    $el = Get-Process -Name 'electron' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $script:electronExe }
    if ($el) { $list += @($el) }
  }
  return $list
}

function Stop-ConflictingInstances {
  $targets = Get-ConflictingInstances
  foreach ($p in $targets) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 20; $i++) {
    if ((Get-ConflictingInstances).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return ((Get-ConflictingInstances).Count -eq 0)
}

function Stop-DevServer {
  if (-not $devServer) { return }
  if (-not $devServer.HasExited) {
    Step 'Stop vite dev server'
    Stop-Process -Id $devServer.Id -Force -ErrorAction SilentlyContinue
  }
  $listener = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue
  foreach ($c in @($listener)) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

try {
  Write-Host ''
  Write-Host "AYA debug runner  [mode=$Mode]  root=$root" -ForegroundColor Magenta
  Write-Host ''

  # ---------------------------------------------------------------- toolchain
  Step 'Check toolchain'
  $nodeVer = (& node -v) 2>$null
  if (-not $nodeVer) { Fail 'Node.js is not available in PATH.' }
  Ok "node $nodeVer"

  # ------------------------------------------------------------- dependencies
  if (-not $SkipInstall) {
    if (-not (Test-Path 'node_modules/electron/dist/electron.exe')) {
      Step 'Install npm dependencies'
      if (-not $env:ELECTRON_MIRROR) {
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
      }
      Invoke-Shell 'npm' @('install', '--no-audit', '--no-fund')
    } else {
      Ok 'node_modules ready'
    }
  }

  if (-not (Test-Path 'src/share/main/lib/util.ts')) {
    Step 'Init git submodules'
    Invoke-Shell 'git' @('submodule', 'update', '--init', '--recursive')
  } else {
    Ok 'submodules ready'
  }

  if ($Clean -and (Test-Path 'dist')) {
    Step 'Clean dist'
    Remove-Item 'dist' -Recurse -Force
  }

  # ------------------------------------------------------------------ assets
  if (-not $SkipAssets) {
    if (-not (Test-Path 'resources/adb/adb.exe')) {
      Step 'Provision adb binary'
      $sdk = Resolve-AndroidSdk
      $adbSrc = $null
      if ($sdk) {
        $p = Join-Path $sdk 'platform-tools\adb.exe'
        if (Test-Path $p) { $adbSrc = $p }
      }
      if (-not $adbSrc) {
        $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
        if ($cmd) { $adbSrc = $cmd.Source }
      }
      if ($adbSrc) {
        New-Item -ItemType Directory -Force -Path 'resources/adb' | Out-Null
        $srcDir = Split-Path -Parent $adbSrc
        foreach ($f in @('adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll')) {
          $p = Join-Path $srcDir $f
          if (Test-Path $p) { Copy-Item $p 'resources/adb' -Force }
        }
        Ok "adb copied from $srcDir"
      } else {
        Warn 'adb not found. Install platform-tools or run: npm run adb'
      }
    } else {
      Ok 'resources/adb ready'
    }

    if (-not (Test-Path 'resources/aya.dex')) {
      Step 'Build aya.dex (android server module)'
      $sdk = Resolve-AndroidSdk
      $jdk = Resolve-Jdk17
      if (-not $sdk) {
        Warn 'Android SDK not found. Device side features stay disabled.'
      } elseif (-not $jdk) {
        Warn 'JDK 17 not found. Device side features stay disabled.'
      } else {
        $env:JAVA_HOME = $jdk
        if (-not (Test-Path 'server/local.properties')) {
          $escaped = $sdk -replace '\\', '\\' -replace ':', '\:'
          Set-Content 'server/local.properties' "sdk.dir=$escaped" -Encoding ASCII
        }
        Push-Location 'server'
        try {
          Invoke-Shell '.\gradlew.bat' @(':server:assembleRelease')
        } finally {
          Pop-Location
        }
        New-Item -ItemType Directory -Force -Path 'resources' | Out-Null
        Copy-Item 'server/aya.dex' 'resources/aya.dex' -Force
        Ok 'resources/aya.dex ready'
      }
    } else {
      Ok 'resources/aya.dex ready'
    }

    if (-not (Test-Path 'resources/scrcpy.jar')) {
      Warn 'resources/scrcpy.jar missing -> screen mirroring disabled. Run: npm run scrcpy'
    }
  }

  # ------------------------------------------------------------- mcp bridge
  # resources/ is gitignored, so the MCP stdio bridge is kept in script/mcp and
  # mirrored into resources/mcp (which the app resolves at runtime).
  Step 'Sync MCP bridge script'
  New-Item -ItemType Directory -Force -Path 'resources/mcp' | Out-Null
  Copy-Item 'script/mcp/aya-mcp-stdio.cjs' 'resources/mcp/aya-mcp-stdio.cjs' -Force
  Ok 'resources/mcp ready'

  # -------------------------------------------- single instance lock conflict
  # AYA keeps its single instance lock inside %APPDATA%\AYA (dev builds always
  # use that folder), so a running AYA makes a new process quit silently.
  Step 'Check running AYA instances'
  $running = @(Get-ConflictingInstances)
  if ($running.Count -gt 0) {
    foreach ($p in $running) {
      Warn "running: $($p.ProcessName) (pid $($p.Id)) $($p.Path)"
    }
    if ($KillRunning) {
      Step 'Close conflicting instances'
      if (-not (Stop-ConflictingInstances)) {
        Fail 'could not close running AYA instances'
      }
      Ok 'conflicting instances closed'
    } elseif ($Mode -eq 'dev') {
      Fail 'AYA is already running and holds the single instance lock. Close it first, or add -KillRunning.'
    } else {
      Warn 'another AYA is running; it holds the lock, the new window may quit immediately'
    }
  } else {
    Ok 'no conflicting instance'
  }

  # ------------------------------------------------------------------- build
  $vite = Join-Path $root 'node_modules\.bin\vite.cmd'
  if (-not (Test-Path $vite)) { Fail 'vite not found, please run: npm install' }

  # isDev() in the app compares import.meta.env.MODE with 'development', so the
  # Vite mode must be spelled out (dev -> development, prod -> production).
  $viteMode = if ($Mode -eq 'dev') { 'development' } else { 'production' }

  Step "Build main process [$viteMode]"
  Invoke-Shell $vite @('build', "--mode=$viteMode", '--config', 'vite.main.ts')
  Step "Build preload [$viteMode]"
  Invoke-Shell $vite @('build', "--mode=$viteMode", '--config', 'vite.preload.ts')

  if ($Mode -eq 'dev') {
    Step 'Start vite dev server for renderer'
    $devLog = Join-Path $env:TEMP 'aya-dev-renderer.log'
    $devErrLog = Join-Path $env:TEMP 'aya-dev-renderer.err.log'

    $busy = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
    if ($busy) { Warn 'port 8080 already in use, main window may load a stale server' }

    $devServer = Start-Process -FilePath 'cmd.exe' `
      -ArgumentList '/c', 'npm run dev:renderer' `
      -WorkingDirectory $root -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $devLog -RedirectStandardError $devErrLog

    $ready = $false
    for ($i = 0; $i -lt 90; $i++) {
      try {
        $resp = Invoke-WebRequest 'http://localhost:8080/' -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
      } catch {
        Start-Sleep -Milliseconds 1000
      }
    }
    if (-not $ready) {
      throw "vite dev server failed to start. See $devLog"
    }
    Ok 'renderer dev server ready on http://localhost:8080'
  } else {
    Step 'Build renderer [prod]'
    Invoke-Shell $vite @('build')
  }

  if (-not (Test-Path 'dist/main/index.js')) { Fail 'dist/main/index.js missing' }

  # ------------------------------------------------------------------ launch
  if (-not (Test-Path $script:electronExe)) { Fail 'electron binary missing, please run: npm install' }

  Step 'Launch AYA'
  Write-Host "  main inspector : chrome://inspect -> localhost:$InspectPort" -ForegroundColor DarkGray
  Write-Host "  renderer debug : chrome://inspect -> localhost:$CdpPort (or Ctrl+Shift+I)" -ForegroundColor DarkGray
  Write-Host ''

  $electronArgs = @(
    "--inspect=$InspectPort",
    "--remote-debugging-port=$CdpPort",
    ('"{0}"' -f $root)
  )
  if ($Mode -eq 'dev') { $electronArgs += '--enable-logging' }

  try {
    $proc = Start-Process -FilePath $script:electronExe `
      -ArgumentList $electronArgs -WorkingDirectory $root -PassThru -Wait
  } finally {
    Stop-DevServer
  }

  Write-Host ''
  Ok "AYA exited (code $($proc.ExitCode))"
} catch {
  Write-Host ''
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Stop-DevServer
  exit 1
}
