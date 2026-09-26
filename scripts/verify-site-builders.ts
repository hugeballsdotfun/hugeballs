// Verifies site/pump.js (the browser code) against pump.fun's own SDK, then
// drives a real launch -> bond -> (wait) -> burn on devnet THROUGH those same
// builders. Needs the `devnet-short-deadline` program build.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import { PumpSdk, OnlinePumpSdk, GLOBAL_PDA } from "@pump-fun/pump-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert } from "chai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// ts-node compiles to CommonJS, which would turn a plain import() into
// require() and fail on an ES module — go through Function to keep it native.
const importEsm = new Function("p", "return import(p)") as (p: string) => Promise<any>;

async function main() {
  const { makeBuilders, decodeCurve, marketCapLamports, targetReached } = await importEsm(
    "file://" + path.join(__dirname, "../site/pump.js")
  );
  const connection = new web3.Connection(web3.clusterApiUrl("devnet"), "confirmed");
  const wallet = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const program = new Program(idl, provider);
  const b = makeBuilders({ web3, splToken, program, BN });
  const sdk = new PumpSdk();
  const online = new OnlinePumpSdk(connection);

  // ---- 1. create_v2: identical to the SDK's, byte for byte ----
  const mint = web3.Keypair.generate();
  const args = { mint: mint.publicKey, name: "Site Builder Test", symbol: "SBT", uri: "https://example.com/m.json", creator: wallet.publicKey };
  const mine = b.createV2Ix(args);
  const theirs = await sdk.createV2Instruction({ ...args, user: wallet.publicKey, mayhemMode: false } as any);
  assert.equal(Buffer.from(mine.data).toString("hex"), Buffer.from(theirs.data).toString("hex"), "create_v2 data differs");
  assert.equal(mine.keys.length, theirs.keys.length);
  mine.keys.forEach((k: any, i: number) => {
    const t = theirs.keys[i];
    assert.equal(k.pubkey.toBase58(), t.pubkey.toBase58(), `key ${i} pubkey`);
    assert.equal(k.isSigner, t.isSigner, `key ${i} signer`);
    assert.equal(k.isWritable, t.isWritable, `key ${i} writable`);
  });
  console.log("ok   create_v2 instruction identical to pump.fun's SDK (data + all", mine.keys.length, "accounts)");

  // ---- 2. launch + bond in one tx through the site builders ----
  const globalInfo = await connection.getAccountInfo(GLOBAL_PDA);
  const g: any = await online.fetchGlobal();
  const startMcap = (BigInt(g.initialVirtualSolReserves.toString()) * BigInt(g.tokenTotalSupply.toString())) / BigInt(g.initialVirtualTokenReserves.toString());
  const target = (startMcap * 160n) / 100n;
  const bondIx = await b.createBondIx({ founder: wallet.publicKey, mint: mint.publicKey, targetLamports: target, collateralLamports: 30_000_000n });
  const sig = await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(mine, bondIx), [wallet, mint]);
  console.log("ok   launch + bond in one tx:", sig);
  await sleep(3000);

  // ---- 3. site's curve reader agrees with the SDK ----
  const curveInfo = await connection.getAccountInfo(b.pdas.pumpCurve(mint.publicKey));
  const mineCurve = decodeCurve(new Uint8Array(curveInfo!.data));
  const sdkCurve = sdk.decodeBondingCurve(curveInfo!);
  assert.equal(mineCurve.virtualSolReserves.toString(), sdkCurve.virtualQuoteReserves.toString());
  assert.equal(mineCurve.virtualTokenReserves.toString(), sdkCurve.virtualTokenReserves.toString());
  assert.equal(new web3.PublicKey(mineCurve.creatorBytes).toBase58(), sdkCurve.creator.toBase58());
  assert.equal(mineCurve.complete, sdkCurve.complete);
  assert.isFalse(targetReached(mineCurve, target));
  console.log("ok   curve reader matches SDK; market cap", marketCapLamports(mineCurve).toString(), "< target", target.toString());

  // ---- 4. after the deadline: resolve through the site's builder ----
  console.log("     waiting 70s for the test deadline...");
  await sleep(70_000);
  const supplyBefore = (await splToken.getMint(connection, mint.publicKey, "confirmed", splToken.TOKEN_2022_PROGRAM_ID)).supply;
  const rsig = await b
    .resolveBuilder({ resolver: wallet.publicKey, mint: mint.publicKey, founder: wallet.publicKey, globalData: new Uint8Array(globalInfo!.data), creator: wallet.publicKey })
    .rpc();
  await sleep(3000);
  const supplyAfter = (await splToken.getMint(connection, mint.publicKey, "confirmed", splToken.TOKEN_2022_PROGRAM_ID)).supply;
  assert.isTrue(supplyBefore > supplyAfter);
  console.log("ok   resolve via site builder burned", (supplyBefore - supplyAfter).toString(), "raw tokens:", rsig);
  console.log("ok   bond status:", JSON.stringify((await (program.account as any).bond.fetch(b.pdas.bond(mint.publicKey))).status));
}
main().catch((e) => { console.error(e); process.exit(1); });
