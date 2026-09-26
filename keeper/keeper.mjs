// Balls keeper. Watches every bond and, once one is past its deadline with the
// market-cap target still unmet, sends `resolve_bond` (which makes the escrow
// program buy the coin on pump.fun with the collateral and burn it).
//
// The keeper key can ONLY trigger burns that are already due. It cannot move
// collateral anywhere else or change any setting, and holds nothing but a few
// cents of SOL to pay transaction fees. The admin wallet can do the same from
// the site if this isn't running.
//
// env:
//   RPC_URL          full https RPC url (required)
//   KEEPER_KEYPAIR   path to the keeper's keypair json (required)
//   POLL_SECONDS     default 60
//   ONCE=1           one pass then exit
import * as anchor from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { makeBuilders, decodeCurve, targetReached } from "./pump.js";
import { IDL } from "./idl.js";

const GLOBAL = new web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const rpc = process.env.RPC_URL;
const keyPath = process.env.KEEPER_KEYPAIR;
if (!rpc || !keyPath) throw new Error("Set RPC_URL and KEEPER_KEYPAIR.");
const keeper = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf-8"))));
const connection = new web3.Connection(rpc, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), { commitment: "confirmed" });
const program = new anchor.Program(IDL, provider);
const b = makeBuilders({ web3, splToken, program, BN });
const pollMs = Number(process.env.POLL_SECONDS || 60) * 1000;
const failures = new Map();

async function pass() {
  const cfg = await program.account.config.fetchNullable(b.pdas.config());
  if (!cfg) return log("Balls config isn't initialized yet — waiting.");
  if (!cfg.keeper.equals(keeper.publicKey) && !cfg.resolver.equals(keeper.publicKey)) {
    return log(`This wallet (${keeper.publicKey.toBase58()}) is not the configured keeper (${cfg.keeper.toBase58()}).`);
  }
  const balance = await connection.getBalance(keeper.publicKey);
  if (balance < 5_000_000) log(`LOW BALANCE: keeper has ${balance / 1e9} SOL — top it up so it can send transactions.`);

  const now = Math.floor(Date.now() / 1000);
  const bonds = await program.account.bond.all();
  const due = bonds.filter((x) => "active" in x.account.status && x.account.deadline.toNumber() < now);
  if (!due.length) return;
  log(`${due.length} bond(s) past their deadline`);
  const globalInfo = await connection.getAccountInfo(GLOBAL);
  for (const { account } of due) {
    const mint = account.mint;
    const key = mint.toBase58();
    try {
      const info = await connection.getAccountInfo(b.pdas.pumpCurve(mint));
      const curve = info ? decodeCurve(new Uint8Array(info.data)) : null;
      if (!curve) { log(key, "no pump.fun curve found — skipping"); continue; }
      if (targetReached(curve, account.targetMcap.toString())) { log(key, "target reached — the founder can claim; not burning"); continue; }
      const sig = await b
        .resolveBuilder({ resolver: keeper.publicKey, mint, founder: account.founder, globalData: new Uint8Array(globalInfo.data), creator: account.founder })
        .rpc();
      log(key, "RESOLVED (buy + burn):", sig);
      failures.delete(key);
    } catch (err) {
      const n = (failures.get(key) || 0) + 1;
      failures.set(key, n);
      log(key, `resolve failed (attempt ${n}):`, String(err.message || err).slice(0, 300));
    }
  }
}

log("keeper", keeper.publicKey.toBase58(), "program", program.programId.toBase58());
for (;;) {
  try {
    await pass();
  } catch (err) {
    log("poll error:", String(err.message || err).slice(0, 300));
  }
  if (process.env.ONCE) break;
  await sleep(pollMs);
}
