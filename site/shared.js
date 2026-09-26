// Balls — shared module loaded by every page: wallet connect, on-chain reads
// of pump.fun coins and Balls bonds, and the transaction builders for
// launching a coin on pump.fun with a founder bond attached.
//
// No bundler: web3.js / anchor / spl-token load as ES modules from esm.sh,
// pinned + deduped to ONE @solana/web3.js instance (two copies is the
// classic esm.sh footgun — `x instanceof PublicKey` silently fails across
// duplicates).
import * as web3 from "https://esm.sh/@solana/web3.js@1.98.4";
import * as anchor from "https://esm.sh/@coral-xyz/anchor@0.31.1?deps=@solana/web3.js@1.98.4";
import * as splToken from "https://esm.sh/@solana/spl-token@0.4.13?deps=@solana/web3.js@1.98.4";
// Generic multi-wallet discovery (the Wallet Standard): lists and connects
// ANY compliant Solana wallet, not just a hardcoded few.
import { getWallets } from "https://esm.sh/@wallet-standard/app@1.1.0";
import { IDL } from "./idl.js";
import { makeCustodial, OPERATORS, BOND_SECONDS, MIN_COLLATERAL_LAMPORTS } from "./custodial.js";
import { MAINNET_RPC_URL, MAINNET_WS_URL } from "./config.js";
import { tradesFromTransaction, mcapAfter } from "./events.js";
import { makeBuilders, decodeCurve, marketCapLamports, targetReached, estimateBuyTokens, estimateSellLamports, applySlippage, PUMP_PROGRAM } from "./pump.js";
export { web3, anchor, splToken, decodeCurve, marketCapLamports, targetReached, estimateBuyTokens, estimateSellLamports, applySlippage };

// Mainnet by default. Open any page once with `?net=devnet` to switch this
// browser to devnet for testing (remembered; `?net=mainnet` switches back, and
// devnet shows an orange banner so it can't be mistaken for the real thing).
function pickNetwork() {
  try {
    const q = new URLSearchParams(window.location.search).get("net");
    if (q === "devnet" || q === "mainnet") localStorage.setItem("balls_net", q);
    return localStorage.getItem("balls_net") === "devnet" ? "devnet" : "mainnet";
  } catch {
    return "mainnet";
  }
}
export const NETWORK = pickNetwork();

// Which bond model the site runs:
//   "custodial" — PHASE 1: collateral is sent to the Balls operator wallet,
//                 which settles bonds by hand (site/custodial.js). No contract.
//   "escrow"    — PHASE 2: collateral sits in the on-chain escrow program
//                 (programs/balls-bond); the code for both lives side by side.
export const MODE = "escrow";
export const OPERATOR = OPERATORS[NETWORK === "mainnet" ? "mainnet" : "devnet"];
// Relative RPC paths ("/rpc") point at this site's own proxy; on localhost
// there is no proxy, so fall back to Solana's public endpoint there.
const onLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const abs = (u, ws = false) => (u.startsWith("/") ? (ws ? window.location.origin.replace(/^http/, "ws") : window.location.origin) + u : u);
const mainnetHttp = MAINNET_RPC_URL && !(MAINNET_RPC_URL.startsWith("/") && onLocalhost) ? abs(MAINNET_RPC_URL) : "https://api.mainnet-beta.solana.com";
const mainnetWs = MAINNET_WS_URL && !(MAINNET_WS_URL.startsWith("/") && onLocalhost) ? abs(MAINNET_WS_URL, true) : undefined;
export const RPC_ENDPOINT = NETWORK === "mainnet" ? mainnetHttp : web3.clusterApiUrl("devnet");
const SOLANA_CHAIN = NETWORK === "mainnet" ? "solana:mainnet" : "solana:devnet";
export const PROGRAM_ID = new web3.PublicKey(IDL.address);
export const connection = new web3.Connection(RPC_ENDPOINT, {
  commitment: "confirmed",
  // Confirmations use a WebSocket; through the proxy it lives at /rpc-ws.
  wsEndpoint: NETWORK === "mainnet" ? mainnetWs : undefined,
});
export const BOND_DURATION_SECS = BOND_SECONDS; // 48 hours, on every network
export const LAMPORTS_PER_SOL = 1_000_000_000;

export function shortAddress(s) {
  return s.slice(0, 4) + "…" + s.slice(-4);
}
export function solscanUrl(address, type = "account") {
  return `https://solscan.io/${type}/${address}${NETWORK === "mainnet" ? "" : "?cluster=devnet"}`;
}
// pump.fun only lists mainnet coins.
export function pumpFunUrl(mint) {
  return NETWORK === "mainnet" ? `https://pump.fun/coin/${mint}` : null;
}


// A program instance bound to a throwaway keypair — usable for read-only
// calls (account fetches, building instructions) before any wallet is
// connected. Never used to send a transaction.
const readOnlyWallet = {
  publicKey: web3.Keypair.generate().publicKey,
  signTransaction: async (tx) => tx,
  signAllTransactions: async (txs) => txs,
};
export const readOnlyProgram = new anchor.Program(
  IDL,
  new anchor.AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" })
);

export let wallet = null; // the connected provider, live-bound export
export let program = null; // anchor.Program bound to `wallet`, live-bound export
// ---------------------------------------------------------------------
// Toasts — every page includes the same #toast element in its markup.
// ---------------------------------------------------------------------
export function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3200);
}

// ---------------------------------------------------------------------
// Wallet discovery. Two sources, merged and deduped by name:
//
// 1. The Wallet Standard registry (`getWallets().get()`) — the real,
//    generic Solana mechanism for "list every installed wallet without
//    hardcoding each one." Any compliant wallet (Phantom, Solflare,
//    Backpack, Coinbase Wallet, OKX, Glow, Ledger Live, ...) registers
//    itself here on page load, with its own name/icon/feature set. This
//    is what actually answers "connect all of them" for Solana wallets —
//    MetaMask itself never will, since it's an Ethereum wallet with no
//    Solana support; bridging one in is a separate, much larger feature.
// 2. A small legacy fallback (`window.solana`/`.solflare`/`.backpack`) for
//    the rare case a wallet only implements the old injected-provider
//    shape and hasn't adopted Wallet Standard — kept as a safety net, not
//    the primary path anymore.
//
// Wallet Standard's signing features work on serialized transaction
// bytes, not Transaction objects — connectStandardWallet below adapts
// that to the same {publicKey, signTransaction, signAllTransactions,
// signMessage, sendTransaction} shape the rest of this app (and Anchor)
// expects, so callers never need to care which path a given wallet came
// through.
// ---------------------------------------------------------------------
const LEGACY_WALLETS = [
  { name: "Phantom", check: () => window.solana?.isPhantom && window.solana },
  { name: "Solflare", check: () => window.solflare?.isSolflare && window.solflare },
  { name: "Backpack", check: () => window.backpack?.isBackpack && window.backpack },
];

