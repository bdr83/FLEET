#!/usr/bin/env bash
# يُشغَّل على الخادم من workflow ‏deploy (عبر SSH) في /opt/fleet/deploy. آمن للتكرار:
# - يثبّت Docker (والجدار الناري إن طُلب) ومهمة النسخ الاحتياطي اليومية عند أول مرة.
# - ينشئ .env بأسرار عشوائية تُولَّد على الخادم نفسه ولا تغادره، ويحدّث الإعدادات القادمة من GitHub (config.env).
# - يسحب الصور بالوسم TAG ويشغّلها، ثم يتحقق من صحة الخادم.
set -euo pipefail
cd "$(dirname "$0")"
: "${TAG:?TAG is required}"
# رمز قراءة الصور من ghcr.io يصل على stdin (لا يظهر في قائمة العمليات)، ويُسجَّل الخروج عند الانتهاء
GHCR_TOKEN=""; [ -t 0 ] || read -r GHCR_TOKEN || true

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
# الجدار الناري فقط على خادم مخصص (MANAGE_FIREWALL=1)، حتى لا نغلق منافذ مشاريع أخرى على خادم مشترك
if [ "${MANAGE_FIREWALL:-0}" = 1 ] && command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

if [ -n "$GHCR_TOKEN" ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
fi

umask 077
if [ ! -f .env ]; then
  cp .env.example .env
  for k in DB_ADMIN_PASSWORD APP_DB_PASSWORD AUTH_JWT_SECRET OTP_PEPPER; do
    sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
  done
  echo "created .env with fresh secrets"
fi
set_kv() { # key value: replace the line or append it; value is taken literally
  local k="$1" v="$2" tmp; tmp=$(mktemp)
  awk -v k="$k" -v v="$v" 'BEGIN{d=0} index($0, k"=")==1 {print k"="v; d=1; next} {print} END{if(!d) print k"="v}' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
}
# متغيرات GitHub الملصوقة من متصفح ويندوز تحمل \r في نهاية الأسطر: نحذفها هنا ومن .env
sed -i 's/\r$//' .env
if [ -f config.env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [ -z "$line" ] && continue
    k="${line%%=*}"; v="${line#*=}"
    [ -n "$v" ] && set_kv "$k" "$v"
  done < config.env
  rm -f config.env
fi
set_kv TAG "$TAG"
chmod 600 .env

mkdir -p backups
cron="15 2 * * * cd $(pwd) && ./backup.sh >> backups/backup.log 2>&1"
if command -v crontab >/dev/null; then ( crontab -l 2>/dev/null | grep -vF './backup.sh' ; echo "$cron" ) | crontab -; fi

if docker compose ps -q db 2>/dev/null | grep -q .; then ./backup.sh || echo "backup before update failed (continuing)"; fi
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

# خادم مشترك: إضافة النطاقين إلى nginx الموجود (مرة عند الطلب، PROXY_SETUP=1)
if [ "${PROXY_SETUP:-0}" = 1 ]; then
  for k in APP_DOMAIN API_DOMAIN NGINX_CONTAINER NGINX_CONF ACME_WEBROOT ACME_WEBROOT_IN; do
    export "$k=$(grep "^$k=" .env | head -1 | cut -d= -f2-)"
  done
  ./nginx-shared.sh
fi

api=$(grep '^API_DOMAIN=' .env | cut -d= -f2)
port=$(grep '^API_PORT=' .env | cut -d= -f2); port=${port:-3100}
if grep -q '^COMPOSE_PROFILES=.*caddy' .env; then url="https://$api/health"; else url="http://127.0.0.1:$port/health"; fi
for i in $(seq 1 30); do
  if curl -fsS "$url" 2>/dev/null | grep -q '"ok"'; then
    echo "healthy: $url"
    [ "$url" = "https://$api/health" ] || curl -fsS -m 10 "https://$api/health" >/dev/null 2>&1 && echo "public: https://$api/health" || echo "public URL not reachable yet: point the existing reverse proxy at 127.0.0.1:$port ($api) and 127.0.0.1:$(grep '^WEB_PORT=' .env | cut -d= -f2) (app)"
    docker compose ps; exit 0
  fi
  sleep 5
done
echo "API not healthy at $url"; docker compose ps; docker compose logs --tail 30 api; exit 1
