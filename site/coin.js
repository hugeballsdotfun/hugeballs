import {
  initNav,
  onWalletChange,
  wallet,
  fetchBond,
  fetchCoinMetadata,
  claimBond,
  resolveBond,
  getSolUsdPrice,
  formatSol,
  formatUsd,
  formatUsdCompact,
  lamportsToSol,
  startCountdowns,
  shortAddress,
  solscanUrl,
  pumpFunUrl,
  bondPdaFor,
  fetchBurners,
  MODE,
  OPERATOR,
  isOperatorWallet,
  operatorReturn,
  operatorBurn,
  fetchLiveCurve,
  fetchBalances,
  buyCoin,
  sellCoin,
  estimateBuyTokens,
  estimateSellLamports,
  TOKEN_DECIMALS,
  solToLamports,
  showToast,
  web3,
  PROGRAM_ID,
} from "./shared.js";
import { safeHttpUrl } from "./links.js";

const mintFromUrl = () => new URLSearchParams(window.location.search).get("mint");

function fillCopyRow(id, value, type = "account") {
  const el = document.getElementById(id);
  el.innerHTML = `<span class="copy-text" title="Click to copy">${shortAddress(value)}</span>
    <a class="solscan-link" href="${solscanUrl(value, type)}" target="_blank" rel="noopener" title="Open in Solscan">↗</a>`;
  el.querySelector(".copy-text").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      showToast("Copied");
    } catch {
      showToast(value);
    }
  });
}

const BADGES = {
  locked: ["locked", "Live"],
  reached: ["hit", "Target hit"],
  expired: ["expired", "Time's up"],
  claimed: ["hit", "Got it back"],
  burned: ["burned", "Burned"],
  refunded: ["expired", "Refunded"],
};

