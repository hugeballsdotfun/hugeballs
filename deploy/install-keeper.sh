#!/usr/bin/env bash
# Installs / updates the Balls keeper on the VPS as a hardened systemd service.
# Re-runnable. Creates (once) a dedicated keeper keypair ON THE SERVER — it never
# leaves the machine — and prints only its public address.
#   ./deploy/install-keeper.sh
set -euo pipefail
HOST="${BALLS_HOST:?set BALLS_HOST=user@your-server}"
cd "$(dirname "$0")/.."
STAGE="$(mktemp -d)"
cp keeper/package.json keeper/keeper.mjs site/pump.js site/idl.js "$STAGE/"
tar -C "$STAGE" -czf "$STAGE/keeper.tgz" package.json keeper.mjs pump.js idl.js
scp -q -o BatchMode=yes "$STAGE/keeper.tgz" "$HOST:/tmp/balls-keeper.tgz"
rm -rf "$STAGE"

ssh -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
id ballskeeper >/dev/null 2>&1 || useradd --system --home /opt/balls-keeper --shell /usr/sbin/nologin ballskeeper
mkdir -p /opt/balls-keeper /etc/balls-keeper
tar -xzf /tmp/balls-keeper.tgz -C /opt/balls-keeper && rm /tmp/balls-keeper.tgz
cd /opt/balls-keeper && npm install --omit=dev --silent --no-audit --no-fund
chown -R ballskeeper:ballskeeper /opt/balls-keeper

# keeper keypair: generated once, on this server
if [ ! -f /etc/balls-keeper/keeper.json ]; then
  node -e '
    const w=require("/opt/balls-keeper/node_modules/@solana/web3.js");
    const k=w.Keypair.generate();
    require("fs").writeFileSync("/etc/balls-keeper/keeper.json", JSON.stringify(Array.from(k.secretKey)), {mode:0o600});'
fi
# RPC url: reuse the provider url already stored (root-only) for the nginx proxy
if [ ! -f /etc/balls-keeper/env ]; then
  URL="$(sed -n 's/^proxy_pass \(.*\);$/\1/p' /etc/nginx/secrets/balls-rpc.conf | head -1)"
  printf 'RPC_URL=%s\nKEEPER_KEYPAIR=/etc/balls-keeper/keeper.json\nPOLL_SECONDS=60\n' "$URL" > /etc/balls-keeper/env
fi
chown root:ballskeeper /etc/balls-keeper /etc/balls-keeper/keeper.json /etc/balls-keeper/env
chmod 750 /etc/balls-keeper; chmod 640 /etc/balls-keeper/keeper.json /etc/balls-keeper/env

cat > /etc/systemd/system/balls-keeper.service <<'UNIT'
[Unit]
Description=Balls keeper (triggers due bond burns)
After=network-online.target
Wants=network-online.target

[Service]
User=ballskeeper
Group=ballskeeper
WorkingDirectory=/opt/balls-keeper
EnvironmentFile=/etc/balls-keeper/env
ExecStart=/usr/bin/node /opt/balls-keeper/keeper.mjs
Restart=always
RestartSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/etc/balls-keeper

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now balls-keeper >/dev/null 2>&1 || true
systemctl restart balls-keeper
sleep 2
echo "service: $(systemctl is-active balls-keeper)"
node -e 'const w=require("/opt/balls-keeper/node_modules/@solana/web3.js");const k=w.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require("fs").readFileSync("/etc/balls-keeper/keeper.json"))));console.log("KEEPER ADDRESS:",k.publicKey.toBase58())'
REMOTE
