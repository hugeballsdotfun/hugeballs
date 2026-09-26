#!/usr/bin/env bash
# Deploys the Balls escrow program to MAINNET, initializes its config, and hands the
# upgrade authority to the admin wallet. Run only after the deployer wallet is funded.
#   ./deploy/mainnet/deploy-program.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DEPLOYER="$HOME/.config/balls/mainnet-deployer.json"
PROGRAM_KEYPAIR="target/deploy/balls_bond-keypair.json"
SO="deploy/mainnet/balls_bond.so"
ADMIN="HE8Khn19yPTzFZTLcoZLZqRV1AWypnUJ4L4NoYLS66uw"          # resolver + final upgrade authority
KEEPER="${KEEPER:?set KEEPER=<keeper public address>}"
HOST="${BALLS_HOST:?set BALLS_HOST=user@your-server}"
# The paid RPC url lives only on the server; fetch it for this run.
RPC="$(ssh -n -o BatchMode=yes "$HOST" "sed -n 's/^proxy_pass \(.*\);\$/\1/p' /etc/nginx/secrets/balls-rpc.conf | head -1")"
PID="$(solana address -k "$PROGRAM_KEYPAIR")"
BAL="$(solana balance -k "$DEPLOYER" -u "$RPC" | awk '{print $1}')"
echo "program id: $PID | deployer: $(solana address -k "$DEPLOYER") | balance: $BAL SOL"
awk -v b="$BAL" 'BEGIN{ if (b+0 < 3.85) { print "Need at least ~3.85 SOL in the deployer wallet (about 1.9 stays as program rent, the rest is a temporary buffer that comes back)."; exit 1 } }'
echo "sha256 of the binary being deployed: $(shasum -a 256 "$SO" | cut -d' ' -f1)"
if [ "${BALLS_CONFIRM:-}" != "yes" ]; then
  read -r -p "Deploy to MAINNET? type 'yes': " OK; [ "$OK" = "yes" ] || { echo aborted; exit 1; }
fi

solana program deploy "$SO" --program-id "$PROGRAM_KEYPAIR" --keypair "$DEPLOYER" --url "$RPC" --with-compute-unit-price 100000
echo "--- initializing config (resolver=$ADMIN, keeper=$KEEPER)"
CLUSTER=mainnet-beta RPC_URL="$RPC" KEYPAIR_PATH="$DEPLOYER" RESOLVER="$ADMIN" KEEPER="$KEEPER" npx ts-node scripts/init-config.ts
echo "--- handing the upgrade authority to the admin wallet"
solana program set-upgrade-authority "$PID" --keypair "$DEPLOYER" --new-upgrade-authority "$ADMIN" --skip-new-upgrade-authority-signer-check --url "$RPC"
echo "--- verifying the on-chain binary matches"
solana program dump "$PID" /tmp/balls_onchain.so --url "$RPC" >/dev/null
ON="$(head -c "$(stat -f %z "$SO")" /tmp/balls_onchain.so | shasum -a 256 | cut -d' ' -f1)"; LOCAL="$(shasum -a 256 "$SO" | cut -d' ' -f1)"
[ "$ON" = "$LOCAL" ] && echo "OK: on-chain program == local build" || { echo "MISMATCH"; exit 1; }
solana program show "$PID" --url "$RPC" | grep -E "Program Id|Authority|Data Length"
