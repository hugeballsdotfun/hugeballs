// READ-ONLY: simulates the real launch transaction (pump.fun create_v2 + Balls
// create_bond) against the LIVE mainnet programs, using a rich existing account as a
// stand-in founder with signature verification off. Nothing is signed or sent.
import * as anchor from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const importEsm = new Function("p", "return import(p)") as (p: string) => Promise<any>;

async function main() {
  const P = await importEsm("file://" + path.join(__dirname, "../site/pump.js"));
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const connection = new web3.Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(web3.Keypair.generate()), {}));
  const b = P.makeBuilders({ web3, splToken, program, BN });
  const founder = new web3.PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"); // any funded system account
  const mint = web3.Keypair.generate().publicKey;

  const g = await connection.getAccountInfo(new web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"));
  const dv = new DataView(g!.data.buffer, g!.data.byteOffset);
  const start = (dv.getBigUint64(81, true) * dv.getBigUint64(97, true)) / dv.getBigUint64(73, true);
  const create = b.createV2Ix({ mint, name: "Sim Coin", symbol: "SIM", uri: "https://gateway.irys.xyz/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg", creator: founder });
  const mk = async (target: bigint, collateral: bigint) => b.createBondIx({ founder, mint, targetLamports: target, collateralLamports: collateral });
  const { blockhash } = await connection.getLatestBlockhash();

  async function sim(label: string, ixs: web3.TransactionInstruction[], expectFail?: string) {
    const msg = new web3.TransactionMessage({ payerKey: founder, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const r = await connection.simulateTransaction(new web3.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const logs = (r.value.logs || []).join(" ");
    if (expectFail) {
      const ok = !!r.value.err && logs.includes(expectFail);
      console.log(ok ? `ok   rejected as expected (${expectFail}): ${label}` : `FAIL expected ${expectFail}: ${label} -> ${JSON.stringify(r.value.err)}`);
      if (!ok) process.exitCode = 1;
      return;
    }
    if (r.value.err) { console.log(logs.slice(-500)); throw new Error(label + " failed: " + JSON.stringify(r.value.err)); }
    console.log(`ok   ${label} (compute units ${r.value.unitsConsumed})`);
    const ev = (r.value.logs || []).filter((l) => l.includes("Program data:") ).length;
    return ev;
  }
  await sim("launch: create_v2 + create_bond, target 3x start, 0.05 SOL bond", [create, await mk(start * 3n, 50_000_000n)]);
  await sim("target below the starting market cap", [create, await mk(start / 2n, 50_000_000n)], "TargetTooLow");
  await sim("bond below the 0.01 SOL minimum", [create, await mk(start * 3n, 1_000_000n)], "CollateralTooLow");
}
main().catch((e) => { console.error(e); process.exit(1); });
