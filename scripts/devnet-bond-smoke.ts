// End-to-end devnet test of Balls bonds against the REAL pump.fun program.
//   MODE=claim  create coin+bond in one tx, buy past the target on pump.fun, claim.
//   MODE=burn   create coin+bond, wait out the (60s) test deadline, resolve:
//               the collateral buys the coin on pump.fun and the tokens burn.
// Requires the program built with `--features devnet-short-deadline`.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  OnlinePumpSdk,
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PumpSdk,
  bondingCurvePda,
  bondingCurveV2Pda,
  creatorVaultPda,
  getBuyTokenAmountFromSolAmount,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODE = process.env.MODE || "claim";

async function main() {
  const connection = new Connection(process.env.RPC_URL || clusterApiUrl("devnet"), "confirmed");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const program = new Program(idl, provider);
  const sdk = new PumpSdk();
  const online = new OnlinePumpSdk(connection);
  const global: any = await online.fetchGlobal();

  // ---- 1. launch on pump.fun + post the bond, in ONE transaction ----
  const mint = Keypair.generate();
  const curveAddr = bondingCurvePda(mint.publicKey);
  const [bond] = PublicKey.findProgramAddressSync([Buffer.from("bond"), mint.publicKey.toBuffer()], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), bond.toBuffer()], program.programId);

  const startMcap = (BigInt(global.initialVirtualSolReserves.toString()) * BigInt(global.tokenTotalSupply.toString())) /
    BigInt(global.initialVirtualTokenReserves.toString());
  const target = (startMcap * 160n) / 100n; // +60% over the start
  const collateral = 30_000_000n; // 0.03 SOL

  const createIx = await sdk.createV2Instruction({
    mint: mint.publicKey,
    name: "Balls Bond Smoke",
    symbol: "BBS",
    uri: "https://example.com/m.json",
    creator: wallet.publicKey,
    user: wallet.publicKey,
    mayhemMode: false,
  } as any);
  const bondIx = await program.methods
    .createBond(new BN(target.toString()), new BN(collateral.toString()))
    .accounts({
      founder: wallet.publicKey,
      mint: mint.publicKey,
      pumpCurve: curveAddr,
      bond,
      vault,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(createIx, bondIx), [wallet, mint]);
  console.log("pump create_v2 + create_bond:", sig);
  console.log("mint:", mint.publicKey.toBase58(), "| start mcap", startMcap.toString(), "target", target.toString());
  await sleep(3000);
  console.log("vault lamports:", await connection.getBalance(vault), "bond:", JSON.stringify((await (program.account as any).bond.fetch(bond)).status));

  if (MODE === "claim") {
    // ---- 2a. buy on pump.fun until the target is passed, then claim ----
    const st = await online.fetchBuyState(mint.publicKey, wallet.publicKey, TOKEN_2022_PROGRAM_ID);
    const feeConfig = await online.fetchFeeConfig();
    const solAmount = new BN(700_000_000); // 0.7 SOL is plenty to pass +60% on devnet's 1-SOL virtual reserve
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: st.bondingCurve,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    });
    const buyIxs = await sdk.buyInstructions({
      global,
      bondingCurveAccountInfo: st.bondingCurveAccountInfo,
      bondingCurve: st.bondingCurve,
      associatedUserAccountInfo: st.associatedUserAccountInfo,
      mint: mint.publicKey,
      user: wallet.publicKey,
      amount,
      solAmount,
      slippage: 10,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    console.log("pump buy:", await sendAndConfirmTransaction(connection, new Transaction().add(...buyIxs), [wallet]));
    await sleep(3000);

    const before = await connection.getBalance(wallet.publicKey);
    const claimSig = await program.methods
      .claimBond()
      .accounts({ founder: wallet.publicKey, bond, vault, pumpCurve: curveAddr, systemProgram: SystemProgram.programId } as any)
      .rpc();
    await sleep(3000);
    console.log("claim_bond:", claimSig);
    console.log("net lamports back to founder (~collateral - fee):", (await connection.getBalance(wallet.publicKey)) - before);
    console.log("status:", JSON.stringify((await (program.account as any).bond.fetch(bond)).status), "| vault:", await connection.getBalance(vault));
    return;
  }

  // ---- 2b. burn path: wait past the deadline, then resolve ----
  console.log("waiting 70s for the test deadline...");
  await sleep(70_000);

  const vaultAta = getAssociatedTokenAddressSync(mint.publicKey, vault, true, TOKEN_2022_PROGRAM_ID);
  const curveAta = getAssociatedTokenAddressSync(mint.publicKey, curveAddr, true, TOKEN_2022_PROGRAM_ID);
  const supplyBefore = (await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const founderBefore = await connection.getBalance(wallet.publicKey);

  const resolveSig = await program.methods
    .resolveBond(new BN(0))
    .accounts({
      resolver: wallet.publicKey,
      bond,
      vault,
      founder: wallet.publicKey,
      mint: mint.publicKey,
      vaultTokenAccount: vaultAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      pumpProgram: PUMP_PROGRAM_ID,
      pumpGlobal: GLOBAL_PDA,
      pumpFeeRecipient: global.feeRecipients[0],
      pumpCurve: curveAddr,
      pumpCurveTokenAccount: curveAta,
      pumpCreatorVault: creatorVaultPda(wallet.publicKey),
      pumpEventAuthority: PUMP_EVENT_AUTHORITY_PDA,
      pumpGlobalVolumeAccumulator: GLOBAL_VOLUME_ACCUMULATOR_PDA,
      pumpUserVolumeAccumulator: userVolumeAccumulatorPda(vault),
      pumpFeeConfig: PUMP_FEE_CONFIG_PDA,
      pumpFeeProgram: PUMP_FEE_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts([
      { pubkey: bondingCurveV2Pda(mint.publicKey), isWritable: false, isSigner: false },
      { pubkey: global.buybackFeeRecipients[0], isWritable: true, isSigner: false },
    ])
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, vaultAta, vault, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    ])
    .rpc();
  await sleep(3000);
  console.log("resolve_bond:", resolveSig);
  const supplyAfter = (await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  console.log("tokens burned:", (supplyBefore - supplyAfter).toString());
  console.log("vault token account balance:", (await getAccount(connection, vaultAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString());
  console.log("vault lamports:", await connection.getBalance(vault), "| founder delta:", (await connection.getBalance(wallet.publicKey)) - founderBefore);
  console.log("status:", JSON.stringify((await (program.account as any).bond.fetch(bond)).status));
}
main().catch((e) => { console.error(e); process.exit(1); });
