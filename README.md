# Balls

**Real devs lock real SOL.**

Balls is a launchpad for [pump.fun](https://pump.fun) coins with one rule: a dev can't launch without putting their own SOL on the line. The dev picks a market cap target and locks a bond behind it in a Solana smart contract.

- **Hit the target** within 48 hours and the dev claims the bond back.
- **Miss it** and the contract buys the coin on pump.fun with the bond and burns every token it bought.

Live site: **https://hugeballs.fun** · X: [@hugeballsdotfun](https://x.com/hugeballsdotfun)

## How it works

```
                 one transaction, signed by the dev
   ┌─────────────────────────────────────────────────────────┐
   │ 1. pump.fun  create_v2   → the coin exists on pump.fun  │
   │ 2. Balls     create_bond → bond moves into a vault PDA  │
   └─────────────────────────────────────────────────────────┘
                              │
          coin trades on pump.fun's own bonding curve (48h)
                              │
        ┌─────────────────────┴──────────────────────┐
   market cap ≥ target                       deadline passed, target missed
   (or coin graduated)                                  │
        │                                               ▼
   claim_bond → SOL back to the dev        resolve_bond (keeper / admin only)
                                            → buy the coin on pump.fun with the bond
                                            → burn every token bought
```

The contract reads the coin's market cap directly from pump.fun's on-chain bonding-curve account. There is no oracle and no off-chain input.

### Instructions

| Instruction | Signer | What it does |
|---|---|---|
| `create_bond` | dev | Locks the bond against a target for 48h. Only the wallet pump.fun recorded as the coin's creator can call it. |
| `claim_bond` | dev | Returns the bond while the curve's market cap is at/above the target (or the coin graduated). |
| `resolve_bond` | keeper or admin | After the deadline, if the target is unmet: CPI into pump.fun `buy_exact_sol_in` with the vault's SOL, then burn everything bought. |
| `refund_stuck` | dev | Returns an unresolved expired bond 7 days after its deadline (escape hatch if pump.fun's interface changes). |
| `init_config`, `set_resolver`, `set_keeper` | upgrade authority / admin | One-time setup and rotating the two wallets allowed to trigger burns. |

### Trust model

| Who | Can | Can't |
|---|---|---|
| Dev | claim when the target is hit; reclaim after the 7-day grace period | withdraw any other way, cancel, or change the terms |
| Keeper + admin wallet | trigger the burn of an expired, unmet bond | withdraw a bond, redirect it, or burn early / burn a met target |
| Program upgrade authority (admin wallet) | **replace the program's code** | – (this is a real trust assumption until the key is renounced or moved to a multisig) |

## Repository layout

```
programs/balls-bond/   Anchor program (the escrow contract)
site/                  static frontend (no bundler, no backend)
  pump.js              pump.fun instruction builders (pure module, shared with the scripts)
keeper/                service that triggers due burns
scripts/               devnet tests, mainnet simulation, config initialisation
deploy/                nginx config and helper scripts for a single VPS
```

## Mainnet deployment

- **Program:** [`UreL6sVKo1EgsyLwwhGL6gBKA3V3zTDb2YC7Z3bALLs`](https://solscan.io/account/UreL6sVKo1EgsyLwwhGL6gBKA3V3zTDb2YC7Z3bALLs)
- **Binary sha256:** `1813f7325d9f7d96849104362d6b013cfc92814aeabca44c56e3102199374615` (371,512 bytes, reproducible with `anchor build`)
- **Admin / upgrade authority:** `HE8Khn19yPTzFZTLcoZLZqRV1AWypnUJ4L4NoYLS66uw`

## Build and verify the contract

Requires Rust, the Solana CLI and Anchor 0.31.1.

```bash
anchor build                      # production build (48h bonds)
shasum -a 256 target/deploy/balls_bond.so
```

To check that the deployed program matches this source, build it here, dump the deployed binary, and compare hashes:

```bash
solana program dump <PROGRAM_ID> deployed.so --url mainnet-beta
head -c "$(stat -f %z target/deploy/balls_bond.so)" deployed.so | shasum -a 256
```

> Never deploy a build made with `--features devnet-short-deadline`: it shrinks the bond deadline to 60 seconds and exists only for devnet testing.

## Run the site locally

The site is plain static files.

```bash
cd site && python3 -m http.server 8000
# open http://localhost:8000/?net=devnet   (devnet test mode)
```

Mainnet is the default; add `?net=devnet` once to switch a browser to devnet. `site/config.js` points at an RPC proxy (`/rpc`) that your server provides so the provider key never reaches the browser; on localhost it falls back to Solana's public RPC.

## Tests

The devnet scripts run the real program against the real pump.fun program. They need a funded devnet wallet and a build with `--features devnet-short-deadline`:

```bash
npm install
npx ts-node scripts/devnet-bond-smoke.ts        # claim and burn paths
npx ts-node scripts/devnet-bond-negative.ts     # guard / rejection cases
npx ts-node scripts/mainnet-sim.ts              # read-only simulation against mainnet (sends nothing)
```

## Security

Found a vulnerability? Please read [SECURITY.md](SECURITY.md) and report it privately.

## License

[MIT](LICENSE)
