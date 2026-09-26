# Security policy

Balls locks user funds in a Solana program, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub's "Report a vulnerability" button on this repository's **Security** tab (private vulnerability reporting), or message [@hugeballsdotfun](https://x.com/hugeballsdotfun) on X and ask for a private channel.

Please include what you found, how to reproduce it, and the impact you expect. We'll acknowledge the report and keep you updated while it's investigated.

## Scope

In scope: the escrow program in `programs/balls-bond`, the transaction builders in `site/pump.js`, and the keeper in `keeper/`.

Out of scope: pump.fun's own program, Solana itself, and third-party wallets or RPC providers.

## Known trust assumptions

- The program is **unaudited**.
- The program is **upgradeable** and its upgrade authority is held by the project admin wallet.
- The burn depends on pump.fun's `buy_exact_sol_in` interface. If pump.fun changes it, burns can fail until this program is updated; devs can reclaim an expired, unburned bond after 7 days.