// Sets an icon from untrusted metadata without ever putting it in innerHTML.
function setIcon(el, image, letter) {
  el.textContent = letter;
  if (!image || !/^https?:\/\//.test(image)) return;
  const img = document.createElement("img");
  img.alt = "";
  img.src = image;
  img.addEventListener("load", () => {
    el.textContent = "";
    el.appendChild(img);
  });
}

async function main() {
  initNav();
  const mint = mintFromUrl();
  let valid = false;
  try {
    valid = !!mint && !!new web3.PublicKey(mint);
  } catch {}
  if (!valid) return void (document.getElementById("coinNotFound").hidden = false);

  let data;
  try {
    data = await fetchBond(mint);
  } catch (err) {
    console.warn("Could not load bond", err);
    return void (document.getElementById("coinLoadError").hidden = false);
  }
  if (!data) return void (document.getElementById("coinNotFound").hidden = false);

  const { view } = data;
  const solUsd = await getSolUsdPrice();
  const money = (l) =>
    `${formatSol(l)} SOL${solUsd ? ` <span class="usd">≈ ${formatUsd(lamportsToSol(l) * solUsd)}</span>` : ""}`;

  document.getElementById("coinContent").hidden = false;
  document.getElementById("coinName").textContent = shortAddress(mint);
  document.getElementById("coinIcon").textContent = "?";
  const [cls, label] = BADGES[view.state] || ["locked", view.state];
  document.getElementById("coinStatusBadge").innerHTML = `<span class="badge ${cls}">${label}</span>`;

  const usdText = (l) => (solUsd ? formatUsdCompact(lamportsToSol(l) * solUsd) : `${formatSol(l, 2)} SOL`);
  document.getElementById("statMcap").textContent = usdText(view.mcap);
  document.getElementById("statTarget").textContent = usdText(view.target);
  document.getElementById("statCollateral").innerHTML = money(view.collateral);
  const timeEl = document.getElementById("statTime");
  const timeLabel = document.getElementById("statTimeLabel");
  if (view.state === "locked") {
    timeEl.dataset.deadline = String(view.deadline);
    timeEl.classList.add("mono");
    startCountdowns();
  } else if (view.state === "reached") {
    timeLabel.textContent = "Status";
    timeEl.textContent = "Ready to claim";
  } else if (view.state === "expired") {
    timeLabel.textContent = "Deadline";
    timeEl.textContent = "Passed";
  } else {
    timeLabel.textContent = "Outcome";
    timeEl.textContent = { claimed: "Returned", burned: "Burned", refunded: "Refunded" }[view.state];
  }

  const pct = Math.round(view.progress * 1000) / 10;
  document.getElementById("progressBar").style.width = `${Math.max(pct, 1)}%`;
  document.getElementById("meter").classList.toggle("burned", view.state === "burned");
  document.getElementById("progressText").textContent =
    `Market cap ${usdText(view.mcap)} / ${usdText(view.target)} (${pct}%)${view.complete ? " — graduated from the pump.fun curve" : ""}`;

  fillCopyRow("detailMint", mint, "token");
  fillCopyRow("detailFounder", view.founder, "account");
  const bondPda = MODE === "custodial" ? "" : bondPdaFor(mint).toBase58();
  if (bondPda) fillCopyRow("detailBond", bondPda, "account");
  if (MODE === "custodial") {
    document.getElementById("detailBondLabel").textContent = "Bond transaction";
    document.getElementById("detailBond").innerHTML = `<a class="solscan-link" href="${solscanUrl(view.bondSig, "tx")}" target="_blank" rel="noopener">${shortAddress(view.bondSig)} ↗</a>`;
    document.getElementById("detailVaultLabel").textContent = "Collateral held by (Balls wallet)";
    fillCopyRow("detailVault", OPERATOR, "account");
  } else {
    document.getElementById("detailVaultLabel").textContent = "Collateral vault (program-owned)";
    document.getElementById("programRow").hidden = false;
    fillCopyRow("detailProgram", PROGRAM_ID.toBase58(), "account");
    const [vault] = web3.PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), new web3.PublicKey(bondPda).toBytes()], PROGRAM_ID);
    fillCopyRow("detailVault", vault.toBase58(), "account");
  }

  if (view.settlementSig) {
    document.getElementById("settleRow").hidden = false;
    document.getElementById("detailSettle").innerHTML = `<a class="solscan-link" href="${solscanUrl(view.settlementSig, "tx")}" target="_blank" rel="noopener">${shortAddress(view.settlementSig)} ↗</a>`;
  }

  fetchCoinMetadata(mint).then((m) => {
    if (!m) return;
    document.getElementById("coinName").textContent = `${m.name} (${m.symbol})`;
    document.getElementById("pageTitle").textContent = `${m.symbol} bond — Balls`;
    setIcon(document.getElementById("coinIcon"), m.image, m.symbol.slice(0, 1).toUpperCase());
    // Social links from the metadata: only plain http(s) URLs, built with DOM APIs (never innerHTML).
    const box = document.getElementById("coinLinks");
    for (const [key, label] of [["website", "Website"], ["twitter", "X"], ["telegram", "Telegram"]]) {
      const url = m.links?.[key] && typeof m.links[key] === "string" ? safeHttpUrl(m.links[key]) : null;
      if (!url) continue;
      const a = document.createElement("a");
      a.className = "social-pill";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      a.textContent = label;
      box.appendChild(a);
    }
    box.hidden = box.children.length === 0;
    if (m.description) {
      const d = document.getElementById("coinDescription");
      d.textContent = m.description;
      d.hidden = false;
    }
  });

  // ---- actions ----
  const actionText = document.getElementById("actionText");
  const claimBtn = document.getElementById("claimBtn");
  const burnBtn = document.getElementById("burnBtn");
  const pumpLink = document.getElementById("pumpLink");
  const url = pumpFunUrl(mint);
  if (url) {
    pumpLink.href = url;
    pumpLink.hidden = false;
  }

  const custodial = MODE === "custodial";
  const TEXT = custodial
    ? {
        locked: "The founder sent this SOL to the Balls wallet. Hit the target before the deadline and Balls sends it back. Miss it, and it buys this coin and gets burned.",
        reached: "Target hit. Balls will return the founder's SOL.",
        expired: "Time's up and the target wasn't hit. Balls will buy this coin with the founder's SOL and burn every token bought.",
        claimed: "The founder hit the target and got their SOL back.",
        burned: "The founder missed. Their SOL bought this coin and every token bought was burned.",
      }
    : {
        locked: "The founder locked this SOL in the Balls escrow contract. Hit the target before the deadline and they can claim it back. Miss it, and the contract buys this coin with it and burns every token bought.",
        reached: "Target hit. The founder can now claim their SOL back from the contract.",
        expired: "Time's up and the target wasn't hit. The contract will now buy this coin with the founder's SOL and burn every token bought.",
        claimed: "The founder hit the target and claimed their SOL back.",
        burned: "The founder missed. Their SOL bought this coin and every token bought was burned.",
        refunded: "This bond expired and was never burned, so the founder reclaimed it after the 7-day grace period.",
      };
  actionText.textContent = TEXT[view.state] || "";
  actionText.classList.toggle("win", view.state === "reached" || view.state === "claimed");
  actionText.classList.toggle("lose", view.state === "burned" || view.state === "expired");
  if (custodial) {
    claimBtn.textContent = "Return the founder's SOL";
    burnBtn.textContent = "Buy & burn";
  } else {
    claimBtn.textContent = "Claim your SOL back";
    burnBtn.textContent = "Buy & burn";
  }

  // Escrow mode: the founder claims, the configured burners resolve. Custodial
  // mode: only the Balls operator wallet acts (return / buy+burn).
  const burners = custodial ? [] : await fetchBurners();
  function renderActions() {
    const me = wallet && wallet.publicKey.toBase58();
    if (custodial) {
      const op = isOperatorWallet();
      claimBtn.hidden = !(op && view.state === "reached");
      burnBtn.hidden = !(op && view.state === "expired");
      return;
    }
    claimBtn.hidden = !(me === view.founder && view.state === "reached");
    burnBtn.hidden = !(me && burners.includes(me) && view.state === "expired");
  }
  renderActions();
  onWalletChange(() => renderActions());

  async function run(btn, label, fn) {
    btn.disabled = true;
    btn.textContent = "Confirm in wallet…";
    try {
      const sig = await fn((step) => (btn.textContent = step));
      console.log(label, "tx", sig);
      showToast(`${label} done!`);
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      console.error(err);
      showToast(err.message || `${label} failed.`);
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  initTrade(mint, view.founder).catch((err) => console.warn("Trade panel unavailable", err));
  claimBtn.addEventListener("click", () =>
    run(claimBtn, claimBtn.textContent, () => (custodial ? operatorReturn(view) : claimBond(mint)))
  );
  burnBtn.addEventListener("click", () =>
    run(burnBtn, burnBtn.textContent, (onStep) =>
      custodial ? operatorBurn(view, onStep) : resolveBond(mint, view.founder, view.founder)
    )
  );
}

// Buy/sell panel: plain pump.fun trades. Hidden once the coin has graduated
// off the curve (those trades happen on PumpSwap, via pump.fun).
async function initTrade(mint, creator) {
  const card = document.getElementById("tradeCard");
  const curve = await fetchLiveCurve(mint);
  if (!curve) return;
  card.hidden = false;
  if (curve.complete) {
    document.getElementById("tradeGraduated").hidden = false;
    return;
  }

  const prompt = document.getElementById("tradeConnectPrompt");
  const panel = document.getElementById("tradePanel");
  const amountEl = document.getElementById("tradeAmount");
  const balanceEl = document.getElementById("tradeBalance");
  const previewEl = document.getElementById("tradePreview");
  const submit = document.getElementById("tradeSubmit");
  let tab = "buy";
  let balances = null;
  const fmtTok = (raw) => (Number(raw) / 10 ** TOKEN_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 });

  async function refreshBalances() {
    balances = await fetchBalances(mint);
    updateBalanceLine();
  }
  function updateBalanceLine() {
    if (!balances) return void (balanceEl.textContent = "");
    balanceEl.textContent =
      tab === "buy" ? `Balance: ${formatSol(balances.lamports, 4)} SOL` : `Balance: ${fmtTok(balances.tokens)} tokens`;
  }
  function updatePreview() {
    previewEl.textContent = "";
    const v = amountEl.value.trim();
    if (!v) return;
    try {
      if (tab === "buy") {
        const spend = solToLamports(v);
        if (!spend) return;
        previewEl.textContent = `≈ ${fmtTok(estimateBuyTokens(curve, spend))} tokens (before slippage; max 5% worse)`;
      } else {
        const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
        if (!m) return;
        const raw = BigInt(m[1]) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((m[2] || "").padEnd(TOKEN_DECIMALS, "0") || "0");
        previewEl.textContent = `≈ ${formatSol(estimateSellLamports(curve, raw), 4)} SOL (before slippage; max 5% worse)`;
      }
    } catch {}
  }
  function setTab(t) {
    tab = t;
    document.getElementById("tradeTabBuy").classList.toggle("selected", t === "buy");
    document.getElementById("tradeTabSell").classList.toggle("selected", t === "sell");
    document.getElementById("tradeAmountText").textContent = t === "buy" ? "SOL to spend" : "Tokens to sell";
    submit.textContent = t === "buy" ? "Buy" : "Sell";
    amountEl.value = "";
    updateBalanceLine();
    updatePreview();
  }
  document.getElementById("tradeTabBuy").addEventListener("click", () => setTab("buy"));
  document.getElementById("tradeTabSell").addEventListener("click", () => setTab("sell"));
  amountEl.addEventListener("input", updatePreview);
  document.getElementById("tradeConnectBtn").addEventListener("click", () => document.getElementById("connectBtn").click());

  function gate() {
    prompt.hidden = !!wallet;
    panel.hidden = !wallet;
    if (wallet) refreshBalances();
  }
  gate();
  onWalletChange(gate);

  document.getElementById("tradeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = amountEl.value.trim();
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Confirm in wallet…";
    try {
      if (tab === "buy") {
        await buyCoin({ mint, creator, spendSol: v });
      } else {
        const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
        if (!m) throw new Error("Enter a plain number of tokens.");
        const raw = BigInt(m[1]) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((m[2] || "").padEnd(TOKEN_DECIMALS, "0") || "0");
        await sellCoin({ mint, creator, tokenAmountRaw: raw });
      }
      showToast(`${label} confirmed!`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      console.error(err);
      showToast(err.message || `${label} failed.`);
      submit.disabled = false;
      submit.textContent = label;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  main();
  document.getElementById("coinRetryBtn")?.addEventListener("click", () => window.location.reload());
});
