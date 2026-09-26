// Everything that touches pump.fun's program, as a pure module: it takes the
// web3/spl-token/anchor instances it should use instead of importing them,
// so the exact same code runs in the browser (esm.sh copies) and in the Node
// verification script (scripts/verify-site-builders.ts), which checks it
// byte-for-byte against pump.fun's own SDK and then runs a full
// launch -> bond -> burn on devnet through it.
//
// pump.fun's public IDL: github.com/pump-fun/pump-public-docs (idl/pump.json).

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const MAYHEM_PROGRAM = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e";
// Fixed PDAs (derivations in pump.fun's SDK/IDL; verified against it).
const PUMP_GLOBAL = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";
const PUMP_EVENT_AUTHORITY = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";
const PUMP_GLOBAL_VOLUME_ACCUMULATOR = "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y";
const PUMP_FEE_CONFIG = "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt";
const MAYHEM_GLOBAL_PARAMS = "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ";
const MAYHEM_SOL_VAULT = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s";

const CREATE_V2_DISCRIMINATOR = [214, 144, 76, 236, 95, 139, 49, 180];
const BUY_EXACT_SOL_IN_DISCRIMINATOR = [56, 252, 116, 8, 158, 223, 205, 95];
const SELL_DISCRIMINATOR = [51, 230, 133, 164, 1, 127, 131, 173];
const CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];

// Byte offsets into pump.fun account data (8-byte discriminator first).
// BondingCurve: vt@8 vs@16 real_tok@24 real_sol@32 supply@40 complete@48 creator@49.
// Global: fee_recipients[7] @162, buyback_fee_recipients[8] @741.
const GLOBAL_FEE_RECIPIENTS_OFFSET = 162;
const GLOBAL_BUYBACK_RECIPIENTS_OFFSET = 741;

// Node has a global Buffer; browsers don't. web3.js accepts plain bytes for
// instruction data, so only wrap in a Buffer where one exists (the Node scripts).
const asData = (bytes) => (typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes);

const te = new TextEncoder();
const u32 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const borshString = (s) => {
  const b = te.encode(s);
  return concat(u32(b.length), b);
};
const u64le = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};
const readU64 = (data, o) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(o, true);

// ---- pure readers (no web3 needed) ----
export function decodeCurve(data) {
  if (!data || data.length < 81) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== CURVE_DISCRIMINATOR[i]) return null;
  return {
    virtualTokenReserves: readU64(data, 8),
    virtualSolReserves: readU64(data, 16),
    totalSupply: readU64(data, 40),
    complete: data[48] !== 0,
    creatorBytes: data.slice(49, 81),
  };
}
// Market cap in lamports — same formula as the program (pump.rs).
export function marketCapLamports(curve) {
  if (!curve || curve.virtualTokenReserves === 0n) return 0n;
  return (curve.virtualSolReserves * curve.totalSupply) / curve.virtualTokenReserves;
}
export function targetReached(curve, targetLamports) {
  return curve.complete || marketCapLamports(curve) >= BigInt(targetLamports);
}

// ---- trade estimates (constant product over the virtual reserves) ----
// pump.fun charges protocol + creator fees that vary by market-cap tier, so
// estimates assume up to FEE_MARGIN_BPS and the caller's slippage on top.
// They only feed the on-chain min-output guard and the preview number.
const FEE_MARGIN_BPS = 300n;
export function estimateBuyTokens(curve, spendLamports) {
  const spend = BigInt(spendLamports);
  const net = (spend * (10000n - FEE_MARGIN_BPS)) / 10000n;
  const vs = curve.virtualSolReserves;
  const vt = curve.virtualTokenReserves;
  const newVt = (vs * vt) / (vs + net);
  return vt > newVt ? vt - newVt : 0n;
}
export function estimateSellLamports(curve, tokenAmount) {
  const amt = BigInt(tokenAmount);
  const vs = curve.virtualSolReserves;
  const vt = curve.virtualTokenReserves;
  const newVs = (vs * vt) / (vt + amt) + 1n;
  const gross = vs > newVs ? vs - newVs : 0n;
  return (gross * (10000n - FEE_MARGIN_BPS)) / 10000n;
}
// A safe on-chain minimum: the estimate minus the user's slippage tolerance.
export const applySlippage = (amount, slippageBps) => (BigInt(amount) * (10000n - BigInt(slippageBps))) / 10000n;

