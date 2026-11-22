#!/usr/bin/env bash
# يُشغَّل في كل نشر: ADMIN_DATABASE_URL (superuser) و APP_DB_PASSWORD مطلوبان. آمن للتكرار.
set -euo pipefail
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
for i in $(seq 1 30); do pg_isready -d "$ADMIN_DATABASE_URL" -q && break; sleep 2; done
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q -X -v app_rw_password="'${APP_DB_PASSWORD//\'/\'\'}'" -f /db/bootstrap.sql
DATABASE_URL="$ADMIN_DATABASE_URL" /db/migrate.sh
echo "database ready"
