#!/usr/bin/env bash
# Stores the RPC provider URL (with its API key) on the server ONLY, in a
# root-only file that nginx includes. The key never goes into the site's files.
#   ./deploy/set-rpc.sh 'https://mainnet.helius-rpc.com/?api-key=XXXX'
set -euo pipefail
URL="${1:?usage: set-rpc.sh <https rpc url>}"
HOST="${BALLS_HOST:?set BALLS_HOST=user@your-server}"
case "$URL" in https://*) ;; *) echo "URL must start with https://"; exit 1;; esac
HOSTNAME_ONLY="$(echo "$URL" | sed -E 's#^https://([^/]+).*#\1#')"
ssh -o BatchMode=yes "$HOST" "mkdir -p /etc/nginx/secrets && chmod 700 /etc/nginx/secrets && umask 077 && cat > /etc/nginx/secrets/balls-rpc.conf" <<CONF
proxy_pass ${URL};
proxy_set_header Host ${HOSTNAME_ONLY};
proxy_ssl_server_name on;
CONF
ssh -o BatchMode=yes "$HOST" "chmod 600 /etc/nginx/secrets/balls-rpc.conf && nginx -t && systemctl reload nginx"
echo "RPC proxy configured for ${HOSTNAME_ONLY} (key stored server-side only)."
