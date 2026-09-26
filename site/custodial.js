// PHASE 1 — custodial bonds (no escrow contract).
//
// The founder's collateral goes to the Balls operator wallet in the SAME
// transaction that creates the coin on pump.fun, together with a public
// memo describing the bond. There is no bond account: everything is read back
// from the operator wallet's on-chain history, and anything unverifiable is
// ignored. The operator then settles each bond with its own wallet:
//   - target reached  -> sends the collateral back to the founder
//   - deadline missed -> buys the coin on pump.fun with the collateral and burns it
// each settlement carrying its own memo, so anyone can audit what happened.
//
// This is a TRUST model, not a trustless one: the operator holds the funds.
// (Phase 2 = the escrow program in programs/balls-bond, already built.)
//
// Pure module like pump.js: web3/spl-token/connection are injected, so the
// same code runs in the browser and in scripts/verify-custodial.ts.

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const OPERATORS = {
  mainnet: "HE8Khn19yPTzFZTLcoZLZqRV1AWypnUJ4L4NoYLS66uw",
  // devnet testing uses the local deploy wallet (its key lives on the dev machine)
  devnet: "7JUxE51uruqe8TbzgmNuVYMn8UBu4DViewzCD6qJeoeK",
};
export const BOND_SECONDS = 48 * 60 * 60;
export const MIN_COLLATERAL_LAMPORTS = 10_000_000n; // 0.01 SOL
const BOND_PREFIX = "balls:bond:";
const SETTLE_PREFIX = "balls:settle:";
const DEADLINE_TOLERANCE_SECS = 300;

// Compact keys keep the memo well under the ~566-byte limit.
export const encodeBondMemo = ({ mint, founder, target, collateral, deadline }) =>
  BOND_PREFIX + JSON.stringify({ m: mint, f: founder, t: String(target), c: String(collateral), d: Number(deadline) });
export const encodeSettleMemo = ({ mint, kind }) => SETTLE_PREFIX + JSON.stringify({ m: mint, k: kind });

function parseMemoText(memoField) {
  // getSignaturesForAddress returns memo as "[<len>] <text>", joined by "; " when several.
  if (!memoField) return [];
  return memoField.split("; ").map((p) => p.replace(/^\[\d+\]\s/, ""));
}
function tryParse(text, prefix) {
  if (!text.startsWith(prefix)) return null;
  try {
    return JSON.parse(text.slice(prefix.length));
  } catch {
    return null;
  }
}

