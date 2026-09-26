// Devnet: runs the whole PHASE-1 custodial flow through site/custodial.js —
// launch (create_v2 + collateral transfer + memo in one tx), reading bonds
// back from the operator wallet, spoof resistance, operator return, and the
// operator burn (buy on pump.fun, then burn). Operator = the local deploy wallet.
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { GLOBAL_PDA } from "@pump-fun/pump-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert } from "chai";

const importEsm = new Function("p", "return import(p)") as (p: string) => Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (c: web3.Connection, ixs: web3.TransactionInstruction[], signers: web3.Keypair[]) =>
  web3.sendAndConfirmTransaction(c, new web3.Transaction().add(...ixs), signers);

async function main() {
  const site = (f: string) => importEsm("file://" + path.join(__dirname, "../site", f));
  const P = await site("pump.js");
  const C = await site("custodial.js");
  const connection = new web3.Connection(web3.clusterApiUrl("devnet"), "confirmed");
  const operator = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  assert.equal(operator.publicKey.toBase58(), C.OPERATORS.devnet);
  const pump = P.makeBuilders({ web3, splToken, program: { programId: web3.PublicKey.default }, BN });
  const cust = C.makeCustodial({
    web3, splToken, connection, operator: operator.publicKey.toBase58(), pump,
    decodeCurve: P.decodeCurve, targetReached: P.targetReached, marketCapLamports: P.marketCapLamports, bondSeconds: 60,
  });

  const founder = web3.Keypair.generate();
  const stranger = web3.Keypair.generate();
  await send(connection, [
    web3.SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: founder.publicKey, lamports: 1_200_000_000 }),
    web3.SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: stranger.publicKey, lamports: 50_000_000 }),
  ], [operator]);

  const g = await connection.getAccountInfo(GLOBAL_PDA);
  const dv = new DataView(g!.data.buffer, g!.data.byteOffset);
  const startMcap = (dv.getBigUint64(81, true) * dv.getBigUint64(97, true)) / dv.getBigUint64(73, true);
  const target = (startMcap * 160n) / 100n;
  const collateral = 30_000_000n;
  const globalData = new Uint8Array(g!.data);
  const cache = new Map<string, any>();
  const cacheApi = { get: (k: string) => cache.get(k), set: (k: string, v: any) => void cache.set(k, v) };

  async function launch(name: string) {
    const mint = web3.Keypair.generate();
    const ixs = cust.launchIxs({ founder: founder.publicKey.toBase58(), mint: mint.publicKey, name, symbol: "CST", uri: "https://example.com/m.json", target, collateral, nowUnix: Math.floor(Date.now() / 1000) });
    await send(connection, ixs, [founder, mint]);
    return mint.publicKey;
  }
  const A = await launch("Custodial A"); // will reach its target -> returned
  const B = await launch("Custodial B"); // will miss -> burned
  await sleep(4000);

  // ---- spoofs: must be ignored ----
  const fakeBond = C.encodeBondMemo({ mint: A.toBase58(), founder: stranger.publicKey.toBase58(), target: 1, collateral: 999_000_000, deadline: Math.floor(Date.now() / 1000) + 60 });
  await send(connection, [web3.SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: operator.publicKey, lamports: 1000 }), cust.memoIx(fakeBond, stranger.publicKey)], [stranger]);
  const fakeSettle = C.encodeSettleMemo({ mint: A.toBase58(), kind: "return" });
  await send(connection, [web3.SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: operator.publicKey, lamports: 1000 }), cust.memoIx(fakeSettle, stranger.publicKey)], [stranger]);
  await sleep(4000);

  let bonds = await cust.scan({ cache: cacheApi });
  const find = (m: web3.PublicKey) => bonds.find((b: any) => b.mint === m.toBase58());
  assert.equal(find(A)?.state, "locked");
  assert.equal(find(B)?.state, "locked");
  assert.equal(find(A)?.collateral.toString(), collateral.toString());
  assert.equal(find(A)?.founder, founder.publicKey.toBase58(), "spoofed bond memo hijacked the founder");
  console.log("ok   launch tx (create_v2 + transfer + memo) read back: both bonds 'locked', amounts verified");
  console.log("ok   spoofed bond memo and spoofed settle memo were ignored");

  // ---- A: reach the target on pump.fun, then the operator returns the collateral ----
  const pumpBuy = pump.buyIxs({ user: founder.publicKey, mint: A, creator: founder.publicKey, globalData, spendLamports: 700_000_000n, minTokensOut: 1n });
  await send(connection, pumpBuy, [founder]);
  await sleep(4000);
  bonds = await cust.scan({ cache: cacheApi });
  assert.equal(find(A)?.state, "reached");
  console.log("ok   target reached -> state 'reached'");
  const before = await connection.getBalance(founder.publicKey);
  await send(connection, cust.returnIxs({ mint: A, founder: founder.publicKey, collateral }), [operator]);
  await sleep(4000);
  assert.equal((await connection.getBalance(founder.publicKey)) - before, Number(collateral));
  bonds = await cust.scan({ cache: cacheApi });
  assert.equal(find(A)?.state, "claimed");
  console.log("ok   operator returned the collateral -> state 'claimed'");

  // ---- B: deadline passes unmet, the operator burns ----
  console.log("     waiting 65s for the test deadline...");
  await sleep(65_000);
  bonds = await cust.scan({ cache: cacheApi });
  assert.equal(find(B)?.state, "expired");
  const mintInfoBefore = await splToken.getMint(connection, B, "confirmed", splToken.TOKEN_2022_PROGRAM_ID);
  await send(connection, cust.burnBuyIxs({ mint: B, founder: founder.publicKey, collateral, globalData, minTokensOut: 1n }), [operator]);
  await sleep(4000);
  const held = (await splToken.getAccount(connection, pump.ata2022(B, operator.publicKey), "confirmed", splToken.TOKEN_2022_PROGRAM_ID)).amount;
  await send(connection, cust.burnIxs({ mint: B, amount: held }), [operator]);
  await sleep(4000);
  const mintInfoAfter = await splToken.getMint(connection, B, "confirmed", splToken.TOKEN_2022_PROGRAM_ID);
  assert.equal((mintInfoBefore.supply - mintInfoAfter.supply).toString(), held.toString());
  bonds = await cust.scan({ cache: cacheApi });
  assert.equal(find(B)?.state, "burned");
  console.log("ok   operator bought", held.toString(), "raw tokens with the collateral and burned them -> state 'burned'");
}
main().catch((e) => { console.error(e); process.exit(1); });
