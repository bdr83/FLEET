#!/usr/bin/env bash
# يطبّق ملفات db/migrations بالترتيب، مرة واحدة لكل ملف، بدور app_owner.
# الاستخدام: DATABASE_URL=postgres://admin@host/db ./db/migrate.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${DATABASE_URL:?DATABASE_URL is required}"
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
for f in migrations/*.sql; do
  v=$(basename "$f" .sql)
  if [ "$("${PSQL[@]}" -tAc "SELECT 1 FROM public.schema_migrations WHERE version='$v'")" = 1 ]; then continue; fi
  echo "applying $v"
  { echo "BEGIN; SET ROLE app_owner;"; cat "$f"; echo; echo "RESET ROLE; INSERT INTO public.schema_migrations(version) VALUES ('$v'); COMMIT;"; } | "${PSQL[@]}"
done
