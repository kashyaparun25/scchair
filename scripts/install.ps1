# Install Second Chair from GitHub — no npm account, no GitHub login required.
$ErrorActionPreference = "Stop"

$Repo = "https://github.com/kashyaparun25/scchair.git"
$Branch = "main"
$InstallRoot = if ($env:SCCHAIR_HOME) { $env:SCCHAIR_HOME } else { Join-Path $env:LOCALAPPDATA "scchair" }
$AppDir = Join-Path $InstallRoot "app"
$BinDir = if ($env:SCCHAIR_BIN_DIR) { $env:SCCHAIR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "scchair\bin" }
$Wrapper = Join-Path $BinDir "scchair.cmd"

function Log($msg) { Write-Host "[scchair] $msg" }

# --- Node.js 20+ ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "[scchair] Node.js is not installed. Install Node.js 20+ from https://nodejs.org"
}

$nodeVersion = (node -v) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  throw "[scchair] Node.js 20+ required (found v$nodeVersion). Install from https://nodejs.org"
}

New-Item -ItemType Directory -Force -Path $InstallRoot, $BinDir | Out-Null

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

# --- Dependencies ---
Log "Installing dependencies (first run can take a few minutes)..."
Push-Location $AppDir
npm install --no-fund --no-audit
Pop-Location

# --- CLI wrapper ---
$appDirEscaped = $AppDir -replace '\\', '\\'
@"
@echo off
node "$AppDir\bin\scchair.mjs" %*
"@ | Set-Content -Path $Wrapper -Encoding ASCII

Log "Installed to $AppDir"
Log "Command: scchair"

# --- PATH ---
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
  $env:Path = "$env:Path;$BinDir"
  Log "Added $BinDir to your user PATH (open a new terminal if scchair is not found)"
}

Write-Host ""
Write-Host "Done! Open a new terminal and run:"
Write-Host "  scchair"
Write-Host ""
Write-Host "Or run directly now:"
Write-Host "  $Wrapper"
