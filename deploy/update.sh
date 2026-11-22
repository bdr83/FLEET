#!/usr/bin/env bash
# تحديث الخادم لآخر صور منشورة (أو لوسم محدد: TAG=<sha> ./update.sh). يأخذ نسخة احتياطية أولًا.
set -euo pipefail
cd "$(dirname "$0")"
./backup.sh
docker compose pull
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
docker compose ps
