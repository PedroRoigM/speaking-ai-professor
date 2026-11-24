#!/usr/bin/env bash
# Optimiza Ollama en Apple Silicon (MacBook Pro M4 Pro · 24 GB UMA · 20-core Metal GPU)
# Aplica variables recomendadas vía launchctl + LaunchAgent persistente tras reinicios.
# Uso: bash Speaking_AI_Professor/scripts/optimize_mac_gpu.sh

set -euo pipefail

echo "⚡ Configurando optimizaciones GPU Metal / MLX para Ollama en Apple Silicon (24 GB UMA)..."

# 1. Aplicar inmediatamente a la sesión actual de macOS (launchd)
launchctl setenv OLLAMA_FLASH_ATTENTION "1"
launchctl setenv OLLAMA_KV_CACHE_TYPE "q8_0"
launchctl setenv OLLAMA_MAX_LOADED_MODELS "1"
launchctl setenv OLLAMA_NUM_PARALLEL "1"
launchctl setenv OLLAMA_KEEP_ALIVE "30m"

# 2. Persistir tras reinicios mediante un LaunchAgent mínimo del usuario
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.speaking-professor.ollama-gpu.plist"
mkdir -p "$PLIST_DIR"

cat > "$PLIST_PATH" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.speaking-professor.ollama-gpu</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>launchctl setenv OLLAMA_FLASH_ATTENTION 1; launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0; launchctl setenv OLLAMA_MAX_LOADED_MODELS 1; launchctl setenv OLLAMA_NUM_PARALLEL 1; launchctl setenv OLLAMA_KEEP_ALIVE 30m</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF

echo "✅ Variables aplicadas y guardadas en: $PLIST_PATH"
echo "   - OLLAMA_FLASH_ATTENTION=1       (Flash Attention en Metal GPU)"
echo "   - OLLAMA_KV_CACHE_TYPE=q8_0      (mitad de RAM en KV-cache sin pérdida de calidad)"
echo "   - OLLAMA_MAX_LOADED_MODELS=1     (evita swap en 24 GB de RAM unificada)"
echo "   - OLLAMA_NUM_PARALLEL=1          (100% de los 273 GB/s dedicados a tu clase)"
echo "   - OLLAMA_KEEP_ALIVE=30m          (modelo siempre caliente en GPU)"
echo ""
# 3. Asegurar que también se apliquen al lanzar `ollama serve` manualmente desde zsh
ZSHRC="$HOME/.zshrc"
MARKER="# Speaking AI Professor — Ollama Metal GPU M4 Pro"
if ! grep -qF "$MARKER" "$ZSHRC" 2>/dev/null; then
  cat >> "$ZSHRC" <<'EOF'

# Speaking AI Professor — Ollama Metal GPU M4 Pro
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_KEEP_ALIVE=30m
EOF
  echo "✅ Variables añadidas también a $ZSHRC (para uso con 'ollama serve' en terminal)"
fi

# 4. Si Ollama corre como servicio de Homebrew, reiniciarlo automáticamente
if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q "^ollama[[:space:]]\+started"; then
  echo "🔄 Reiniciando servicio Homebrew de Ollama..."
  brew services restart ollama
  echo "✅ Servicio Homebrew 'ollama' reiniciado con optimizaciones GPU activas."
else
  echo "🔄 Paso final:"
  echo "   - Si usas Homebrew: ejecuta 'brew services restart ollama'"
  echo "   - Si lo arrancas a mano en terminal: cierra 'ollama serve' (Ctrl+C), ejecuta 'source ~/.zshrc' y vuelve a lanzar 'ollama serve'"
fi
echo "   Luego ejecuta 'ollama ps' mientras das clase para confirmar 100% GPU y runner MLX."