export function makeCustodial({ web3, splToken, connection, operator, pump, decodeCurve, targetReached, marketCapLamports, bondSeconds = BOND_SECONDS }) {
  const { PublicKey, TransactionInstruction, SystemProgram } = web3;
  const op = new PublicKey(operator);

  const memoIx = (text, signer) =>
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM),
      keys: [{ pubkey: new PublicKey(signer), isSigner: true, isWritable: false }],
      data: typeof Buffer !== "undefined" ? Buffer.from(text, "utf-8") : new TextEncoder().encode(text),
    });

  // create_v2 + collateral transfer to the operator + bond memo, one transaction.
  function launchIxs({ founder, mint, name, symbol, uri, target, collateral, nowUnix }) {
    const deadline = nowUnix + bondSeconds;
    return [
      pump.createV2Ix({ mint, name, symbol, uri, creator: founder }),
      SystemProgram.transfer({ fromPubkey: new PublicKey(founder), toPubkey: op, lamports: BigInt(collateral) }),
      memoIx(encodeBondMemo({ mint: String(mint), founder: String(founder), target, collateral, deadline }), founder),
    ];
  }

  // ---- reading + verifying bonds from the operator wallet's history ----
  // `cache` (optional, {get(key), set(key, value)}) stores verdicts by signature;
  // a confirmed transaction never changes, so they're safe to keep forever.
  async function verifiedTx(signature, cache) {
    const hit = cache?.get(signature);
    if (hit !== undefined && hit !== null) return hit;
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const slim = tx && !tx.meta?.err
      ? {
          blockTime: tx.blockTime,
          signers: tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()),
          transfers: tx.transaction.message.instructions
            .filter((i) => i.program === "system" && i.parsed?.type === "transfer")
            .map((i) => ({ from: i.parsed.info.source, to: i.parsed.info.destination, lamports: String(i.parsed.info.lamports) })),
          pumpCreateMints: tx.transaction.message.instructions
            .filter((i) => i.programId?.toBase58?.() === pump.PUMP_PROGRAM && i.accounts?.length)
            .map((i) => i.accounts[0].toBase58()),
        }
      : { failed: true };
    cache?.set(signature, slim);
    return slim;
  }

  // Reads the operator wallet's history newest-first, page by page (1000 per
  // RPC call), so the list keeps working as the wallet's history grows.
  async function allSignatures(maxPages) {
    const out = [];
    let before;
    for (let page = 0; page < maxPages; page++) {
      const batch = await connection.getSignaturesForAddress(op, { limit: 1000, before }, "confirmed");
      out.push(...batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    return out;
  }

  async function scan({ cache, maxPages = 5 } = {}) {
    const sigs = await allSignatures(maxPages);
    const bondCandidates = [];
    const settleCandidates = [];
    for (const s of sigs) {
      if (s.err) continue;
      for (const text of parseMemoText(s.memo)) {
        const b = tryParse(text, BOND_PREFIX);
        if (b?.m && b?.f) bondCandidates.push({ sig: s.signature, blockTime: s.blockTime, b });
        const st = tryParse(text, SETTLE_PREFIX);
        if (st?.m && (st.k === "return" || st.k === "burn")) settleCandidates.push({ sig: s.signature, blockTime: s.blockTime, st });
      }
    }

    // Settlements only count if the operator itself signed them.
    const settled = new Map(); // mint -> { kind, sig, blockTime }
    for (const c of settleCandidates.reverse()) {
      const tx = await verifiedTx(c.sig, cache);
      if (tx.failed || !tx.signers.includes(operator)) continue;
      settled.set(c.st.m, { kind: c.st.k, sig: c.sig, blockTime: c.blockTime });
    }

    // A bond only counts if: the founder signed; the same tx paid >= collateral
    // to the operator; the same tx created THIS coin on pump.fun; the deadline
    // is 48h after the block time; and pump.fun records the founder as creator.
    const bonds = [];
    const seen = new Set();
    for (const c of bondCandidates) {
      if (seen.has(c.b.m)) continue;
      const tx = await verifiedTx(c.sig, cache);
      if (tx.failed || !tx.signers.includes(c.b.f)) continue;
      const paid = tx.transfers.filter((t) => t.from === c.b.f && t.to === operator).reduce((n, t) => n + BigInt(t.lamports), 0n);
      const collateral = BigInt(c.b.c);
      if (paid < collateral || collateral < MIN_COLLATERAL_LAMPORTS) continue;
      if (!tx.pumpCreateMints.includes(c.b.m)) continue;
      if (Math.abs(c.b.d - (tx.blockTime + bondSeconds)) > DEADLINE_TOLERANCE_SECS) continue;
      seen.add(c.b.m);
      bonds.push({
        mint: c.b.m,
        founder: c.b.f,
        target: BigInt(c.b.t),
        collateral,
        deadline: c.b.d,
        createdAt: tx.blockTime,
        sig: c.sig,
      });
    }

    // Live curves, and the creator check (pump.fun must list the founder as creator).
    const curveKeys = bonds.map((b) => pump.pdas.pumpCurve(b.mint));
    const infos = [];
    for (let i = 0; i < curveKeys.length; i += 100) infos.push(...(await connection.getMultipleAccountsInfo(curveKeys.slice(i, i + 100))));
    const out = [];
    bonds.forEach((b, i) => {
      const curve = infos[i] ? decodeCurve(new Uint8Array(infos[i].data)) : null;
      if (!curve || new PublicKey(curve.creatorBytes).toBase58() !== b.founder) return;
      out.push(viewOf(b, curve, settled.get(b.mint)));
    });
    return out.sort((a, c) => c.deadline - a.deadline);
  }

  function viewOf(b, curve, settlement) {
    const mcap = marketCapLamports(curve);
    const reached = targetReached(curve, b.target);
    let state;
    if (settlement) state = settlement.kind === "return" ? "claimed" : "burned";
    else if (reached) state = "reached";
    else if (Math.floor(Date.now() / 1000) > b.deadline) state = "expired";
    else state = "locked";
    return {
      mint: b.mint,
      founder: b.founder,
      target: b.target,
      collateral: b.collateral,
      deadline: b.deadline,
      mcap,
      progress: b.target > 0n ? Math.min(1, Number((mcap * 10000n) / b.target) / 10000) : 0,
      complete: !!curve.complete,
      state,
      settlementSig: settlement?.sig || null,
      bondSig: b.sig,
      createdAt: b.createdAt,
    };
  }

  // ---- operator actions (signed by the operator wallet) ----
  // Return the collateral to the founder.
  const returnIxs = ({ mint, founder, collateral }) => [
    SystemProgram.transfer({ fromPubkey: op, toPubkey: new PublicKey(founder), lamports: BigInt(collateral) }),
    memoIx(encodeSettleMemo({ mint: String(mint), kind: "return" }), operator),
  ];

  // Burn, step 1: spend the collateral buying the coin on pump.fun.
  const burnBuyIxs = ({ mint, founder, collateral, globalData, minTokensOut }) =>
    pump.buyIxs({ user: operator, mint, creator: founder, globalData, spendLamports: BigInt(collateral), minTokensOut });

  // Burn, step 2: destroy everything the operator holds of the coin (the buy's
  // proceeds) and record the settlement. Amount is read after step 1 lands.
  const burnIxs = ({ mint, amount }) => [
    splToken.createBurnInstruction(pump.ata2022(mint, operator), new PublicKey(mint), op, BigInt(amount), [], splToken.TOKEN_2022_PROGRAM_ID),
    memoIx(encodeSettleMemo({ mint: String(mint), kind: "burn" }), operator),
  ];

  return { operator, launchIxs, scan, returnIxs, burnBuyIxs, burnIxs, memoIx };
}
