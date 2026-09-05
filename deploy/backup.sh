#!/usr/bin/env bash
# Backup diário do banco e da sessão do WhatsApp.
#
#   sudo cp deploy/backup.sh /usr/local/bin/botwhats-backup
#   sudo chmod +x /usr/local/bin/botwhats-backup
#   ( crontab -l 2>/dev/null; echo "15 3 * * * /usr/local/bin/botwhats-backup" ) | crontab -
#
# Defina BACKUP_S3 para mandar também a um bucket (exige IAM role na instância).

set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/Botwhats-}"
DEST="${BACKUP_DIR:-/home/ubuntu/backups}"
STAMP="$(date +%Y-%m-%d)"
ARQUIVO="$DEST/botwhats-$STAMP.tar.gz"

mkdir -p "$DEST"
tar -czf "$ARQUIVO" -C "$APP_DIR" data .wwebjs_auth 2>/dev/null || \
  tar -czf "$ARQUIVO" -C "$APP_DIR" data

# Guarda 14 dias de cópias locais.
find "$DEST" -name 'botwhats-*.tar.gz' -mtime +14 -delete

if [ -n "${BACKUP_S3:-}" ]; then
  aws s3 cp "$ARQUIVO" "$BACKUP_S3/" --only-show-errors
fi

echo "backup: $ARQUIVO"
