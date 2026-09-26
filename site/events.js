// Reads pump.fun's on-chain TradeEvent out of confirmed transactions, so the coin page can
// list every buy/sell and draw the price chart without any backend or indexer.
//
// pump.fun emits the event two ways depending on the program version: as an
// Anchor "self-CPI" inner instruction (data = 8-byte event-CPI tag + 8-byte event
// discriminator + fields) and/or as a "Program data: <base64>" log line (discriminator +
// fields). Both are handled. Layout comes from pump.fun's public IDL (pump-public-docs).
//
// Pure module: base58 decoding is injected so it runs in the browser and in Node.

const EVENT_CPI_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const TRADE_EVENT = [189, 219, 127, 211, 78, 230, 97, 238];

const startsWith = (bytes, prefix, at = 0) => prefix.every((b, i) => bytes[at + i] === b);
const u64 = (dv, o) => dv.getBigUint64(o, true);

// bytes = discriminator (8) + TradeEvent fields.
export function decodeTradeEvent(bytes, toBase58) {
  if (bytes.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 * 4) return null;
  if (!startsWith(bytes, TRADE_EVENT)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mint: toBase58(bytes.slice(8, 40)),
    solAmount: u64(dv, 40), // lamports the trader paid (buy) or received (sell), before fees
    tokenAmount: u64(dv, 48), // raw token units
    isBuy: bytes[56] !== 0,
    user: toBase58(bytes.slice(57, 89)),
    timestamp: Number(dv.getBigInt64(89, true)),
    virtualSolReserves: u64(dv, 97), // AFTER the trade
    virtualTokenReserves: u64(dv, 105),
  };
}

// `tx` is a getTransaction() result (json encoding). Returns the trade events for `mint`.
export function tradesFromTransaction(tx, mint, { toBase58, decodeBase58, base64ToBytes }) {
  const out = [];
  if (!tx?.meta || tx.meta.err) return out;
  const seen = new Set();
  const push = (ev) => {
    if (!ev || ev.mint !== mint) return;
    const key = `${ev.user}:${ev.isBuy}:${ev.solAmount}:${ev.tokenAmount}:${ev.timestamp}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ev);
  };
  for (const group of tx.meta.innerInstructions || []) {
    for (const ix of group.instructions) {
      let data;
      try {
        data = decodeBase58(ix.data);
      } catch {
        continue;
      }
      if (startsWith(data, EVENT_CPI_TAG)) push(decodeTradeEvent(data.slice(8), toBase58));
    }
  }
  for (const line of tx.meta.logMessages || []) {
    if (!line.startsWith("Program data: ")) continue;
    try {
      push(decodeTradeEvent(base64ToBytes(line.slice(14)), toBase58));
    } catch {}
  }
  return out;
}

// Market cap in lamports after a trade: virtual SOL x supply / virtual tokens.
export const TOTAL_SUPPLY_RAW = 1_000_000_000_000_000n; // 1e9 tokens x 6 decimals
export const mcapAfter = (ev) =>
  ev.virtualTokenReserves === 0n ? 0n : (ev.virtualSolReserves * TOTAL_SUPPLY_RAW) / ev.virtualTokenReserves;
