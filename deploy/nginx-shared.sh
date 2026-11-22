#!/usr/bin/env bash
# يضيف نطاقي المنصة إلى nginx موجود في حاوية على خادم مشترك، بحذر:
#   1) نسخة احتياطية من ملف الإعداد، 2) كتلة المنفذ 80 (تحدي ACME + تحويل إلى HTTPS)، 3) شهادة Let's Encrypt
#   بطريقة webroot، 4) كتلتا 443، مع nginx -t قبل كل إعادة تحميل، والرجوع للنسخة الاحتياطية عند أي فشل.
# آمن للتكرار: إن وُجدت كتلة المنصة (بين علامتي fleet-begin/fleet-end) تُستبدل ولا تُكرَّر.
# المتغيرات: APP_DOMAIN API_DOMAIN NGINX_CONTAINER NGINX_CONF (المسار على الخادم) ACME_WEBROOT (على الخادم)
#            ACME_WEBROOT_IN (المسار نفسه داخل حاوية nginx)
set -euo pipefail
: "${APP_DOMAIN:?}" "${API_DOMAIN:?}" "${NGINX_CONTAINER:?}" "${NGINX_CONF:?}" "${ACME_WEBROOT:?}" "${ACME_WEBROOT_IN:?}"
CERT=fleet-q8hub
LIVE=/etc/letsencrypt/live/$CERT
V6=""; grep -q "listen \[::\]" "$NGINX_CONF" && V6=1   # IPv6 only if the existing config already uses it
backup="$NGINX_CONF.bak-fleet-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$NGINX_CONF" "$backup"
echo "backup: $backup"

block80() { cat <<NG
# fleet-begin (أُضيف آليًا بواسطة FLEET deploy/nginx-shared.sh؛ لا تعدّل بين العلامتين)
server {
    listen 80;
$( [ -n "$V6" ] && echo '    listen [::]:80;')
    server_name $APP_DOMAIN $API_DOMAIN;
    location /.well-known/acme-challenge/ { root $ACME_WEBROOT_IN; }
    location / { return 301 https://\$host\$request_uri; }
}
NG
}
block443() { cat <<NG
server {
    listen 443 ssl;
$( [ -n "$V6" ] && echo '    listen [::]:443 ssl;')
    http2 on;
    server_name $APP_DOMAIN;
    ssl_certificate $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    location / {
        set \$fleet_web http://fleet-web:3001;
        resolver 127.0.0.11 valid=30s;
        proxy_pass \$fleet_web;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
server {
    listen 443 ssl;
$( [ -n "$V6" ] && echo '    listen [::]:443 ssl;')
    http2 on;
    server_name $API_DOMAIN;
    ssl_certificate $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 10m;
    location / {
        set \$fleet_api http://fleet-api:3000;
        resolver 127.0.0.11 valid=30s;
        proxy_pass \$fleet_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NG
}
write() { # replace the fleet block (or append) with the given content
  local tmp; tmp=$(mktemp)
  awk '/^# fleet-begin/{skip=1} !skip{print} /^# fleet-end/{skip=0}' "$NGINX_CONF" > "$tmp"
  { cat "$tmp"; printf '\n'; cat; echo "# fleet-end"; } > "$NGINX_CONF.new"
  cat "$NGINX_CONF.new" > "$NGINX_CONF"   # keep the inode: the file is bind-mounted into the container
  rm -f "$tmp" "$NGINX_CONF.new"
}
apply() {
  if docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
    docker exec "$NGINX_CONTAINER" nginx -s reload
  else
    docker exec "$NGINX_CONTAINER" nginx -t || true
    echo "nginx -t failed: restoring $backup"; cat "$backup" > "$NGINX_CONF"; exit 1
  fi
}

if [ -f "$LIVE/fullchain.pem" ]; then
  { block80; block443; } | write; apply; echo "nginx: fleet vhosts updated"; exit 0
fi
block80 | write; apply
command -v certbot >/dev/null || { echo "certbot not found on the host"; cat "$backup" > "$NGINX_CONF"; apply; exit 1; }
certbot certonly --webroot -w "$ACME_WEBROOT" -d "$APP_DOMAIN" -d "$API_DOMAIN" --cert-name "$CERT" \
  --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
  --deploy-hook "docker exec $NGINX_CONTAINER nginx -s reload"
{ block80; block443; } | write; apply
echo "nginx: fleet vhosts with HTTPS for $APP_DOMAIN and $API_DOMAIN"
