#!/usr/bin/env bash
# نسخة احتياطية يومية لقاعدة البيانات (pg_dump بصيغة custom) تُحفظ BACKUP_KEEP_DAYS يومًا (افتراضيًا 14).
# cron على الخادم:  15 2 * * *  cd /opt/fleet/deploy && ./backup.sh >> backups/backup.log 2>&1
# انسخ مجلد backups إلى تخزين خارج الخادم (مثل حاوية تخزين في المنطقة نفسها) حتى لا تضيع مع الخادم.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
f="backups/fleet-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U admin -d fleet -Fc > "$f.part"
mv "$f.part" "$f"
find backups -name 'fleet-*.dump' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
echo "$(date -u +%FT%TZ) backup ok $f $(du -h "$f" | cut -f1)"
