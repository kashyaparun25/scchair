# Install Second Chair from GitHub — no npm account, no GitHub login required.
$ErrorActionPreference = "Stop"

$Repo = "https://github.com/kashyaparun25/scchair.git"
$Branch = "main"
$InstallRoot = if ($env:SCCHAIR_HOME) { $env:SCCHAIR_HOME } else { Join-Path $env:LOCALAPPDATA "scchair" }
$AppDir = Join-Path $InstallRoot "app"
$BinDir = if ($env:SCCHAIR_BIN_DIR) { $env:SCCHAIR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "scchair\bin" }
$Wrapper = Join-Path $BinDir "scchair.cmd"

function Log($msg) { Write-Host "[scchair] $msg" }
function Fail($msg) { throw "[scchair] ERROR: $msg" }

function Ensure-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = [int](((node -v) -replace '^v', '').Split('.')[0])
    if ($major -ge 20) {
      Log "Node.js $(node -v) OK"
      return
    }
    Log "Node.js $(node -v) is too old — need 20+"
  } else {
    Log "Node.js not found"
  }

  Log "Installing Node.js 20+..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  } else {
    Fail "Install Node.js 20+ from https://nodejs.org then re-run the installer."
  }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js install finished but node is not on PATH. Open a new terminal and re-run the installer."
  }
}

function Get-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) { return @("py", "-3") }
  if (Get-Command python3 -ErrorAction SilentlyContinue) { return @("python3") }
  if (Get-Command python -ErrorAction SilentlyContinue) { return @("python") }
  return $null
}

function Invoke-Python([string[]]$Py, [string[]]$PythonArgs) {
  if ($Py.Length -gt 1) {
    return & $Py[0] @($Py[1..($Py.Length - 1)] + $PythonArgs)
  }
  return & $Py[0] @PythonArgs
}

function Ensure-Python {
  $py = Get-PythonCommand
  if ($py) {
    $version = Invoke-Python $py @("--version") 2>&1
    Log "Python OK ($version)"
    return $py
  }

  Log "Installing Python 3..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
  } else {
    Fail "Install Python 3 from https://www.python.org/downloads/ then re-run the installer."
  }

  $py = Get-PythonCommand
  if (-not $py) {
    Fail "Python install finished but python is not on PATH. Open a new terminal and re-run the installer."
  }
  $version = Invoke-Python $py @("--version") 2>&1
  Log "Python OK ($version)"
  return $py
}

function Test-PythonImport([string[]]$Py, [string]$Module) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  Invoke-Python $Py @("-c", "import $Module") 2>$null | Out-Null
  $ok = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prev
  return $ok
}

function Ensure-RivaClient([string[]]$Py) {
  if (Test-PythonImport $Py "riva.client") {
    Log "NVIDIA Riva Python client OK"
    return
  }

  Log "Installing NVIDIA Riva Python client..."
  Invoke-Python $Py @("-m", "pip", "install", "--upgrade", "pip") 2>$null
  Invoke-Python $Py @("-m", "pip", "install", "-U", "nvidia-riva-client")
  if ($LASTEXITCODE -ne 0) {
    Fail "Could not install nvidia-riva-client. Run: $($Py -join ' ') -m pip install -U nvidia-riva-client"
  }
  Log "NVIDIA Riva Python client ready"
}

function Remove-NodeModulesSafely([string]$TargetDir) {
  $nodeModules = Join-Path $TargetDir "node_modules"
  if (-not (Test-Path $nodeModules)) { return }

  Log "Cleaning previous node_modules..."
  for ($i = 1; $i -le 3; $i++) {
    try {
      Remove-Item -Recurse -Force $nodeModules -ErrorAction Stop
      return
    } catch {
      if ($i -lt 3) {
        Log "Retrying cleanup ($i/3) — close any running scchair/Electron windows first..."
        Start-Sleep -Seconds 2
      }
    }
  }
  Fail "Could not remove node_modules (files locked). Close scchair/Electron, then re-run the installer."
}

