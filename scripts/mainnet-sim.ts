// READ-ONLY mainnet check: nothing is sent, nothing is spent. Builds the exact
// instructions the site uses (create_v2 + a buy + a burn) with the site's own
// builders and runs them through `simulateTransaction` against the REAL
// mainnet pump.fun program, using a rich existing account as a stand-in payer
// with signature verification off. Also cross-checks the site's Global offsets
// against pump.fun's SDK on mainnet data.
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { OnlinePumpSdk, GLOBAL_PDA } from "@pump-fun/pump-sdk";
import * as path from "path";
import { assert } from "chai";

const importEsm = new Function("p", "return import(p)") as (p: string) => Promise<any>;

async function main() {
  const P = await importEsm("file://" + path.join(__dirname, "../site/pump.js"));
  const C = await importEsm("file://" + path.join(__dirname, "../site/custodial.js"));
  const connection = new web3.Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const sdk = new OnlinePumpSdk(connection);
  const g: any = await sdk.fetchGlobal();
  const info = await connection.getAccountInfo(GLOBAL_PDA);
  const data = new Uint8Array(info!.data);

  // ---- offsets vs the SDK's decode ----
  const dv = new DataView(data.buffer, data.byteOffset);
  assert.equal(dv.getBigUint64(73, true).toString(), g.initialVirtualTokenReserves.toString());
  assert.equal(dv.getBigUint64(81, true).toString(), g.initialVirtualSolReserves.toString());
  assert.equal(dv.getBigUint64(97, true).toString(), g.tokenTotalSupply.toString());
  assert.equal(new web3.PublicKey(data.slice(162, 194)).toBase58(), g.feeRecipients[0].toBase58());
  assert.equal(new web3.PublicKey(data.slice(741, 773)).toBase58(), g.buybackFeeRecipients[0].toBase58());
  const startMcap = (dv.getBigUint64(81, true) * dv.getBigUint64(97, true)) / dv.getBigUint64(73, true);
  console.log("ok   Global offsets match the SDK on mainnet; a new coin starts at", Number(startMcap) / 1e9, "SOL market cap; createV2Enabled =", g.createV2Enabled);

  // ---- simulate: create_v2 + buy 0.05 SOL + burn 1 token + collateral transfer + memo ----
  const payerKey = new web3.PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"); // any funded system account (pump fee recipients trip a rent check in simulation); nothing is signed or sent
  const payerInfo = await connection.getAccountInfo(payerKey);
  console.log("     stand-in payer", payerKey.toBase58(), "owner", payerInfo?.owner.toBase58(), "SOL", (payerInfo?.lamports || 0) / 1e9);
  const pump = P.makeBuilders({ web3, splToken, program: { programId: web3.PublicKey.default }, BN });
  const cust = C.makeCustodial({ web3, splToken, connection, operator: C.OPERATORS.mainnet, pump, decodeCurve: P.decodeCurve, targetReached: P.targetReached, marketCapLamports: P.marketCapLamports });
  const mint = web3.Keypair.generate().publicKey;
  const launch = cust.launchIxs({ founder: payerKey.toBase58(), mint, name: "Sim Coin", symbol: "SIM", uri: "https://gateway.irys.xyz/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg", target: startMcap * 3n, collateral: 20_000_000n, nowUnix: Math.floor(Date.now() / 1000) });
  const buy = pump.buyIxs({ user: payerKey, mint, creator: payerKey, globalData: data, spendLamports: 50_000_000n, minTokensOut: 1n });
  const burn = splToken.createBurnInstruction(pump.ata2022(mint, payerKey), mint, payerKey, 1n, [], splToken.TOKEN_2022_PROGRAM_ID);
  const { blockhash } = await connection.getLatestBlockhash();
  async function simulate(label: string, ixs: web3.TransactionInstruction[]) {
    const msg = new web3.TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const res = await connection.simulateTransaction(new web3.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const logs = res.value.logs || [];
    if (res.value.err) {
      console.log("account_index -> key:", JSON.stringify(res.value.err), msg.staticAccountKeys.slice(0, 4).map((k: any, i: number) => i + ":" + k.toBase58()).join(" "));
      console.log(logs.slice(-6).join("\n"));
      throw new Error(label + " simulation failed: " + JSON.stringify(res.value.err));
    }
    console.log(`ok   mainnet simulation: ${label} (compute units ${res.value.unitsConsumed})`);
    return logs;
  }
  // 1) the real launch transaction: create_v2 + collateral transfer + bond memo
  const launchLogs = await simulate("launch = create_v2 + collateral transfer + bond memo", launch);
  console.log("     ", launchLogs.filter((l) => /Memo|Instruction: (CreateV2|Create)/.test(l)).join(" | "));
  // 2) the operator's burn path, on a coin created in the same simulated tx:
  //    create_v2 -> buy_exact_sol_in -> burn (amount 1 raw token)
  const create = launch[0];
  const buyLogs = await simulate("create_v2 + buy_exact_sol_in + burn", [create, ...buy, burn]);
  console.log("     ", buyLogs.filter((l) => /Instruction: (BuyExactSolIn|Burn)/.test(l)).join(" | "));
}
main().catch((e) => { console.error(e); process.exit(1); });
