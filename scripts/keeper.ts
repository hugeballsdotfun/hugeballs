// Keeper: watches every Balls bond and, once one has passed its deadline
// with the market-cap target still unmet, sends `resolve_bond` (which buys the
// coin on pump.fun with the collateral and burns it).
//
// The keeper key can ONLY trigger burns that are already due — it can't move
// collateral anywhere else or change any setting. The admin (resolver) wallet
// can always do the same by hand from the site if this isn't running.
//
//   KEEPER_KEYPAIR=<path to the keeper's keypair json>  (required)
//   CLUSTER=devnet|mainnet-beta  RPC_URL=...            (default devnet)
//   POLL_SECONDS=60                                     (default 60)
//   ONCE=1                                              (one pass, then exit)
// The keeper wallet needs a little SOL for fees (~0.003 SOL per resolve).
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const importEsm = new Function("p", "return import(p)") as (p: string) => Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GLOBAL = new web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const log = (...a: any[]) => console.log(new Date().toISOString(), ...a);

async function main() {
  const P = await importEsm("file://" + path.join(__dirname, "../site/pump.js"));
  const cluster = (process.env.CLUSTER || "devnet") as "devnet" | "mainnet-beta";
  const connection = new web3.Connection(process.env.RPC_URL || web3.clusterApiUrl(cluster), "confirmed");
  if (!process.env.KEEPER_KEYPAIR) throw new Error("Set KEEPER_KEYPAIR to the keeper's keypair file.");
  const keeper = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEEPER_KEYPAIR, "utf-8"))));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const program = new Program(idl, provider) as any;
  const b = P.makeBuilders({ web3, splToken, program, BN });
  const pollMs = Number(process.env.POLL_SECONDS || 60) * 1000;

  const cfg = await program.account.config.fetch(b.pdas.config());
  if (!cfg.keeper.equals(keeper.publicKey) && !cfg.resolver.equals(keeper.publicKey)) {
    throw new Error(`This wallet (${keeper.publicKey.toBase58()}) isn't the configured keeper (${cfg.keeper.toBase58()}).`);
  }
  log("keeper", keeper.publicKey.toBase58(), "on", cluster, "program", program.programId.toBase58());

  const failures = new Map<string, number>();
  for (;;) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const bonds = await program.account.bond.all();
      const due = bonds.filter((x: any) => "active" in x.account.status && x.account.deadline.toNumber() < now);
      if (due.length) log(`${due.length} bond(s) past deadline`);
      const globalInfo = await connection.getAccountInfo(GLOBAL);
      for (const { account } of due) {
        const mint = account.mint as web3.PublicKey;
        const key = mint.toBase58();
        try {
          const info = await connection.getAccountInfo(b.pdas.pumpCurve(mint));
          const curve = info ? P.decodeCurve(new Uint8Array(info.data)) : null;
          if (!curve) { log(key, "no pump.fun curve found, skipping"); continue; }
          if (P.targetReached(curve, account.targetMcap.toString())) {
            log(key, "target reached — leaving it for the founder to claim");
            continue;
          }
          const sig = await b
            .resolveBuilder({ resolver: keeper.publicKey, mint, founder: account.founder, globalData: new Uint8Array(globalInfo!.data), creator: account.founder })
            .rpc();
          log(key, "RESOLVED (buy + burn):", sig);
          failures.delete(key);
        } catch (err: any) {
          const n = (failures.get(key) || 0) + 1;
          failures.set(key, n);
          log(key, `resolve failed (attempt ${n}):`, String(err.message || err).slice(0, 300));
        }
      }
    } catch (err: any) {
      log("poll error:", String(err.message || err).slice(0, 300));
    }
    if (process.env.ONCE) return;
    await sleep(pollMs);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
