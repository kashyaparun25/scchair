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

function Ensure-Python {
  $py = Get-PythonCommand
  if ($py) {
    $version = & $py[0] $py[1..($py.Length - 1)] --version 2>&1
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
  $version = & $py[0] $py[1..($py.Length - 1)] --version 2>&1
  Log "Python OK ($version)"
  return $py
}

function Ensure-RivaClient([string[]]$Py) {
  $check = & $Py[0] $Py[1..($Py.Length - 1)] -c "import riva.client" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Log "NVIDIA Riva Python client OK"
    return
  }

  Log "Installing NVIDIA Riva Python client..."
  & $Py[0] $Py[1..($Py.Length - 1)] -m pip install --upgrade pip 2>$null
  & $Py[0] $Py[1..($Py.Length - 1)] -m pip install -U nvidia-riva-client
  if ($LASTEXITCODE -ne 0) {
    Fail "Could not install nvidia-riva-client. Run: $($Py -join ' ') -m pip install -U nvidia-riva-client"
  }
  Log "NVIDIA Riva Python client ready"
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
Push-Location $AppDir
npm install --no-fund --no-audit
Pop-Location

@"
@echo off
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
