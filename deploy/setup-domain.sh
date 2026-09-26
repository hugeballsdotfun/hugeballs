#!/usr/bin/env bash
# One-time: attaches a domain to the site on the VPS and gets HTTPS.
# The domain's A records (@ and www) must already point at the server.
#   ./deploy/setup-domain.sh ballsbond.com
set -euo pipefail
DOMAIN="${1:?usage: setup-domain.sh <domain>}"
HOST="${BALLS_HOST:?set BALLS_HOST=user@your-server}"
cd "$(dirname "$0")"
sed "s/DOMAIN/${DOMAIN}/g" balls.nginx.conf | ssh -o BatchMode=yes "$HOST" "cat > /etc/nginx/conf.d/balls.conf"
ssh -o BatchMode=yes "$HOST" "nginx -t && systemctl reload nginx"
echo "HTTP is up for ${DOMAIN}. Requesting the HTTPS certificate…"
ssh -o BatchMode=yes "$HOST" "certbot --nginx -d ${DOMAIN} -d www.${DOMAIN} --non-interactive --agree-tos --redirect -m \${CERTBOT_EMAIL:-admin@${DOMAIN}} && nginx -t && systemctl reload nginx"
echo "Done: https://${DOMAIN}"