function isSolanaStandardWallet(w) {
  return Array.isArray(w.chains) && w.chains.some((c) => c.startsWith("solana:"));
}

const standardRegistry = typeof window !== "undefined" ? getWallets() : null;

function detectWallets() {
  const seen = new Set();
  const entries = [];

  for (const w of standardRegistry?.get() ?? []) {
    if (!isSolanaStandardWallet(w)) continue;
    seen.add(w.name.toLowerCase());
    entries.push({ name: w.name, icon: w.icon || null, isStandard: true, standardWallet: w });
  }
  for (const legacy of LEGACY_WALLETS) {
    if (seen.has(legacy.name.toLowerCase())) continue; // already found via Wallet Standard
    const provider = legacy.check();
    if (provider) entries.push({ name: legacy.name, icon: null, isStandard: false, provider });
  }
  return entries;
}

const walletChangeListeners = [];
// Register a callback to run every time the wallet connects or disconnects
// (called with the current `wallet`, or null on disconnect). Each page
// registers whatever it needs refreshed — e.g. the trending list on the
// home page, the pair selector on the launch page.
export function onWalletChange(fn) {
  walletChangeListeners.push(fn);
}
async function notifyWalletChange() {
  for (const fn of walletChangeListeners) {
    try {
      await fn(wallet);
    } catch (err) {
      console.error("wallet-change listener failed", err);
    }
  }
}

function updateConnectButton() {
  const btn = document.getElementById("connectBtn");
  if (!btn) return;
  if (wallet) {
    btn.textContent = shortAddress(wallet.publicKey.toBase58());
    btn.classList.add("connected");
  } else {
    btn.textContent = "Connect Wallet";
    btn.classList.remove("connected");
  }
}


function serializeAnyTx(tx) {
  return tx.version !== undefined
    ? tx.serialize()
    : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
function deserializeLikeTx(originalTx, bytes) {
  return originalTx.version !== undefined ? web3.VersionedTransaction.deserialize(bytes) : web3.Transaction.from(bytes);
}

// Adapts a Wallet Standard wallet's feature set (which signs raw
// serialized bytes, not Transaction objects, and can sign a message but
// with a different quirk than the legacy shape) to the same
// {publicKey, signTransaction, signAllTransactions, signMessage,
// sendTransaction} interface the rest of this app and Anchor expect.
async function connectStandardWallet(standardWallet, silent = false) {
  const connectFeature = standardWallet.features["standard:connect"];
  if (!connectFeature) throw new Error(`${standardWallet.name} doesn't support connecting.`);
  // silent = reconnect without a popup, only if this site was already approved in the wallet.
  const { accounts } = await connectFeature.connect(silent ? { silent: true } : undefined);
  if (!accounts.length) throw new Error("No account returned by the wallet.");
  const account = accounts[0];
  const publicKey = new web3.PublicKey(account.publicKey);

  const signTxFeature = standardWallet.features["solana:signTransaction"];
  const signMsgFeature = standardWallet.features["solana:signMessage"];
  const signAndSendFeature = standardWallet.features["solana:signAndSendTransaction"];

  async function signTransaction(tx) {
    const [{ signedTransaction }] = await signTxFeature.signTransaction({
      transaction: serializeAnyTx(tx),
      account,
      chain: SOLANA_CHAIN,
    });
    return deserializeLikeTx(tx, signedTransaction);
  }

  return {
    publicKey,
    signTransaction,
    signAllTransactions: async (txs) => {
      const inputs = txs.map((tx) => ({ transaction: serializeAnyTx(tx), account, chain: SOLANA_CHAIN }));
      const results = await signTxFeature.signTransaction(...inputs);
      return results.map((r, i) => deserializeLikeTx(txs[i], r.signedTransaction));
    },
    signMessage: signMsgFeature
      ? async (message) => {
          const [{ signature }] = await signMsgFeature.signMessage({ message, account });
          return signature; // the standard already returns raw bytes, no unwrapping needed
        }
      : undefined,
    sendTransaction: async (tx, conn, opts) => {
      if (signAndSendFeature) {
        const [{ signature }] = await signAndSendFeature.signAndSendTransaction({
          transaction: serializeAnyTx(tx),
          account,
          chain: SOLANA_CHAIN,
          options: opts,
        });
        // Wallet Standard signatures come back as raw bytes; web3.js wants
        // the base58 string form everywhere else in this app.
        return anchor.utils.bytes.bs58.encode(signature);
      }
      const signed = await signTransaction(tx);
      return conn.sendRawTransaction(signed.serialize(), opts);
    },
  };
}

const WALLET_KEY = "balls_wallet";

export async function connectWallet(entry, { silent = false } = {}) {
  if (entry.isStandard) {
    wallet = await connectStandardWallet(entry.standardWallet, silent);
  } else {
    const providerEntry = entry;
    const resp = await providerEntry.provider.connect(silent ? { onlyIfTrusted: true } : undefined);
    const publicKey = resp?.publicKey ?? providerEntry.provider.publicKey;
    wallet = {
      publicKey,
      signTransaction: (tx) => providerEntry.provider.signTransaction(tx),
      signAllTransactions: (txs) => providerEntry.provider.signAllTransactions(txs),
      // Real wallets resolve signMessage to `{signature, publicKey}`
      // (Phantom's documented shape), but arbundles' HexInjectedSolanaSigner
      // (see uploadTokenMetadata) calls `provider.signMessage(...)` and uses
      // whatever comes back AS the raw signature bytes directly, with no
      // unwrapping — so it has to be unwrapped here, once, rather than in
      // every caller.
      signMessage: providerEntry.provider.signMessage
        ? async (msg) => {
            const result = await providerEntry.provider.signMessage(msg);
            return result?.signature ?? result;
          }
        : undefined,
      sendTransaction: (tx, conn, opts) => providerEntry.provider.sendTransaction(tx, conn, opts),
    };
  }
  try {
    localStorage.setItem(WALLET_KEY, entry.name);
  } catch {}
  const anchorProvider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  program = new anchor.Program(IDL, anchorProvider);

  updateConnectButton();
  if (!silent) showToast(`Connected to ${entry.name}`);
  await notifyWalletChange();
}

export async function disconnectWallet() {
  wallet = null;
  program = null;
  try {
    localStorage.removeItem(WALLET_KEY);
  } catch {}
  updateConnectButton();
  await notifyWalletChange();
}

// Wires up #connectBtn + the shared #walletModal wallet picker. Every page
// includes that same markup in its <body>. Call once per page on
// DOMContentLoaded.
// Is the Balls escrow program actually deployed on the network the site is pointed at?
let programLiveCache = null;
export function isProgramLive() {
  if (!programLiveCache) {
    programLiveCache = connection
      .getAccountInfo(PROGRAM_ID)
      .then((info) => !!info?.executable)
      .catch(() => true); // if we can't tell, don't block anything
  }
  return programLiveCache;
}

export function initNav() {
  if (MODE === "escrow" && NETWORK === "mainnet") {
    isProgramLive().then((live) => {
      if (live || document.querySelector(".net-banner")) return;
      const b = document.createElement("div");
      b.className = "net-banner";
      b.textContent = "Launches open soon: the Balls contract is being deployed on mainnet. You can browse and read the docs in the meantime.";
      document.body.prepend(b);
    });
  }
  if (NETWORK === "devnet" && !document.querySelector(".net-banner")) {
    const b = document.createElement("div");
    b.className = "net-banner";
    b.textContent = "DEVNET TEST MODE — play money, not the real thing (add ?net=mainnet to leave)";
    document.body.prepend(b);
  }
  const navLinks = document.getElementById("navLinks");
  const menuBtn = document.getElementById("mobileMenuBtn");
  menuBtn?.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  // Close the mobile dropdown after navigating, and if the viewport is
  // resized back past the mobile breakpoint while it's open (otherwise it
  // can be left stuck open, invisible on desktop layout but still `.open`).
  navLinks?.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      navLinks.classList.remove("open");
      menuBtn?.setAttribute("aria-expanded", "false");
    })
  );
  window.addEventListener("resize", () => {
    if (window.innerWidth > 760) {
      navLinks?.classList.remove("open");
      menuBtn?.setAttribute("aria-expanded", "false");
    }
  });

  const btn = document.getElementById("connectBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      if (wallet) {
        await disconnectWallet();
        return;
      }
      const available = detectWallets();
      if (available.length === 0) {
        showToast("No Solana wallet detected — install Phantom, Solflare, or Backpack.");
        return;
      }
      if (available.length === 1) {
        try {
          await connectWallet(available[0]);
        } catch (err) {
          console.error(err);
          showToast("Wallet connection was rejected or failed.");
        }
        return;
      }
      openWalletPicker(available);
    });
  }

  document.getElementById("walletModalClose")?.addEventListener("click", () => {
    document.getElementById("walletModal").hidden = true;
  });

  autoConnect();

  // Wallets can register themselves (Wallet Standard) at any point after
  // page load, not just before our first check — a plain one-shot timeout
  // can miss one that's slow to inject. The registry's own event fires
  // exactly when that happens instead of guessing a delay.
  standardRegistry?.on("register", () => {
    if (!wallet && detectWallets().length > 0 && btn) {
      btn.title = "Wallet detected — click to connect";
    }
  });
}

