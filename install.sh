#!/usr/bin/env bash
# Speaking AI Professor — One-Command Setup Script (macOS & Linux)
# Usage:
#   ./install.sh                  # Standard install (Node deps + checks)
#   ./install.sh --with-voice     # Also install Apple Silicon Kokoro-82M + mlx-whisper (.venv)
#   ./install.sh --link-cli       # Also register global `professor` CLI via npm link
#   ./install.sh --all            # Full Apple Silicon Studio setup (deps + voice + CLI + GPU tuning)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

WITH_VOICE=false
LINK_CLI=false
TUNE_GPU=false

for arg in "$@"; do
  case "$arg" in
    --with-voice) WITH_VOICE=true ;;
    --link-cli)   LINK_CLI=true ;;
    --tune-gpu)   TUNE_GPU=true ;;
    --all)        WITH_VOICE=true; LINK_CLI=true; TUNE_GPU=true ;;
    -h|--help)
      echo "Usage: ./install.sh [--with-voice] [--link-cli] [--tune-gpu] [--all]"
      exit 0
      ;;
  esac
done

echo ""
echo "🎓 Speaking AI Professor — Installer"
echo "====================================="

# 1. Verify Node.js >= 20
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js 20+ is required. Install it from https://nodejs.org or via 'brew install node'."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js $NODE_MAJOR detected. Please upgrade to Node.js 20 or newer."
  exit 1
fi
echo "✅ Node.js $(node -v) detected"

# 2. Install Node.js dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# 3. Check Poppler (required for high-DPI PDF slides)
if command -v pdftoppm >/dev/null 2>&1 && command -v pdftotext >/dev/null 2>&1; then
  echo "✅ Poppler PDF tools (pdftoppm / pdftotext) found"
else
  echo "⚠️  Poppler not found (needed for PDF rendering in Dual-Screen Classroom)."
  if command -v brew >/dev/null 2>&1; then
    echo "   Installing poppler via Homebrew..."
    brew install poppler
  else
    echo "   Install manually: macOS -> 'brew install poppler' | Ubuntu/Debian -> 'sudo apt install poppler-utils'"
  fi
fi

# 4. Optional Apple Silicon Neural Voice (.venv: Kokoro-82M + mlx-whisper)
if [ "$WITH_VOICE" = true ]; then
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "⚠️  --with-voice uses MLX for Apple Silicon Macs (arm64). Skipping local MLX voice setup on this platform."
    echo "   Tip: You can still use macOS/Browser voices or Gemini Live Cloud out of the box."
  else
    if command -v brew >/dev/null 2>&1 && ! brew list espeak-ng >/dev/null 2>&1; then
      echo "🔊 Installing espeak-ng via Homebrew (for Spanish/English phonemization)..."
      brew install espeak-ng
    fi
    echo "🐍 Setting up Python .venv for Kokoro-82M neural TTS + mlx-whisper STT..."
    python3 -m venv "$ROOT_DIR/.venv"
    "$ROOT_DIR/.venv/bin/python" -m pip install --upgrade pip
    "$ROOT_DIR/.venv/bin/python" -m pip install -r "$ROOT_DIR/requirements-voice.txt"
    echo "✅ Local neural voice ready!"
  fi
fi

# 5. Optional Apple Silicon Ollama Metal GPU Optimization
if [ "$TUNE_GPU" = true ] && [ "$(uname -s)" = "Darwin" ]; then
  bash "$ROOT_DIR/scripts/optimize_mac_gpu.sh"
fi

# 6. Optional Global `professor` CLI
if [ "$LINK_CLI" = true ]; then
  chmod +x "$ROOT_DIR/bin/professor.mjs"
  echo "🔗 Linking global 'professor' CLI..."
  npm link
  echo "✅ You can now run 'professor' inside ANY study folder!"
fi

# 7. Create .env from example if missing
if [ ! -f "$ROOT_DIR/.env" ] && [ -f "$ROOT_DIR/.env.example" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
fi

# 8. Run self-verification diagnostics
echo ""
echo "🔎 Running classroom diagnostics..."
npm run verify || true

echo ""
echo "🎉 Installation complete!"
echo "   Start immediately:   npm start"
echo "   Or target a folder:  node server.mjs --dir /path/to/your/notes --open"
echo "   For $0 Local AI:     install Ollama (https://ollama.com) and run 'ollama pull gemma4:12b'"
echo "   For Cloud Gemini:    add GEMINI_API_KEY inside the app's 'API Key' button or .env"
echo ""
