// Negative-path checks against the real deployed program + real pump.fun on
// devnet. Every case must FAIL with the expected error (or, for the last
// positive checks, succeed). Requires the `devnet-short-deadline` build
// (deadline 60s, stuck-grace 120s).
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  GLOBAL_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, OnlinePumpSdk, PUMP_EVENT_AUTHORITY_PDA, PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, PumpSdk, bondingCurvePda, bondingCurveV2Pda, creatorVaultPda,
  getBuyTokenAmountFromSolAmount, userVolumeAccumulatorPda,
} from "@pump-fun/pump-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name: string) { passed++; console.log("  ok  ", name); }

async function main() {
  const connection = new Connection(process.env.RPC_URL || clusterApiUrl("devnet"), "confirmed");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/balls_bond.json"), "utf-8"));
  const program = new Program(idl, provider) as any;
  const sdk = new PumpSdk();
  const online = new OnlinePumpSdk(connection);
  const global: any = await online.fetchGlobal();
  const startMcap = (BigInt(global.initialVirtualSolReserves.toString()) * BigInt(global.tokenTotalSupply.toString())) / BigInt(global.initialVirtualTokenReserves.toString());
  const target = (startMcap * 160n) / 100n;
  const COLLATERAL = 30_000_000n;

  const pdas = (mint: PublicKey) => {
    const [bond] = PublicKey.findProgramAddressSync([Buffer.from("bond"), mint.toBuffer()], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), bond.toBuffer()], program.programId);
    return { bond, vault, curve: bondingCurvePda(mint) };
  };
  async function expectErr(p: Promise<unknown>, needle: string, label: string) {
    try { await p; } catch (e: any) {
      const text = String(e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? "");
      if (text.includes(needle)) return ok(`${label} -> ${needle}`);
      throw new Error(`${label}: expected ${needle}, got: ${text.slice(0, 600)}`);
    }
    throw new Error(`${label}: expected failure ${needle}, but it succeeded`);
  }
  async function launch(name: string, withBond = true, creatorKp: Keypair = wallet) {
    const mint = Keypair.generate();
    const p = pdas(mint.publicKey);
    const createIx = await sdk.createV2Instruction({ mint: mint.publicKey, name, symbol: "BNEG", uri: "https://example.com/m.json", creator: creatorKp.publicKey, user: creatorKp.publicKey, mayhemMode: false } as any);
    const tx = new Transaction().add(createIx);
    if (withBond) tx.add(await createBondIx(mint.publicKey, creatorKp.publicKey, p, target));
    await sendAndConfirmTransaction(connection, tx, creatorKp === wallet ? [wallet, mint] : [creatorKp, mint]);
    await sleep(2500);
    return { mint: mint.publicKey, ...p };
  }
  const createBondIx = (mint: PublicKey, founder: PublicKey, p: any, tgt: bigint, collateral = COLLATERAL) =>
    program.methods.createBond(new BN(tgt.toString()), new BN(collateral.toString()))
      .accounts({ founder, mint, pumpCurve: p.curve, bond: p.bond, vault: p.vault, systemProgram: SystemProgram.programId }).instruction();
  const claimIx = (founder: PublicKey, c: any) =>
    program.methods.claimBond().accounts({ founder, bond: c.bond, vault: c.vault, pumpCurve: c.curve, systemProgram: SystemProgram.programId });
  const resolveBuilder = (c: any, over: any = {}) => {
    const vaultAta = getAssociatedTokenAddressSync(c.mint, c.vault, true, TOKEN_2022_PROGRAM_ID);
    return program.methods.resolveBond(new BN(0)).accounts({
      resolver: wallet.publicKey, bond: c.bond, vault: c.vault, founder: wallet.publicKey, mint: c.mint,
      vaultTokenAccount: vaultAta, tokenProgram: TOKEN_2022_PROGRAM_ID, pumpProgram: PUMP_PROGRAM_ID, pumpGlobal: GLOBAL_PDA,
      pumpFeeRecipient: global.feeRecipients[0], pumpCurve: c.curve,
      pumpCurveTokenAccount: getAssociatedTokenAddressSync(c.mint, c.curve, true, TOKEN_2022_PROGRAM_ID),
      pumpCreatorVault: creatorVaultPda(wallet.publicKey), pumpEventAuthority: PUMP_EVENT_AUTHORITY_PDA,
      pumpGlobalVolumeAccumulator: GLOBAL_VOLUME_ACCUMULATOR_PDA, pumpUserVolumeAccumulator: userVolumeAccumulatorPda(c.vault),
      pumpFeeConfig: PUMP_FEE_CONFIG_PDA, pumpFeeProgram: PUMP_FEE_PROGRAM_ID, systemProgram: SystemProgram.programId, ...over,
    }).remainingAccounts([
      { pubkey: bondingCurveV2Pda(c.mint), isWritable: false, isSigner: false },
      { pubkey: global.buybackFeeRecipients[0], isWritable: true, isSigner: false },
    ]).preInstructions([createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, vaultAta, c.vault, c.mint, TOKEN_2022_PROGRAM_ID)]);
  };
  async function buyPast(mint: PublicKey) {
    const st = await online.fetchBuyState(mint, wallet.publicKey, TOKEN_2022_PROGRAM_ID);
    const solAmount = new BN(700_000_000);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig: await online.fetchFeeConfig(), mintSupply: null, bondingCurve: st.bondingCurve, amount: solAmount, quoteMint: NATIVE_MINT });
    const ixs = await sdk.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: wallet.publicKey, amount, solAmount, slippage: 10, tokenProgram: TOKEN_2022_PROGRAM_ID });
    await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [wallet]);
    await sleep(2500);
  }

  // ---------- create_bond guards ----------
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger.publicKey, lamports: 60_000_000 })), [wallet]);
  const coinA = await launch("Neg A", false); // a coin with NO bond yet, creator = wallet
  await expectErr(
    program.methods.createBond(new BN(target.toString()), new BN(COLLATERAL.toString())).accounts({ founder: stranger.publicKey, mint: coinA.mint, pumpCurve: coinA.curve, bond: coinA.bond, vault: coinA.vault, systemProgram: SystemProgram.programId }).signers([stranger]).rpc(),
    "NotCoinCreator", "create_bond by someone who is not the pump.fun creator");
  await expectErr(createBondIx(coinA.mint, wallet.publicKey, coinA, startMcap).then((ix: any) => sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet])),
    "TargetTooLow", "create_bond with target <= current mcap");
  await expectErr(createBondIx(coinA.mint, wallet.publicKey, coinA, target, 1_000_000n).then((ix: any) => sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet])),
    "CollateralTooLow", "create_bond below minimum collateral");
  const fakeCurve = Keypair.generate().publicKey;
  await expectErr(program.methods.createBond(new BN(target.toString()), new BN(COLLATERAL.toString())).accounts({ founder: wallet.publicKey, mint: coinA.mint, pumpCurve: fakeCurve, bond: coinA.bond, vault: coinA.vault, systemProgram: SystemProgram.programId }).rpc(),
    "InvalidPumpCurve", "create_bond with a curve account that isn't pump.fun's");
  await expectErr(program.methods.createBond(new BN(target.toString()), new BN(COLLATERAL.toString())).accounts({ founder: wallet.publicKey, mint: coinA.mint, pumpCurve: coinA.bond /* wrong program owner */, bond: coinA.bond, vault: coinA.vault, systemProgram: SystemProgram.programId }).rpc(),
    "InvalidPumpCurve", "create_bond passing a non-pump account as the curve");

  // ---------- claim / resolve guards on an untouched, bonded coin ----------
  const coinB = await launch("Neg B");
  await expectErr(claimIx(wallet.publicKey, coinB).rpc(), "TargetNotReached", "claim before the target is reached");
  await expectErr(claimIx(stranger.publicKey, coinB).signers([stranger]).rpc(), "NotFounder", "claim by a non-founder");
  await expectErr(resolveBuilder(coinB).rpc(), "NotExpired", "resolve before the deadline");
  await expectErr(program.methods.refundStuck().accounts({ founder: wallet.publicKey, bond: coinB.bond, vault: coinB.vault, systemProgram: SystemProgram.programId }).rpc(),
    "GraceNotElapsed", "refund_stuck before the grace period");
  console.log("  ...waiting 65s for the test deadline");
  await sleep(65_000);
  // A REAL token account for this mint — just not the vault's (it's the founder's own).
  const wrongAta = getAssociatedTokenAddressSync(coinB.mint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
  await expectErr(
    resolveBuilder(coinB, { vaultTokenAccount: wrongAta })
      .preInstructions([createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wrongAta, wallet.publicKey, coinB.mint, TOKEN_2022_PROGRAM_ID)])
      .rpc(),
    "ConstraintTokenOwner", "resolve with a token account the vault does not own");
  await expectErr(resolveBuilder(coinB, { pumpCurve: fakeCurve }).rpc(), "InvalidPumpCurve", "resolve with a fake curve");
  await expectErr(resolveBuilder(coinB, { pumpProgram: SystemProgram.programId }).rpc(), "ConstraintAddress", "resolve with a fake pump program");

  // ---------- reached bond can never be burned, even after the deadline ----------
  const coinC = await launch("Neg C");
  await buyPast(coinC.mint);
  console.log("  ...waiting 65s (reached-but-expired case)");
  await sleep(65_000);
  await expectErr(resolveBuilder(coinC).rpc(), "TargetReached", "resolve on an expired bond whose target IS met");
  await claimIx(wallet.publicKey, coinC).rpc();
  ok("founder can still claim a reached bond after the deadline");
  await expectErr(claimIx(wallet.publicKey, coinC).rpc(), "BondNotActive", "claim twice");

  // ---------- stuck refund after the grace period ----------
  console.log("  ...waiting for the stuck-grace window on coin B (deadline+120s)");
  await sleep(60_000);
  await program.methods.refundStuck().accounts({ founder: wallet.publicKey, bond: coinB.bond, vault: coinB.vault, systemProgram: SystemProgram.programId }).rpc();
  ok("refund_stuck succeeds after the grace period");
  await expectErr(resolveBuilder(coinB).rpc(), "BondNotActive", "resolve on an already-refunded bond");

  console.log(`\nAll ${passed} negative/guard checks behaved as expected.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