// Remembers which wallet was connected and reconnects it on every page load, without a popup,
// as long as the wallet still trusts this site. Wallets register themselves a moment after
// page load, so this waits briefly for the saved one to appear.
async function autoConnect() {
  let saved = null;
  try {
    saved = localStorage.getItem(WALLET_KEY);
  } catch {}
  if (!saved || wallet) return;
  for (let i = 0; i < 20 && !wallet; i++) {
    const entry = detectWallets().find((w) => w.name === saved);
    if (entry) {
      try {
        await connectWallet(entry, { silent: true });
      } catch (err) {
        console.warn("Silent wallet reconnect didn't go through:", err?.message || err);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function openWalletPicker(available) {
  const modal = document.getElementById("walletModal");
  const list = document.getElementById("walletList");
  list.innerHTML = "";
  available.forEach((w) => {
    const item = document.createElement("button");
    item.className = "wallet-option";
    item.innerHTML = `
      <span class="wallet-option-icon">${w.icon ? `<img src="${w.icon}" alt="">` : w.name.slice(0, 1).toUpperCase()}</span>
      <span class="wallet-option-name">${w.name}</span>
      <span class="wallet-option-tag">Installed</span>
    `;
    item.addEventListener("click", async () => {
      modal.hidden = true;
      try {
        await connectWallet(w);
      } catch (err) {
        console.error(err);
        showToast("Wallet connection was rejected or failed.");
      }
    });
    list.appendChild(item);
  });
  modal.hidden = false;
}

export function requireWallet() {
  if (!wallet || !program) {
    showToast("Connect a wallet first.");
    return false;
  }
  return true;
}


let solUsdPriceCache = null; // { price, fetchedAt }
const SOL_USD_TTL_MS = 5 * 60 * 1000;

export async function getSolUsdPrice() {
  if (solUsdPriceCache && Date.now() - solUsdPriceCache.fetchedAt < SOL_USD_TTL_MS) {
    return solUsdPriceCache.price;
  }
  try {
    const resp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const json = await resp.json();
    const price = json?.solana?.usd;
    if (typeof price === "number") {
      solUsdPriceCache = { price, fetchedAt: Date.now() };
      return price;
    }
  } catch (err) {
    console.warn("Could not fetch live SOL/USD price", err);
  }
  return solUsdPriceCache?.price ?? null; // stale cache beats nothing on a transient failure
}


const ARBUNDLES_URL = "https://cdn.jsdelivr.net/npm/arbundles@0.11.1/+esm";
const IRYS_NODE_URL = NETWORK === "mainnet" ? "https://uploader.irys.xyz" : "https://devnet.irys.xyz";

async function uploadToIrys(bytes, contentType) {
  if (!wallet) throw new Error("Connect a wallet first.");
  const { createData, HexInjectedSolanaSigner } = await import(ARBUNDLES_URL);
  const signer = new HexInjectedSolanaSigner(wallet);
  const dataItem = createData(bytes, signer, { tags: [{ name: "Content-Type", value: contentType }] });
  await dataItem.sign(signer);

  const resp = await fetch(`${IRYS_NODE_URL}/tx/solana`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: dataItem.getRaw(),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new Error(`Irys upload failed (${resp.status}): ${bodyText.slice(0, 200)}`);
  }
  // A normal upload answers with JSON ({id, ...}). Uploading the exact same bytes again
  // (same wallet, same content — e.g. retrying a launch after a later step failed)
  // answers `201 text/plain: "Transaction <id> already received"`. That is a success:
  // the data is already stored under that id.
  const text = await resp.text();
  let id;
  try {
    id = JSON.parse(text).id;
  } catch {
    id = /^Transaction (\S+) already received/.exec(text)?.[1];
  }
  if (!id) throw new Error(`Irys upload returned an unexpected reply: ${text.slice(0, 120)}`);
  return `https://gateway.irys.xyz/${id}`;
}

// Irys uploads under 100 KiB are free; bigger ones need a funded Irys balance.
// So shrink anything larger on the fly (canvas -> webp/jpeg, max 512px) instead
// of failing with a payment error. Small images pass through untouched.
const IRYS_FREE_BYTES = 95_000;
async function prepareImage(file) {
  if (file.size <= IRYS_FREE_BYTES) return { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || "application/octet-stream" };
  const bmp = await createImageBitmap(file);
  for (const max of [512, 384, 256]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise((r) => canvas.toBlob(r, "image/webp", q));
      if (blob && blob.size <= IRYS_FREE_BYTES) return { bytes: new Uint8Array(await blob.arrayBuffer()), type: "image/webp" };
    }
  }
  throw new Error("That image is too big to shrink under 95 KB — try a simpler one.");
}

export async function uploadTokenMetadata({ name, symbol, description, imageFile, links = {} }) {
  // Plain native Uint8Array, deliberately not a `Buffer` polyfill — arbundles
  // converts whatever it's given through its OWN internal Buffer instance
  // (loaded from the same jsdelivr bundle as everything else in
  // uploadToIrys), so handing it a *different* Buffer polyfill instance
  // (e.g. one separately imported from esm.sh) trips a real cross-instance
  // type-check failure deep in its signing code (`SubtleCrypto.digest`
  // rejecting it as "not an ArrayBuffer or ArrayBufferView") — the same
  // family of bug as every other "two copies of one library" footgun in
  // this project, just with `buffer` instead of `@solana/web3.js`. A plain
  // Uint8Array sidesteps it entirely since there's only one such instance.
  let imageUrl = "";
  if (imageFile) {
    const img = await prepareImage(imageFile);
    imageUrl = await uploadToIrys(img.bytes, img.type);
  }

  // Same keys pump.fun uses, so its own page shows the links too.
  const metadataJson = { name, symbol, description: description || "", image: imageUrl, showName: true, createdOn: "https://hugeballs.fun" };
  for (const key of ["website", "twitter", "telegram"]) if (links[key]) metadataJson[key] = links[key];
  const jsonBytes = new TextEncoder().encode(JSON.stringify(metadataJson));
  return await uploadToIrys(jsonBytes, "application/json");
}


// ---------------------------------------------------------------------
// Bonds + pump.fun coins
// ---------------------------------------------------------------------
function builders() {
  return makeBuilders({ web3, splToken, program: program || readOnlyProgram, BN: anchor.BN });
}
export function bondPdaFor(mint) {
  return builders().pdas.bond(mint);
}

export function solToLamports(solStr) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(solStr).trim());
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] || "").padEnd(9, "0") || "0");
}
export function lamportsToSol(lamports) {
  return Number(lamports) / LAMPORTS_PER_SOL;
}
export function formatSol(lamports, digits = 3) {
  return lamportsToSol(lamports).toLocaleString(undefined, { maximumFractionDigits: digits });
}
export function formatUsd(num) {
  if (!isFinite(num)) return "$0";
  if (num >= 1000) return "$" + num.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return "$" + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// "47:59:12" — hours:minutes:seconds until the deadline, or null once it has passed.
export function formatCountdown(deadlineUnix) {
  const left = deadlineUnix - Math.floor(Date.now() / 1000);
  if (left <= 0) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(left / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
}

// Keeps every `[data-deadline]` element on the page counting down, once a second.
export function startCountdowns() {
  const tick = () => {
    document.querySelectorAll("[data-deadline]").forEach((el) => {
      const t = formatCountdown(Number(el.dataset.deadline));
      el.textContent = t || "Time's up";
      el.classList.toggle("over", !t);
    });
  };
  tick();
  setInterval(tick, 1000);
}

// Market caps are shown in dollars, compactly: $950, $23k, $25.5k, $1.2M.
export function formatUsdCompact(usd) {
  if (!isFinite(usd) || usd <= 0) return "$0";
  const trim = (n) => String(Math.round(n * 10) / 10).replace(/\.0$/, "");
  if (usd >= 999_950) return `$${trim(usd / 1e6)}M`; // rounds up to 1M instead of "1000k"
  if (usd >= 1e3) return `$${trim(usd / 1e3)}k`;
  return `$${Math.round(usd)}`;
}

// "25000", "25k", "25.5k", "1.2m", "$25,000" -> a number of dollars, or null.
export function parseUsd(text) {
  const m = /^\$?\s*([\d,]*\.?\d+)\s*([kKmM]?)$/.exec(String(text).trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = { "": 1, k: 1e3, m: 1e6 }[m[2].toLowerCase()];
  const v = n * mult;
  return isFinite(v) && v > 0 ? v : null;
}

export function usdToLamports(usd, solUsdPrice) {
  return BigInt(Math.round((usd / solUsdPrice) * 1e9));
}

// "12s ago", "5m ago", "3h ago", "2d ago"
export function timeAgoText(unix) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function timeLeftText(deadlineUnix) {
  const left = deadlineUnix - Math.floor(Date.now() / 1000);
  if (left <= 0) return null;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${left % 60}s` : `${left}s`;
}

// The single decoded view of a bond used by every page.
//   state: "locked"   Active, target not reached, deadline in the future
//          "reached"  Active and target met — founder can claim
//          "expired"  Active, deadline passed, target not met — anyone can burn
//          "claimed" | "burned" | "refunded"  final
function bondView(bondAccount, curve) {
  const status = Object.keys(bondAccount.status)[0];
  const target = BigInt(bondAccount.targetMcap.toString());
  const mcap = curve ? marketCapLamports(curve) : 0n;
  const reached = curve ? targetReached(curve, target) : false;
  const deadline = Number(bondAccount.deadline.toString());
  let state = status;
  if (status === "active") {
    state = reached ? "reached" : Math.floor(Date.now() / 1000) > deadline ? "expired" : "locked";
  }
  return {
    mint: bondAccount.mint.toBase58(),
    founder: bondAccount.founder.toBase58(),
    target,
    collateral: BigInt(bondAccount.collateral.toString()),
    deadline,
    mcap,
    // Once the founder has claimed, the target was hit for good: the bar stays full even if the price falls back.
    progress: state === "claimed" ? 1 : target > 0n ? Math.min(1, Number((mcap * 10000n) / target) / 10000) : 0,
    complete: !!curve?.complete,
    state,
    createdAt: deadline - BOND_SECONDS,
    settlementSig: null,
  };
}



// ---------------------------------------------------------------------
// Sending transactions robustly.
//
// A transaction that is accepted by an RPC node can still never land: under load
// low-fee transactions get dropped, and a single broadcast is not retried. So:
//   1. price the priority fee off what the network is paying right now (mainnet);
//   2. let the WALLET sign first and add any extra signer (a new coin's mint)
//      afterwards, over the final message — Phantom may modify a transaction
//      before signing, which would invalidate a signature added earlier;
//   3. broadcast, then keep re-broadcasting the same signed transaction every
//      ~2s and poll its status until it confirms or its blockhash expires.
// No WebSocket is involved, so nothing depends on a subscription connecting.
// ---------------------------------------------------------------------
let priorityCache = null;
async function priorityMicroLamports() {
  if (NETWORK !== "mainnet") return 0;
  if (priorityCache && Date.now() - priorityCache.at < 30_000) return priorityCache.v;
  let v = 200_000;
  try {
    const fees = (await connection.getRecentPrioritizationFees())
      .map((f) => f.prioritizationFee)
      .filter((x) => x > 0)
      .sort((x, y) => x - y);
    if (fees.length) v = fees[Math.floor(fees.length * 0.75)]; // 75th percentile: lands reliably without overpaying
  } catch (err) {
    console.warn("Could not read recent priority fees, using a default", err);
  }
  v = Math.min(Math.max(v, 100_000), 3_000_000); // floor ~0.00004 SOL, cap ~0.0012 SOL for a 400k-unit tx
  priorityCache = { v, at: Date.now() };
  return v;
}

async function priorityIxs(units = 400_000) {
  const price = await priorityMicroLamports();
  return price
    ? [
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      ]
    : [];
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// `onStep(text)` (optional) reports progress for the UI.
export async function sendTx(instructions, extraSigners = [], onStep = () => {}) {
  if (!wallet) throw new Error("Connect a wallet first.");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new web3.Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);

  onStep("Approve in your wallet…");
  const signed = await wallet.signTransaction(tx); // wallet first
  for (const kp of extraSigners) signed.partialSign(kp); // then the new coin's mint
  const raw = signed.serialize();

  onStep("Sending…");
  let signature;
  try {
    // First broadcast keeps the RPC's own preflight, so an invalid transaction fails
    // immediately with a readable error instead of silently never landing.
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
  } catch (err) {
    const msg = String(err?.message || err);
    console.warn("sendRawTransaction failed:", msg);
    if (/found no record of a prior credit|insufficient lamports|InsufficientFundsForFee/i.test(msg)) {
      throw new Error("Not enough SOL in your wallet for this transaction plus network fees.");
    }
    if (/insufficient funds for rent/i.test(msg)) {
      throw new Error("This transaction would leave an account below the minimum balance Solana requires. Try a larger amount.");
    }
    if (/blockhash not found|expired/i.test(msg)) throw new Error("The network rejected the transaction (expired). Please try again.");
    const detail = /Message: ([^\n]+)/.exec(msg)?.[1] || msg.split("\n")[0];
    throw new Error(`The network rejected the transaction: ${detail.slice(0, 200)}`);
  }

  onStep("Confirming on-chain…");
  const started = Date.now();
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st?.err) throw new Error(`The transaction failed on-chain (${JSON.stringify(st.err)}). No funds were spent beyond the network fee.`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;

    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight || Date.now() - started > 120_000) {
      const last = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (last && !last.err && last.confirmationStatus) return signature; // landed at the last moment
      throw new Error("The network didn't confirm the transaction in time, so it expired and nothing was executed. Please try again.");
    }
    // Same signed bytes again: harmless if it already landed, a second chance if it was dropped.
    connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleepMs(2000);
  }
}

// Dry-run a transaction before asking the wallet to sign it, so a launch that
// would fail on-chain fails here with a readable reason instead.
async function preflight(instructions, payer) {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const res = await connection.simulateTransaction(new web3.VersionedTransaction(msg), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  if (!res.value.err) return;
  const err = JSON.stringify(res.value.err);
  const logs = (res.value.logs || []).join(" ");
  if (/AccountNotFound|InsufficientFunds|insufficient lamports/i.test(err + logs)) {
    throw new Error("Not enough SOL in your wallet for the collateral plus network fees.");
  }
  throw new Error(`This launch would fail on-chain (${err}). Try a slightly different name or symbol.`);
}

// ---- phase 1 (custodial) plumbing ----
const CACHE_KEY = "balls_tx_cache_v1";
const txCache = {
  _mem: null,
  _load() {
    if (this._mem) return this._mem;
    try {
      this._mem = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    } catch {
      this._mem = {};
    }
    return this._mem;
  },
  get(k) {
    return this._load()[k];
  },
  set(k, v) {
    this._load()[k] = v;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this._mem));
    } catch {}
  },
};
function custodial() {
  return makeCustodial({
    web3,
    splToken,
    connection,
    operator: OPERATOR,
    pump: builders(),
    decodeCurve,
    targetReached,
    marketCapLamports,
    bondSeconds: MODE === "custodial" ? BOND_DURATION_SECS : BOND_SECONDS,
  });
}

export async function fetchBond(mint) {
  if (MODE === "custodial") {
    const all = await custodial().scan({ cache: txCache });
    const view = all.find((b) => b.mint === mint);
    if (!view) return null;
    return { view, curve: await fetchLiveCurve(mint), account: null };
  }
  const account = await (program || readOnlyProgram).account.bond.fetchNullable(bondPdaFor(mint));
  if (!account) return null;
  const info = await connection.getAccountInfo(builders().pdas.pumpCurve(mint));
  const curve = info ? decodeCurve(new Uint8Array(info.data)) : null;
  return { view: bondView(account, curve), curve, account };
}

// Every bond, newest-deadline first, with each coin's live curve.
export async function fetchAllBonds() {
  if (MODE === "custodial") return (await custodial().scan({ cache: txCache })).map((view) => ({ view, account: null }));
  const p = program || readOnlyProgram;
  const all = await p.account.bond.all();
  const b = builders();
  const curveKeys = all.map((x) => b.pdas.pumpCurve(x.account.mint));
  const infos = [];
  for (let i = 0; i < curveKeys.length; i += 100) {
    infos.push(...(await connection.getMultipleAccountsInfo(curveKeys.slice(i, i + 100))));
  }
  return all
    .map((x, i) => ({
      view: bondView(x.account, infos[i] ? decodeCurve(new Uint8Array(infos[i].data)) : null),
      account: x.account,
    }))
    .sort((a, c) => c.view.deadline - a.view.deadline);
}

// Name/symbol/image of a pump.fun coin: new pump.fun coins are Token-2022
// mints carrying the token-metadata extension, so it's one RPC read plus the
// JSON at the metadata uri for the image.
const metaCache = new Map();
export async function fetchCoinMetadata(mint) {
  if (metaCache.has(mint)) return metaCache.get(mint);
  let result = null;
  try {
    const md = await splToken.getTokenMetadata(connection, new web3.PublicKey(mint), "confirmed", splToken.TOKEN_2022_PROGRAM_ID);
    if (md) {
      let image = null;
      let description = "";
      let links = {};
      try {
        const resp = await fetch(md.uri);
        if (resp.ok) {
          const json = await resp.json();
          image = json.image || null;
          description = json.description || "";
          links = { website: json.website, twitter: json.twitter, telegram: json.telegram };
        }
      } catch (err) {
        console.warn("Could not fetch metadata JSON", err);
      }
      result = { name: md.name, symbol: md.symbol, uri: md.uri, image, description, links };
    }
  } catch (err) {
    console.warn("Could not read token metadata for", mint, err);
  }
  metaCache.set(mint, result);
  return result;
}

// ---------------------------------------------------------------------
// Launch: pump.fun `create_v2` + Balls `create_bond` in ONE transaction, so
// there is never a moment where the coin exists un-bonded. The wallet signs
// once; the fresh mint keypair co-signs.
// ---------------------------------------------------------------------
export async function launchCoin({ name, symbol, description, imageFile, links = {}, targetSol, targetLamports, collateralSol, onStep = () => {} }) {
  if (!program || !wallet) throw new Error("Connect a wallet first.");
  const target = targetLamports ?? solToLamports(targetSol);
  const collateral = solToLamports(collateralSol);
  if (!target || !collateral) throw new Error("Enter a valid target market cap and collateral in SOL.");

  if (MODE === "custodial" && collateral < MIN_COLLATERAL_LAMPORTS) throw new Error("Collateral must be at least 0.01 SOL.");
  const uri = await uploadTokenMetadata({ name, symbol, description, imageFile, links });

  const mint = web3.Keypair.generate();
  if (MODE === "custodial") {
    // create_v2 + collateral transfer to the Balls wallet + bond memo, one transaction.
    const ixs = custodial().launchIxs({
      founder: wallet.publicKey.toBase58(),
      mint: mint.publicKey,
      name,
      symbol,
      uri,
      target,
      collateral,
      nowUnix: Math.floor(Date.now() / 1000),
    });
    const all = [...(await priorityIxs()), ...ixs];
    await preflight(all, wallet.publicKey);
    const sig = await sendTx(all, [mint], onStep);
    return { txSig: sig, mint: mint.publicKey.toBase58() };
  }
  const b = builders();
  const createIx = b.createV2Ix({ mint: mint.publicKey, name, symbol, uri, creator: wallet.publicKey });
  const bondIx = await b.createBondIx({
    founder: wallet.publicKey,
    mint: mint.publicKey,
    targetLamports: target,
    collateralLamports: collateral,
  });
  const all = [...(await priorityIxs()), createIx, bondIx];
  await preflight(all, wallet.publicKey);
  const sig = await sendTx(all, [mint], onStep);
  return { txSig: sig, mint: mint.publicKey.toBase58() };
}

export async function claimBond(mint) {
  if (!program || !wallet) throw new Error("Connect a wallet first.");
  const tx = await builders().claimBuilder({ founder: wallet.publicKey, mint }).transaction();
  return sendTx([...(await priorityIxs()), ...tx.instructions]);
}

// Permissionless: anyone can burn an expired, unmet bond.
export async function resolveBond(mint, founder, creator) {
  if (!program || !wallet) throw new Error("Connect a wallet first.");
  const globalInfo = await connection.getAccountInfo(new web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"));
  if (!globalInfo) throw new Error("Couldn't read pump.fun's global config.");
  const tx = await builders()
    .resolveBuilder({
      resolver: wallet.publicKey,
      mint,
      founder,
      globalData: new Uint8Array(globalInfo.data),
      creator: creator || founder,
    })
    .transaction();
  return sendTx([...(await priorityIxs()), ...tx.instructions]);
}

// Where a brand-new pump.fun coin's market cap starts, read from pump.fun's
// Global config (initial virtual reserves + supply). Bond targets must be above it.
export async function fetchPumpStartMcap() {
  const info = await connection.getAccountInfo(new web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"));
  if (!info) throw new Error("pump.fun Global not found");
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  // Global: initial_virtual_token_reserves @73, initial_virtual_sol_reserves @81, token_total_supply @97.
  const vt = view.getBigUint64(73, true);
  const vs = view.getBigUint64(81, true);
  const supply = view.getBigUint64(97, true);
  return vt === 0n ? 0n : (vs * supply) / vt;
}

// ---------------------------------------------------------------------
// Trading — plain pump.fun buys/sells, built by pump.js and signed by the
// user's wallet. Balls adds nothing to these transactions.
// ---------------------------------------------------------------------
export const TOKEN_DECIMALS = 6;
const PUMP_GLOBAL_ADDRESS = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";

async function pumpGlobalData() {
  const info = await connection.getAccountInfo(new web3.PublicKey(PUMP_GLOBAL_ADDRESS));
  if (!info) throw new Error("Couldn't read pump.fun's global config.");
  return new Uint8Array(info.data);
}

export async function fetchLiveCurve(mint) {
  const info = await connection.getAccountInfo(builders().pdas.pumpCurve(mint));
  return info ? decodeCurve(new Uint8Array(info.data)) : null;
}

// The connected wallet's SOL (lamports) and coin balance (raw, 6 decimals).
export async function fetchBalances(mint) {
  if (!wallet) return null;
  const lamports = BigInt(await connection.getBalance(wallet.publicKey));
  let tokens = 0n;
  try {
    const ata = builders().ata2022(mint, wallet.publicKey);
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    tokens = BigInt(bal.value.amount);
  } catch {
    // no token account yet
  }
  return { lamports, tokens };
}

// Buy `spendSol` SOL worth of the coin, reverting if fewer than the
// slippage-adjusted estimate come back. `creator` is the coin's pump.fun
// creator (= the bond's founder).
export async function buyCoin({ mint, creator, spendSol, slippageBps = 500, onStep = () => {} }) {
  if (!program || !wallet) throw new Error("Connect a wallet first.");
  const spend = solToLamports(spendSol);
  if (!spend || spend <= 0n) throw new Error("Enter an amount of SOL to spend.");
  const curve = await fetchLiveCurve(mint);
  if (!curve || curve.complete) throw new Error("This coin has graduated — trade it on pump.fun / PumpSwap.");
  const minOut = applySlippage(estimateBuyTokens(curve, spend), slippageBps);
  const ixs = builders().buyIxs({
    user: wallet.publicKey,
    mint,
    creator,
    globalData: await pumpGlobalData(),
    spendLamports: spend,
    minTokensOut: minOut,
  });
  return sendTx([...(await priorityIxs()), ...ixs], [], onStep);
}

// Sell `tokenAmountRaw` (BigInt, raw units) of the coin.
export async function sellCoin({ mint, creator, tokenAmountRaw, slippageBps = 500, onStep = () => {} }) {
  if (!program || !wallet) throw new Error("Connect a wallet first.");
  const amount = BigInt(tokenAmountRaw);
  if (amount <= 0n) throw new Error("Enter an amount of the coin to sell.");
  const curve = await fetchLiveCurve(mint);
  if (!curve || curve.complete) throw new Error("This coin has graduated — trade it on pump.fun / PumpSwap.");
  const minOut = applySlippage(estimateSellLamports(curve, amount), slippageBps);
  const ix = builders().sellIx({
    user: wallet.publicKey,
    mint,
    creator,
    globalData: await pumpGlobalData(),
    tokenAmount: amount,
    minSolOut: minOut,
  });
  return sendTx([...(await priorityIxs()), ix], [], onStep);
}

// The wallets allowed to trigger burns (admin "resolver" + automated
// "keeper"), read from the on-chain Config.
export async function fetchBurners() {
  try {
    const cfg = await (program || readOnlyProgram).account.config.fetchNullable(builders().pdas.config());
    return cfg ? [cfg.resolver.toBase58(), cfg.keeper.toBase58()] : [];
  } catch (err) {
    console.warn("Could not read Balls config", err);
    return [];
  }
}

// ---------------------------------------------------------------------
// Operator actions (phase 1). Only meaningful when the connected wallet IS
// the Balls operator wallet — anyone else's transaction would just fail,
// since these spend FROM the operator's account.
// ---------------------------------------------------------------------
export const isOperatorWallet = () => !!wallet && wallet.publicKey.toBase58() === OPERATOR;

// Target reached: send the collateral back to the founder.
export async function operatorReturn(view) {
  if (!isOperatorWallet()) throw new Error("Connect the Balls operator wallet.");
  const ixs = custodial().returnIxs({ mint: view.mint, founder: view.founder, collateral: view.collateral });
  return sendTx([...(await priorityIxs()), ...ixs]);
}

// Deadline missed: buy the coin with the collateral, then burn what was
// bought. Two transactions (the burn amount is only known after the buy).
// Safe to retry: if the buy already landed, it skips straight to the burn.
export async function operatorBurn(view, onStep = () => {}) {
  if (!isOperatorWallet()) throw new Error("Connect the Balls operator wallet.");
  const c = custodial();
  const b = builders();
  const held = async () => {
    try {
      const bal = await connection.getTokenAccountBalance(b.ata2022(view.mint, wallet.publicKey), "confirmed");
      return BigInt(bal.value.amount);
    } catch {
      return 0n;
    }
  };
  if ((await held()) === 0n) {
    onStep("Step 1/2: buying the coin with the collateral…");
    const ixs = c.burnBuyIxs({
      mint: view.mint,
      founder: view.founder,
      collateral: view.collateral,
      globalData: await pumpGlobalData(),
      minTokensOut: 1n,
    });
    await sendTx([...(await priorityIxs()), ...ixs]);
    await new Promise((r) => setTimeout(r, 2500));
  }
  const amount = await held();
  if (amount === 0n) throw new Error("The buy didn't deliver any tokens — nothing to burn.");
  onStep("Step 2/2: burning the tokens…");
  return sendTx([...(await priorityIxs()), ...c.burnIxs({ mint: view.mint, amount })]);
}

// Headline numbers for the home page, from the verified bond list.
export function computeStats(views) {
  const sum = (state) => views.filter((v) => v.state === state).reduce((n, v) => n + v.collateral, 0n);
  return {
    burnedLamports: sum("burned"),
    returnedLamports: sum("claimed"),
    liveCount: views.filter((v) => ["locked", "reached", "expired"].includes(v.state)).length,
    burnedCount: views.filter((v) => v.state === "burned").length,
    hitCount: views.filter((v) => v.state === "claimed").length,
    total: views.length,
  };
}

// ---------------------------------------------------------------------
// Trades: every buy/sell of a coin, read from pump.fun's on-chain TradeEvent (see events.js).
// Confirmed transactions never change, so each one is fetched once and cached per coin.
// ---------------------------------------------------------------------
const b58 = () => anchor.utils.bytes.bs58;
const eventHelpers = {
  toBase58: (bytes) => b58().encode(bytes),
  decodeBase58: (str) => b58().decode(str),
  base64ToBytes: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
};
const tradeCacheKey = (mint) => `balls_trades_v1_${NETWORK}_${mint}`;
const packTrade = (t) => ({ ...t, sol: t.sol.toString(), tokens: t.tokens.toString(), vs: t.vs.toString(), vt: t.vt.toString() });
const unpackTrade = (t) => ({ ...t, sol: BigInt(t.sol), tokens: BigInt(t.tokens), vs: BigInt(t.vs), vt: BigInt(t.vt) });

// ---------------------------------------------------------------------
// Market history from GeckoTerminal (indexes pump.fun curves and PumpSwap pools).
// CORS-open, no key. Gives the last ~300 trades and OHLCV candles, far more than
// we could rebuild from raw transactions. The on-chain reader above stays as the
// fallback for coins the indexer hasn't picked up yet.
// ---------------------------------------------------------------------
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";
const poolCache = new Map();
async function geckoJson(path) {
  const r = await fetch(`${GECKO}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GeckoTerminal ${r.status}`);
  return r.json();
}
export async function fetchMarketHistory(mint) {
  let pool = poolCache.get(mint);
  if (!pool) {
    const pools = (await geckoJson(`/tokens/${mint}/pools`)).data || [];
    if (!pools.length) return null;
    pool = pools[0].attributes.address;
    poolCache.set(mint, pool);
  }
  const [tr, oh] = await Promise.all([
    geckoJson(`/pools/${pool}/trades`).catch(() => null),
    geckoJson(`/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000&currency=usd&token=base`).catch(() => null),
  ]);
  const trades = ((tr && tr.data) || [])
    .map((d) => d.attributes)
    .filter((a) => a.kind === "buy" || a.kind === "sell")
    .map((a) => {
      const isBuy = a.kind === "buy";
      const sol = Number(isBuy ? a.from_token_amount : a.to_token_amount);
      const tokens = Number(isBuy ? a.to_token_amount : a.from_token_amount);
      return {
        sig: a.tx_hash,
        time: Math.floor(Date.parse(a.block_timestamp) / 1000),
        isBuy,
        user: a.tx_from_address,
        sol: Math.round(sol * 1e9),
        tokens: Math.round(tokens * 1e6),
        priceUsd: Number(isBuy ? a.price_to_in_usd : a.price_from_in_usd),
        mcap: Math.round(Number(isBuy ? a.price_to_in_currency_token : a.price_from_in_currency_token) * 1e18),
      };
    })
    .filter((t) => t.sig && t.time);
  const candles = ((oh && oh.data.attributes.ohlcv_list) || []).map((c) => ({ t: c[0], usd: c[4] * 1e9 })).sort((a, b) => a.t - b.t);
  return { pool, trades, candles };
}

// Newest first. Returns [{sig, time, isBuy, user, sol, tokens, vs, vt, mcap}].
// Provider plans rate-limit requests per second, and every transaction in a batch counts,
// so missing transactions are fetched in small chunks with a pause between them, and
// `onProgress(trades)` is called after each chunk so the page fills in while it loads.
// Anything already cached (transactions never change) costs nothing.
const TRADE_CHUNK = 8;
const TRADE_CHUNK_PAUSE_MS = 700;
export async function fetchCoinTrades(mint, limit = 80, onProgress = null) {
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(tradeCacheKey(mint)) || "{}");
  } catch {}
  const curve = builders().pdas.pumpCurve(mint);
  const sigs = (await connection.getSignaturesForAddress(curve, { limit }, "confirmed")).filter((x) => !x.err);

  const assemble = () => {
    const out = [];
    for (const x of sigs) for (const t of cache[x.signature] || []) out.push(unpackTrade(t));
    for (const t of out) t.mcap = mcapAfter({ virtualSolReserves: t.vs, virtualTokenReserves: t.vt });
    return out.sort((a, c) => c.time - a.time);
  };
  const save = () => {
    try {
      const keys = Object.keys(cache);
      if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete cache[k];
      localStorage.setItem(tradeCacheKey(mint), JSON.stringify(cache));
    } catch {}
  };

  const missing = sigs.filter((x) => !(x.signature in cache));
  if (missing.length && onProgress) onProgress(assemble()); // show what's cached straight away
  for (let i = 0; i < missing.length; i += TRADE_CHUNK) {
    const chunk = missing.slice(i, i + TRADE_CHUNK);
    let txs;
    try {
      txs = await connection.getTransactions(chunk.map((x) => x.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (err) {
      console.warn("Trade batch failed, retrying one by one", err?.message || err);
      txs = [];
      for (const x of chunk) {
        txs.push(await connection.getTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null));
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    chunk.forEach((x, idx) => {
      const tx = txs[idx];
      if (!tx) return; // not available yet: tried again on the next refresh
      const events = tradesFromTransaction(tx, mint, eventHelpers);
      // Cache by signature, including "no trade in this tx" (coin creation, etc.) as an empty list.
      cache[x.signature] = events.map((ev) =>
        packTrade({
          sig: x.signature,
          time: ev.timestamp || x.blockTime,
          isBuy: ev.isBuy,
          user: ev.user,
          sol: ev.solAmount,
          tokens: ev.tokenAmount,
          vs: ev.virtualSolReserves,
          vt: ev.virtualTokenReserves,
        })
      );
    });
    save();
    if (onProgress) onProgress(assemble());
    if (i + TRADE_CHUNK < missing.length) await new Promise((r) => setTimeout(r, TRADE_CHUNK_PAUSE_MS));
  }
  save();
  return assemble();
}
