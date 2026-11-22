#!/usr/bin/env bash
# استعادة نسخة احتياطية: ./restore.sh backups/fleet-....dump
# يوقف الخادم ولوحة التحكم، يستبدل قاعدة البيانات كاملة، ثم يشغّلهما. يطلب تأكيدًا قبل الحذف.
set -euo pipefail
cd "$(dirname "$0")"
f="${1:?usage: ./restore.sh backups/fleet-....dump}"
[ -f "$f" ] || { echo "no such file: $f"; exit 1; }
read -r -p "سيُستبدل كل محتوى قاعدة البيانات بـ $f. اكتب restore للمتابعة: " ok
[ "$ok" = restore ] || { echo "أُلغيت"; exit 1; }
docker compose stop web api
docker compose exec -T db psql -U admin -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS fleet WITH (FORCE)" -c "CREATE DATABASE fleet"
# الأدوار على مستوى الخادم فتبقى؛ الاستعادة تحفظ المالكين والامتدادات والصلاحيات
docker compose exec -T db pg_restore -U admin -d fleet --exit-on-error < "$f"
docker compose run --rm migrate   # يعيد صلاحية قاعدة البيانات لـ app_owner ويطبّق أي ترحيل أحدث من النسخة
docker compose up -d api web
echo "restored $f"
