#!/usr/bin/env bash
# Atualiza o servidor sem perder nada.
#
#   npm run atualizar
#
# Os dados (data/) e a sessão do WhatsApp (.wwebjs_auth/) ficam fora do git,
# então o `git pull` não encosta neles — mesmo assim, o backup vem antes.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Guardando uma cópia dos dados antes de mexer"
DEST="$HOME/backups"
mkdir -p "$DEST"
ARQUIVO="$DEST/antes-da-atualizacao-$(date +%Y-%m-%d_%H%M).tar.gz"
tar -czf "$ARQUIVO" data .wwebjs_auth 2>/dev/null || tar -czf "$ARQUIVO" data 2>/dev/null || true
echo "  $ARQUIVO"

echo "→ Baixando a versão nova"
git pull --ff-only

echo "→ Instalando dependências"
PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev >/dev/null 2>&1 || PUPPETEER_SKIP_DOWNLOAD=true npm ci

if systemctl list-unit-files 2>/dev/null | grep -q '^botwhats.service'; then
  echo "→ Reiniciando o serviço"
  sudo cp deploy/botwhats.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl restart botwhats
  sleep 2
  systemctl --no-pager --lines=0 status botwhats | head -4
else
  echo "→ Serviço não instalado; rode 'npm start' quando quiser subir"
fi

echo
echo "→ Conferindo"
node scripts/diagnostico.js
