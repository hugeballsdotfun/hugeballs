// Devnet: proves who may trigger a burn.
//  - a stranger is rejected (NotResolver)
//  - the resolver (admin) wallet can burn by hand
//  - scripts/keeper.ts, running with the keeper's own key, burns the other bond
// Needs the devnet-short-deadline build and a funded keeper key at
// ~/.config/balls/keeper-devnet.json.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import { GLOBAL_PDA } from "@pump-fun/pump-sdk";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert } from "chai";

const importEsm = new Function("p", "return import(p)") as (p: string) => Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const load = (p: string) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));

async function main() {
  const P = await importEsm("file://" + path.join(__dirname, "../site/pump.js"));
  const connection = new web3.Connection(web3.clusterApiUrl("devnet"), "confirmed");
  const admin = load(path.join(os.homedir(), ".config/solana/id.json"));
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const mk = (kp: web3.Keypair) => new Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" }));
  const b = P.makeBuilders({ web3, splToken, program: mk(admin), BN });
  const stranger = web3.Keypair.generate();
  await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: stranger.publicKey, lamports: 30_000_000 })), [admin]);

  const g = await connection.getAccountInfo(GLOBAL_PDA);
  const dv = new DataView(g!.data.buffer, g!.data.byteOffset);
  const startMcap = (dv.getBigUint64(81, true) * dv.getBigUint64(97, true)) / dv.getBigUint64(73, true);
  const target = (startMcap * 160n) / 100n;

  async function launch(name: string) {
    const mint = web3.Keypair.generate();
    const create = b.createV2Ix({ mint: mint.publicKey, name, symbol: "KPR", uri: "https://example.com/m.json", creator: admin.publicKey });
    const bond = await b.createBondIx({ founder: admin.publicKey, mint: mint.publicKey, targetLamports: target, collateralLamports: 30_000_000n });
    await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(create, bond), [admin, mint]);
    return mint.publicKey;
  }
  const A = await launch("Keeper Test A");
  const B = await launch("Keeper Test B");
  await sleep(3000);
  const status = async (m: web3.PublicKey) => Object.keys((await (mk(admin).account as any).bond.fetch(b.pdas.bond(m))).status)[0];

  const globalData = new Uint8Array(g!.data);
  const args = (m: web3.PublicKey, resolver: web3.PublicKey) => ({ resolver, mint: m, founder: admin.publicKey, globalData, creator: admin.publicKey });
  const strangerB = P.makeBuilders({ web3, splToken, program: mk(stranger), BN });
  try {
    await strangerB.resolveBuilder(args(A, stranger.publicKey)).rpc();
    assert.fail("stranger should have been rejected");
  } catch (e: any) {
    assert.include(String(e) + JSON.stringify(e.logs || ""), "NotResolver");
    console.log("ok   stranger rejected -> NotResolver");
  }

  console.log("     waiting 70s for the test deadline...");
  await sleep(70_000);

  await b.resolveBuilder(args(A, admin.publicKey)).rpc();
  await sleep(3000);
  assert.equal(await status(A), "burned");
  console.log("ok   admin (resolver) wallet burned bond A by hand");

  const out = execFileSync("npx", ["ts-node", "scripts/keeper.ts"], {
    env: { ...process.env, ONCE: "1", KEEPER_KEYPAIR: path.join(os.homedir(), ".config/balls/keeper-devnet.json") },
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
  console.log(out.split("\n").filter((l) => /RESOLVED|failed|past deadline|keeper/.test(l)).join("\n"));
  await sleep(3000);
  assert.equal(await status(B), "burned");
  console.log("ok   keeper (its own key) burned bond B");
}
main().catch((e) => { console.error(e); process.exit(1); });
