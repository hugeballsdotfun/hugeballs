// One-time: names the resolver (admin) and keeper wallets. Must be run by
// the program's UPGRADE AUTHORITY (the wallet that deployed it).
//   devnet : RESOLVER=<pubkey> KEEPER=<pubkey> npx ts-node scripts/init-config.ts
//   mainnet: CLUSTER=mainnet-beta RPC_URL=... KEYPAIR_PATH=<upgrade authority> RESOLVER=HE8Kh... KEEPER=<pubkey> ...
// Defaults: KEYPAIR_PATH=~/.config/solana/id.json, CLUSTER=devnet.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function main() {
  const cluster = (process.env.CLUSTER || "devnet") as "devnet" | "mainnet-beta";
  const connection = new Connection(process.env.RPC_URL || clusterApiUrl(cluster), "confirmed");
  const kp = process.env.KEYPAIR_PATH || path.join(os.homedir(), ".config/solana/id.json");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kp, "utf-8"))));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const program = new Program(idl, provider) as any;
  if (!process.env.RESOLVER || !process.env.KEEPER) throw new Error("Set RESOLVER and KEEPER (public keys).");
  const resolver = new PublicKey(process.env.RESOLVER);
  const keeper = new PublicKey(process.env.KEEPER);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  if (await connection.getAccountInfo(config)) {
    const c = await program.account.config.fetch(config);
    console.log("Config already initialized: resolver", c.resolver.toBase58(), "keeper", c.keeper.toBase58());
    return;
  }
  console.log("cluster:", cluster, "| upgrade authority:", authority.publicKey.toBase58());
  console.log("resolver (admin):", resolver.toBase58(), "| keeper:", keeper.toBase58());
  const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
  const sig = await program.methods.initConfig(resolver, keeper).accounts({ authority: authority.publicKey, programData }).rpc();
  console.log("init_config:", sig);
}
main().catch((e) => { console.error(e); process.exit(1); });
