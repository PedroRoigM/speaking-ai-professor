<#
.SYNOPSIS
  Speaking AI Professor - One-Command Setup Script for Windows 10/11 (PowerShell)
.EXAMPLE
  .\install.bat                 # Standard install (Node deps + Poppler check + native Windows SAPI voice)
  .\install.bat -WithVoice      # Also install Kokoro ONNX neural TTS + faster-whisper offline STT (.venv)
  .\install.bat -LinkCli        # Register global `professor` command via npm link
  .\install.bat -All            # Full setup (deps + neural voice + global `professor` CLI)
#>

param(
  [switch]$WithVoice,
  [switch]$LinkCli,
  [switch]$All
)

$ErrorActionPreference = "Continue"
if ($All) {
  $WithVoice = $true
  $LinkCli = $true
}

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

Write-Host ""
Write-Host "Speaking AI Professor - Windows Installer" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Verify Node.js >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "[ERROR] Node.js 20+ is required. Install from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
  exit 1
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
  Write-Host "[ERROR] Node.js $nodeMajor detected. Please upgrade to Node.js 20 or newer." -ForegroundColor Red
  exit 1
}
Write-Host "[OK] Node.js $((node -v).Trim()) detected" -ForegroundColor Green

# 2. Install Node.js dependencies
Write-Host "[..] Installing Node.js dependencies..."
& npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] npm install failed (exit code $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}
Write-Host "[OK] Node.js dependencies ready" -ForegroundColor Green

# 3. Check or install Poppler (checks PATH + WinGet/Scoop/Choco folders automatically)
function Find-WindowsPoppler {
  if ((Get-Command pdftoppm -ErrorAction SilentlyContinue) -and (Get-Command pdftotext -ErrorAction SilentlyContinue)) {
    return (Get-Command pdftoppm).Source
  }
  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $wingetPkgs = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path $wingetPkgs) {
      $hits = Get-ChildItem -Path $wingetPkgs -Filter "pdftoppm.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hits) { return $hits.FullName }
    }
    $candidates += (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\pdftoppm.exe")
  }
  $candidates += @(
    (Join-Path $env:USERPROFILE "scoop\shims\pdftoppm.exe"),
    "C:\ProgramData\chocolatey\bin\pdftoppm.exe",
    "C:\Program Files\poppler\Library\bin\pdftoppm.exe",
    "C:\poppler\Library\bin\pdftoppm.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

$popplerBin = Find-WindowsPoppler
if ($popplerBin) {
  Write-Host "[OK] Poppler PDF tools found: $popplerBin" -ForegroundColor Green
} else {
  Write-Host "[!] Poppler not found (needed for Dual-Screen PDF slides)." -ForegroundColor Yellow
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($wingetCmd) {
    Write-Host "    Installing Poppler via winget (oschwartz10612.Poppler)..."
    & winget install --id oschwartz10612.Poppler -e --accept-package-agreements --accept-source-agreements
    $popplerBin = Find-WindowsPoppler
    if ($popplerBin) {
      Write-Host "[OK] Poppler ready: $popplerBin" -ForegroundColor Green
    } else {
      Write-Host "[!] Poppler install completed or skipped. Restart terminal if needed." -ForegroundColor Yellow
    }
  } else {
    Write-Host "    Install manually: winget install oschwartz10612.Poppler  (or scoop install poppler)" -ForegroundColor Yellow
  }
}

# 4. Optional Cross-Platform Neural Voice (.venv: Kokoro ONNX + faster-whisper)
function Find-WorkingPython {
  foreach ($pair in @(@("python", @()), @("py", @("-3")), @("python3", @()))) {
    $bin = $pair[0]
    $prefix = $pair[1]
    $cmd = Get-Command $bin -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    # Ignore Windows Store alias stub that fails with exit code 9009
    try {
      $verOut = & $bin @prefix --version 2>&1
      if ($LASTEXITCODE -eq 0 -and ($verOut -match "Python 3\.")) {
        return @{ Bin = $bin; Prefix = $prefix; Version = ($verOut | Out-String).Trim() }
      }
    } catch {}
  }
  return $null
}

if ($WithVoice) {
  $pyInfo = Find-WorkingPython
  if (-not $pyInfo) {
    Write-Host "[!] Python 3.10+ not found (or only Microsoft Store stub). Skipping optional neural voice." -ForegroundColor Yellow
    Write-Host "    Native Windows SAPI voice works out of the box with 0 MB!" -ForegroundColor Yellow
  } else {
    Write-Host "[..] Setting up Python .venv ($($pyInfo.Version)) for Kokoro ONNX + faster-whisper..."
    $venvDir = Join-Path $RootDir ".venv"
    $venvPy = Join-Path $venvDir "Scripts\python.exe"
    if (-not (Test-Path $venvPy)) {
      & $pyInfo.Bin @($pyInfo.Prefix) -m venv $venvDir
    }
    if (Test-Path $venvPy) {
      & $venvPy -m pip install --upgrade pip
      & $venvPy -m pip install -r (Join-Path $RootDir "requirements-voice-crossplatform.txt")
      if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Local neural voice (Kokoro ONNX + faster-whisper) ready!" -ForegroundColor Green
      } else {
        Write-Host "[!] Some optional voice packages could not be installed (native Windows SAPI voice still works out of the box)." -ForegroundColor Yellow
      }
    } else {
      Write-Host "[!] Could not create .venv. Native Windows SAPI voice still works out of the box." -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "[OK] Native Windows SAPI voice works out of the box (0 MB). Run '.\install.bat -WithVoice' anytime for Kokoro neural voice." -ForegroundColor Green
}

# 5. Optional Global `professor` CLI
if ($LinkCli) {
  Write-Host "[..] Linking global 'professor' CLI (npm link)..."
  & npm link
  if ($LASTEXITCODE -eq 0) {
    $profCmd = Get-Command professor -ErrorAction SilentlyContinue
    if ($profCmd) {
      Write-Host "[OK] Global 'professor' CLI ready: $($profCmd.Source)" -ForegroundColor Green
    } else {
      $npmPrefix = (& npm config get prefix 2>$null).Trim()
      Write-Host "[OK] 'professor' linked in: $npmPrefix" -ForegroundColor Green
      Write-Host "     If 'professor' is not recognized yet, open a new terminal or add '$npmPrefix' to your PATH." -ForegroundColor Yellow
    }
  } else {
    Write-Host "[!] npm link failed. You can still launch anytime with 'npm start' or 'node server.mjs --open'." -ForegroundColor Yellow
  }
}

# 6. Create .env from example if missing
$envFile = Join-Path $RootDir ".env"
$envExample = Join-Path $RootDir ".env.example"
if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
  Copy-Item $envExample $envFile
}

# 7. Run classroom self-verification diagnostics
Write-Host ""
Write-Host "[..] Running classroom diagnostics..."
& npm run verify

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "  Start immediately:   npm start"
Write-Host "  Global CLI (if linked): professor"
Write-Host "  Target any folder:   node server.mjs --dir C:\path\to\your\notes --open"
Write-Host "  For $0 Local AI:     install Ollama (https://ollama.com) and run 'ollama pull gemma4:12b'"
Write-Host "  For Cloud Gemini:    add GEMINI_API_KEY inside Settings -> API Key"
Write-Host ""
