// Runs the site's pump.fun BUY and SELL builders (site/pump.js) against real
// pump.fun on devnet with a fresh wallet, and checks the sell instruction is
// identical to pump.fun's own SDK. Uses a throwaway coin created via the
// site's create_v2 builder.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import { PumpSdk, GLOBAL_PDA } from "@pump-fun/pump-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert } from "chai";

const importEsm = new Function("p", "return import(p)") as (p: string) => Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const P = await importEsm("file://" + path.join(__dirname, "../site/pump.js"));
  const connection = new web3.Connection(web3.clusterApiUrl("devnet"), "confirmed");
  const funder = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(funder), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const b = P.makeBuilders({ web3, splToken, program: new Program(idl, provider), BN });
  const sdk = new PumpSdk();

  // a coin (created by the funder) + a fresh trader who only holds plain SOL
  const mint = web3.Keypair.generate();
  await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(b.createV2Ix({ mint: mint.publicKey, name: "Trade Test", symbol: "TRD", uri: "https://example.com/m.json", creator: funder.publicKey })), [funder, mint]);
  const trader = web3.Keypair.generate();
  await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: trader.publicKey, lamports: 200_000_000 })), [funder]);
  await sleep(3000);

  const globalData = new Uint8Array((await connection.getAccountInfo(GLOBAL_PDA))!.data);
  const curveOf = async () => P.decodeCurve(new Uint8Array((await connection.getAccountInfo(b.pdas.pumpCurve(mint.publicKey)))!.data));

  // ---- BUY 0.05 SOL ----
  const spend = 50_000_000n;
  let curve = await curveOf();
  const est = P.estimateBuyTokens(curve, spend);
  const minOut = P.applySlippage(est, 500);
  const buy = b.buyIxs({ user: trader.publicKey, mint: mint.publicKey, creator: funder.publicKey, globalData, spendLamports: spend, minTokensOut: minOut });
  await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(...buy), [trader]);
  await sleep(3000);
  const ata = b.ata2022(mint.publicKey, trader.publicKey);
  const bought = (await splToken.getAccount(connection, ata, "confirmed", splToken.TOKEN_2022_PROGRAM_ID)).amount;
  assert.isTrue(bought >= minOut, "bought fewer tokens than the guard");
  console.log("ok   buy via site builder: spent", spend.toString(), "lamports ->", bought.toString(), "tokens (estimate", est.toString() + ")");

  // ---- SELL everything, compare the instruction with the SDK's ----
  curve = await curveOf();
  const minSol = P.applySlippage(P.estimateSellLamports(curve, bought), 500);
  const mine = b.sellIx({ user: trader.publicKey, mint: mint.publicKey, creator: funder.publicKey, globalData, tokenAmount: bought, minSolOut: minSol });
  const fee = mine.keys[1].pubkey;
  const buyback = mine.keys[mine.keys.length - 1].pubkey;
  const theirs = await sdk.getSellInstructionRaw({ user: trader.publicKey, mint: mint.publicKey, creator: funder.publicKey, amount: new BN(bought.toString()), solAmount: new BN(minSol.toString()), feeRecipient: fee, buybackFeeRecipient: buyback, tokenProgram: splToken.TOKEN_2022_PROGRAM_ID, cashback: false } as any);
  assert.equal(Buffer.from(mine.data).toString("hex"), Buffer.from(theirs.data).toString("hex"), "sell data differs");
  assert.equal(mine.keys.length, theirs.keys.length);
  mine.keys.forEach((k: any, i: number) => {
    assert.equal(k.pubkey.toBase58(), theirs.keys[i].pubkey.toBase58(), `sell key ${i}`);
    assert.equal(k.isWritable, theirs.keys[i].isWritable, `sell key ${i} writable`);
    assert.equal(k.isSigner, theirs.keys[i].isSigner, `sell key ${i} signer`);
  });
  console.log("ok   sell instruction identical to pump.fun's SDK");
  const before = await connection.getBalance(trader.publicKey);
  await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(mine), [trader]);
  await sleep(3000);
  const left = (await splToken.getAccount(connection, ata, "confirmed", splToken.TOKEN_2022_PROGRAM_ID)).amount;
  assert.equal(left, 0n);
  console.log("ok   sell via site builder: tokens left 0, SOL received (net of tx fee):", (await connection.getBalance(trader.publicKey)) - before);
}
main().catch((e) => { console.error(e); process.exit(1); });
