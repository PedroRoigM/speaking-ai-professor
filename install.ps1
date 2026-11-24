<#
.SYNOPSIS
  Speaking AI Professor — One-Command Setup Script for Windows 10/11 (PowerShell)
.EXAMPLE
  .\install.ps1                 # Standard install (Node deps + Poppler check + native Windows SAPI voice)
  .\install.ps1 -WithVoice      # Also install Kokoro ONNX neural TTS + faster-whisper offline STT (.venv)
  .\install.ps1 -LinkCli        # Register global `professor` command via npm link
  .\install.ps1 -All            # Full setup (deps + neural voice + global `professor` CLI)
#>

param(
  [switch]$WithVoice,
  [switch]$LinkCli,
  [switch]$All
)

$ErrorActionPreference = "Stop"
if ($All) {
  $WithVoice = $true
  $LinkCli = $true
}

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

Write-Host ""
Write-Host "Speaking AI Professor — Windows Installer" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Verify Node.js >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "ERROR: Node.js 20+ is required. Install it from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
  exit 1
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
  Write-Host "ERROR: Node.js $nodeMajor detected. Please upgrade to Node.js 20 or newer." -ForegroundColor Red
  exit 1
}
Write-Host "[OK] Node.js $((node -v).Trim()) detected" -ForegroundColor Green

# 2. Install Node.js dependencies
Write-Host "[..] Installing Node.js dependencies..."
npm install

# 3. Check or install Poppler (required for high-DPI PDF slides)
$hasPoppler = (Get-Command pdftoppm -ErrorAction SilentlyContinue) -and (Get-Command pdftotext -ErrorAction SilentlyContinue)
if ($hasPoppler) {
  Write-Host "[OK] Poppler PDF tools (pdftoppm / pdftotext) found" -ForegroundColor Green
} else {
  Write-Host "[!] Poppler not found on PATH (needed for Dual-Screen PDF slides)." -ForegroundColor Yellow
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($wingetCmd) {
    Write-Host "    Installing Poppler via winget (oschwartz10612.Poppler)..."
    try {
      winget install --id oschwartz10612.Poppler -e --accept-package-agreements --accept-source-agreements
      Write-Host "[OK] Poppler installed. (If a new shell is needed for PATH, Speaking AI Professor also auto-detects WinGet Poppler folders.)" -ForegroundColor Green
    } catch {
      Write-Host "    Could not auto-install Poppler via winget. Install manually: winget install oschwartz10612.Poppler" -ForegroundColor Yellow
    }
  } else {
    Write-Host "    Install manually via winget (`winget install oschwartz10612.Poppler`) or Scoop (`scoop install poppler`)." -ForegroundColor Yellow
  }
}

# 4. Optional Cross-Platform Neural Voice (.venv: Kokoro ONNX + faster-whisper)
if ($WithVoice) {
  $pyCmd = Get-Command python -ErrorAction SilentlyContinue
  if (-not $pyCmd) { $pyCmd = Get-Command py -ErrorAction SilentlyContinue }
  if (-not $pyCmd) {
    Write-Host "[!] Python 3.10+ not found. Skipping optional neural voice (Windows native SAPI voice works out of the box with 0 MB!)." -ForegroundColor Yellow
  } else {
    Write-Host "[..] Setting up Python .venv for Kokoro ONNX neural TTS + faster-whisper STT..."
    if ($pyCmd.Name -eq "py.exe") {
      & py -3 -m venv "$RootDir\.venv"
    } else {
      & python -m venv "$RootDir\.venv"
    }
    $venvPy = Join-Path $RootDir ".venv\Scripts\python.exe"
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r (Join-Path $RootDir "requirements-voice-crossplatform.txt")
    Write-Host "[OK] Local neural voice (Kokoro ONNX + faster-whisper) ready!" -ForegroundColor Green
  }
} else {
  Write-Host "[OK] Native Windows SAPI voice works out of the box (0 MB). Run '.\install.ps1 -WithVoice' anytime for Kokoro neural voice." -ForegroundColor Green
}

# 5. Optional Global `professor` CLI
if ($LinkCli) {
  Write-Host "[..] Linking global 'professor' CLI..."
  npm link
  Write-Host "[OK] You can now run 'professor' inside ANY study folder!" -ForegroundColor Green
}

# 6. Create .env from example if missing
if (-not (Test-Path "$RootDir\.env") -and (Test-Path "$RootDir\.env.example")) {
  Copy-Item "$RootDir\.env.example" "$RootDir\.env"
}

# 7. Run classroom self-verification diagnostics
Write-Host ""
Write-Host "[..] Running classroom diagnostics..."
try { npm run verify } catch {}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "  Start immediately:   npm start"
Write-Host "  Or target a folder:  node server.mjs --dir C:\path\to\your\notes --open"
Write-Host "  For $0 Local AI:     install Ollama (https://ollama.com) and run 'ollama pull gemma4:12b'"
Write-Host "  For Cloud Gemini:    add GEMINI_API_KEY inside the app's Settings -> API Key button"
Write-Host ""