function Install-NpmDependencies([string]$TargetDir) {
  Push-Location $TargetDir
  try {
    Remove-NodeModulesSafely $TargetDir

    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
      if ($attempt -gt 1) {
        Log "npm install retry $attempt/$maxAttempts..."
        Start-Sleep -Seconds 3
      }

      & npm.cmd install --no-fund --no-audit --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
      if ($LASTEXITCODE -eq 0) { return }

      if ($attempt -lt $maxAttempts) {
        Log "npm install failed — cleaning and retrying..."
        Remove-NodeModulesSafely $TargetDir
        & npm.cmd cache verify 2>$null | Out-Null
      }
    }

    Fail "npm install failed after $maxAttempts attempts. Check your internet connection, then run: cd `"$TargetDir`" ; npm.cmd install --no-fund --no-audit"
  } finally {
    Pop-Location
  }
}

function Repair-ElectronBinary([string]$TargetDir) {
  $electronDir = Join-Path $TargetDir "node_modules\electron"
  $pathTxt = Join-Path $electronDir "path.txt"
  if (Test-Path $pathTxt) { return }

  Log "Electron binary is missing; repairing Electron install..."
  $packageJson = Get-Content (Join-Path $TargetDir "package.json") -Raw | ConvertFrom-Json
  $electronVersion = [string]$packageJson.devDependencies.electron
  if ([string]::IsNullOrWhiteSpace($electronVersion)) { $electronVersion = "latest" }
  $electronVersion = $electronVersion -replace '^[\^~]', ''

  Push-Location $TargetDir
  try {
    & npm.cmd rebuild electron --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
    if ((-not (Test-Path $pathTxt)) -and (Test-Path (Join-Path $electronDir "install.js"))) {
      Log "Running Electron binary downloader..."
      $previousForceNoCache = $env:force_no_cache
      try {
        $env:force_no_cache = "true"
        & node (Join-Path $electronDir "install.js")
      } finally {
        $env:force_no_cache = $previousForceNoCache
      }
    }

    if (-not (Test-Path $pathTxt)) {
      Log "Electron binary still missing; reinstalling Electron package..."
      & npm.cmd install "electron@$electronVersion" --save-dev --force --no-fund --no-audit --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
    }

    if ((-not (Test-Path $pathTxt)) -and (Test-Path (Join-Path $electronDir "install.js"))) {
      Log "Running Electron binary downloader after reinstall..."
      $previousForceNoCache = $env:force_no_cache
      try {
        $env:force_no_cache = "true"
        & node (Join-Path $electronDir "install.js")
      } finally {
        $env:force_no_cache = $previousForceNoCache
      }
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path $pathTxt)) {
    Fail "Electron repair failed. Check your internet connection, then run: cd `"$TargetDir`" ; npm.cmd install electron@$electronVersion --save-dev --force"
  }

  Log "Electron binary ready."
}

New-Item -ItemType Directory -Force -Path $InstallRoot, $BinDir | Out-Null

Ensure-Node
$pythonCmd = Ensure-Python
Ensure-RivaClient $pythonCmd

# --- Download or update ---
if (Test-Path (Join-Path $AppDir ".git")) {
  Log "Updating existing install..."
  git -C $AppDir fetch origin $Branch
  git -C $AppDir reset --hard "origin/$Branch"
} elseif (Test-Path $AppDir) {
  Log "Replacing existing install..."
  Remove-Item -Recurse -Force $AppDir
}

if (-not (Test-Path $AppDir)) {
  Log "Downloading from GitHub..."
  if (Get-Command git -ErrorAction SilentlyContinue) {
    git clone --depth 1 --branch $Branch $Repo $AppDir
  } else {
    $tmp = Join-Path $env:TEMP "scchair-install"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp "scchair.zip"
    Invoke-WebRequest -Uri "https://github.com/kashyaparun25/scchair/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    Move-Item (Join-Path $tmp "scchair-main") $AppDir
    Remove-Item -Recurse -Force $tmp
  }
}

Log "Installing app dependencies (first run can take a few minutes)..."
Install-NpmDependencies $AppDir
Repair-ElectronBinary $AppDir

@"
@echo off
set NVIDIA_RIVA_PYTHON=py -3
node "$AppDir\bin\scchair.mjs" %*
"@ | Set-Content -Path $Wrapper -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
  $env:Path = "$env:Path;$BinDir"
  Log "Added $BinDir to your user PATH"
}

Log "Installed to $AppDir"
Write-Host ""
Write-Host "Done! Open a new terminal and run:"
Write-Host "  scchair"
