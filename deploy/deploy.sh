#!/usr/bin/env bash
# Uploads the static site to the VPS. Safe to re-run any time (that's how
# updates go out). Only touches /var/www/balls.
#   ./deploy/deploy.sh
set -euo pipefail
HOST="${BALLS_HOST:?set BALLS_HOST=user@your-server}"
cd "$(dirname "$0")/.."
ssh -o BatchMode=yes "$HOST" 'mkdir -p /var/www/balls'
rsync -az --delete --exclude '.DS_Store' -e "ssh -o BatchMode=yes" site/ "$HOST:/var/www/balls/"
ssh -o BatchMode=yes "$HOST" 'chown -R root:root /var/www/balls && find /var/www/balls -type d -exec chmod 755 {} + && find /var/www/balls -type f -exec chmod 644 {} +'
echo "Deployed $(ls site | wc -l | tr -d ' ') files to $HOST:/var/www/balls"