export function makeBuilders({ web3, splToken, program, BN }) {
  const { PublicKey, TransactionInstruction, SystemProgram } = web3;
  const {
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
  } = splToken;
  const pk = (s) => new PublicKey(s);
  const PUMP = pk(PUMP_PROGRAM);
  const balls = program.programId;
  const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];

  const pdas = {
    pumpCurve: (mint) => pda([te.encode("bonding-curve"), new PublicKey(mint).toBytes()], PUMP),
    creatorVault: (creator) => pda([te.encode("creator-vault"), new PublicKey(creator).toBytes()], PUMP),
    userVolumeAccumulator: (user) => pda([te.encode("user_volume_accumulator"), new PublicKey(user).toBytes()], PUMP),
    curveV2: (mint) => pda([te.encode("bonding-curve-v2"), new PublicKey(mint).toBytes()], PUMP),
    config: () => pda([te.encode("config")], balls),
    bond: (mint) => pda([te.encode("bond"), new PublicKey(mint).toBytes()], balls),
    vault: (bond) => pda([te.encode("vault"), new PublicKey(bond).toBytes()], balls),
  };
  const ata2022 = (mint, owner) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID);

  // pump.fun `create_v2`, SOL-quoted, no mayhem/cashback/holder-reward.
  function createV2Ix({ mint, name, symbol, uri, creator }) {
    mint = new PublicKey(mint);
    creator = new PublicKey(creator);
    const curve = pdas.pumpCurve(mint);
    const mayhemState = pda([te.encode("mayhem-state"), mint.toBytes()], pk(MAYHEM_PROGRAM));
    const data = concat(
      Uint8Array.from(CREATE_V2_DISCRIMINATOR),
      borshString(name),
      borshString(symbol),
      borshString(uri),
      creator.toBytes(),
      Uint8Array.of(0), // is_mayhem_mode
      Uint8Array.of(0), // is_cashback_enabled  (OptionBool encodes as a bare bool)
      u64le(0), //          creator_fee_bps        (OptionU64 encodes as a bare u64)
      Uint8Array.of(0) //   is_holder_reward
    );
    const m = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
    return new TransactionInstruction({
      programId: PUMP,
      data: asData(data),
      keys: [
        m(mint, true, true),
        m(pda([te.encode("mint-authority")], PUMP), false, false),
        m(curve, false, true),
        m(ata2022(mint, curve), false, true),
        m(pk(PUMP_GLOBAL), false, false),
        m(creator, true, true),
        m(SystemProgram.programId, false, false),
        m(TOKEN_2022_PROGRAM_ID, false, false),
        m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
        m(pk(MAYHEM_PROGRAM), false, true),
        m(pk(MAYHEM_GLOBAL_PARAMS), false, false),
        m(pk(MAYHEM_SOL_VAULT), false, true),
        m(mayhemState, false, true),
        m(ata2022(mint, pk(MAYHEM_SOL_VAULT)), false, true),
        m(pk(PUMP_EVENT_AUTHORITY), false, false),
        m(PUMP, false, false),
      ],
    });
  }

  // Balls `create_bond` — rides in the same tx right after create_v2.
  async function createBondIx({ founder, mint, targetLamports, collateralLamports }) {
    mint = new PublicKey(mint);
    const bond = pdas.bond(mint);
    return program.methods
      .createBond(new BN(String(targetLamports)), new BN(String(collateralLamports)))
      .accounts({
        founder: new PublicKey(founder),
        mint,
        pumpCurve: pdas.pumpCurve(mint),
        bond,
        vault: pdas.vault(bond),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  function claimBuilder({ founder, mint }) {
    mint = new PublicKey(mint);
    const bond = pdas.bond(mint);
    return program.methods.claimBond().accounts({
      founder: new PublicKey(founder),
      bond,
      vault: pdas.vault(bond),
      pumpCurve: pdas.pumpCurve(mint),
      systemProgram: SystemProgram.programId,
    });
  }

  // Balls `resolve_bond`. `globalData` is the raw pump.fun Global account
  // (fetched by the caller) — the fee recipients live in it and rotate.
  function resolveBuilder({ resolver, mint, founder, globalData, creator, minTokensOut = 0 }) {
    mint = new PublicKey(mint);
    const bond = pdas.bond(mint);
    const vault = pdas.vault(bond);
    const curve = pdas.pumpCurve(mint);
    const vaultAta = ata2022(mint, vault);
    const firstNonZero = (offset, count) => {
      for (let i = 0; i < count; i++) {
        const k = new PublicKey(globalData.slice(offset + i * 32, offset + (i + 1) * 32));
        if (!k.equals(PublicKey.default)) return k;
      }
      throw new Error("pump.fun Global has no usable fee recipient");
    };
    const feeRecipient = firstNonZero(GLOBAL_FEE_RECIPIENTS_OFFSET, 7);
    const buybackFeeRecipient = firstNonZero(GLOBAL_BUYBACK_RECIPIENTS_OFFSET, 8);
    return program.methods
      .resolveBond(new BN(String(minTokensOut)))
      .accounts({
        resolver: new PublicKey(resolver),
        config: pdas.config(),
        bond,
        vault,
        founder: new PublicKey(founder),
        mint,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        pumpProgram: PUMP,
        pumpGlobal: pk(PUMP_GLOBAL),
        pumpFeeRecipient: feeRecipient,
        pumpCurve: curve,
        pumpCurveTokenAccount: ata2022(mint, curve),
        pumpCreatorVault: pdas.creatorVault(creator),
        pumpEventAuthority: pk(PUMP_EVENT_AUTHORITY),
        pumpGlobalVolumeAccumulator: pk(PUMP_GLOBAL_VOLUME_ACCUMULATOR),
        pumpUserVolumeAccumulator: pdas.userVolumeAccumulator(vault),
        pumpFeeConfig: pk(PUMP_FEE_CONFIG),
        pumpFeeProgram: pk(PUMP_FEE_PROGRAM),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: pdas.curveV2(mint), isWritable: false, isSigner: false },
        { pubkey: buybackFeeRecipient, isWritable: true, isSigner: false },
      ])
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(new PublicKey(resolver), vaultAta, vault, mint, TOKEN_2022_PROGRAM_ID),
      ]);
  }

  const pickRecipient = (globalData, offset, count) => {
    for (let i = 0; i < count; i++) {
      const k = new PublicKey(globalData.slice(offset + i * 32, offset + (i + 1) * 32));
      if (!k.equals(PublicKey.default)) return k;
    }
    throw new Error("pump.fun Global has no usable fee recipient");
  };

  // Shared account plumbing for user buy/sell on pump.fun.
  function tradeAccounts({ user, mint, creator, globalData }) {
    mint = new PublicKey(mint);
    user = new PublicKey(user);
    const curve = pdas.pumpCurve(mint);
    return {
      mint,
      user,
      curve,
      curveAta: ata2022(mint, curve),
      userAta: ata2022(mint, user),
      creatorVault: pdas.creatorVault(creator),
      feeRecipient: pickRecipient(globalData, GLOBAL_FEE_RECIPIENTS_OFFSET, 7),
      buybackFeeRecipient: pickRecipient(globalData, GLOBAL_BUYBACK_RECIPIENTS_OFFSET, 8),
    };
  }
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  const trailing = (a) => [meta(pdas.curveV2(a.mint), false, false), meta(a.buybackFeeRecipient, false, true)];

  // Buy by SOL amount: pump.fun `buy_exact_sol_in` (spends exactly
  // `spendLamports`, fees included; fails if fewer than minTokensOut come back).
  // Includes creating the user's token account if needed.
  function buyIxs({ user, mint, creator, globalData, spendLamports, minTokensOut }) {
    const a = tradeAccounts({ user, mint, creator, globalData });
    const data = concat(Uint8Array.from(BUY_EXACT_SOL_IN_DISCRIMINATOR), u64le(spendLamports), u64le(minTokensOut), Uint8Array.of(0));
    return [
      createAssociatedTokenAccountIdempotentInstruction(a.user, a.userAta, a.user, a.mint, TOKEN_2022_PROGRAM_ID),
      new TransactionInstruction({
        programId: PUMP,
        data: asData(data),
        keys: [
          meta(pk(PUMP_GLOBAL), false, false),
          meta(a.feeRecipient, false, true),
          meta(a.mint, false, false),
          meta(a.curve, false, true),
          meta(a.curveAta, false, true),
          meta(a.userAta, false, true),
          meta(a.user, true, true),
          meta(SystemProgram.programId, false, false),
          meta(TOKEN_2022_PROGRAM_ID, false, false),
          meta(a.creatorVault, false, true),
          meta(pk(PUMP_EVENT_AUTHORITY), false, false),
          meta(PUMP, false, false),
          meta(pk(PUMP_GLOBAL_VOLUME_ACCUMULATOR), false, false),
          meta(pdas.userVolumeAccumulator(a.user), false, true),
          meta(pk(PUMP_FEE_CONFIG), false, false),
          meta(pk(PUMP_FEE_PROGRAM), false, false),
          ...trailing(a),
        ],
      }),
    ];
  }

  // Sell `tokenAmount` raw tokens: pump.fun `sell`.
  function sellIx({ user, mint, creator, globalData, tokenAmount, minSolOut }) {
    const a = tradeAccounts({ user, mint, creator, globalData });
    const data = concat(Uint8Array.from(SELL_DISCRIMINATOR), u64le(tokenAmount), u64le(minSolOut));
    return new TransactionInstruction({
      programId: PUMP,
      data: asData(data),
      keys: [
        meta(pk(PUMP_GLOBAL), false, false),
        meta(a.feeRecipient, false, true),
        meta(a.mint, false, false),
        meta(a.curve, false, true),
        meta(a.curveAta, false, true),
        meta(a.userAta, false, true),
        meta(a.user, true, true),
        meta(SystemProgram.programId, false, false),
        meta(a.creatorVault, false, true),
        meta(TOKEN_2022_PROGRAM_ID, false, false),
        meta(pk(PUMP_EVENT_AUTHORITY), false, false),
        meta(PUMP, false, false),
        meta(pk(PUMP_FEE_CONFIG), false, false),
        meta(pk(PUMP_FEE_PROGRAM), false, false),
        ...trailing(a),
      ],
    });
  }

  return { PUMP_PROGRAM, pdas, createV2Ix, createBondIx, claimBuilder, resolveBuilder, buyIxs, sellIx, ata2022 };
}
