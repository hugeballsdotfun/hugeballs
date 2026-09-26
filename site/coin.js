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
  fetchPumpStartMcap,
  fetchCoinTrades,
  fetchMarketHistory,
  timeAgoText,
  BOND_DURATION_SECS,
  MODE,
  OPERATOR,
  isOperatorWallet,
  operatorReturn,
  operatorBurn,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

// Everything the page shows is derived from this. `refresh()` re-reads the chain and repaints
// in place, so a trade / claim / burn never needs a page reload (which would drop the wallet).
const state = { mint: null, view: null, curve: null, solUsd: null, trades: [], candles: [], pool: null, source: "chain", startMcap: null, burners: [], listeners: [] };

function fillCopyRow(id, value, type = "account") {
  const el = $(id);
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

const usdText = (lamports) =>
  state.solUsd ? formatUsdCompact(lamportsToSol(lamports) * state.solUsd) : `${formatSol(lamports, 2)} SOL`;
const money = (l) =>
  `${formatSol(l)} SOL${state.solUsd ? ` <span class="usd">≈ ${formatUsd(lamportsToSol(l) * state.solUsd)}</span>` : ""}`;
const fmtTokens = (raw) => {
  const n = Number(raw) / 10 ** TOKEN_DECIMALS;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

// ---------------------------------------------------------------------
// Bond header, stats, meter and action buttons (repainted on every refresh)
// ---------------------------------------------------------------------
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

function paint() {
  const view = state.view;
  const [cls, label] = BADGES[view.state] || ["locked", view.state];
  $("coinStatusBadge").innerHTML = `<span class="badge ${cls}">${label}</span>`;

  $("statMcap").textContent = usdText(view.mcap);
  $("statTarget").textContent = usdText(view.target);
  $("statCollateral").innerHTML = money(view.collateral);
  const timeEl = $("statTime");
  const timeLabel = $("statTimeLabel");
  if (view.state === "locked") {
    timeLabel.textContent = "Time left";
    timeEl.dataset.deadline = String(view.deadline);
    timeEl.classList.add("mono");
    startCountdowns();
  } else {
    delete timeEl.dataset.deadline;
    timeEl.classList.remove("mono", "over");
    if (view.state === "reached") {
      timeLabel.textContent = "Status";
      timeEl.textContent = "Ready to claim";
    } else if (view.state === "expired") {
      timeLabel.textContent = "Deadline";
      timeEl.textContent = "Passed";
    } else {
      timeLabel.textContent = "Outcome";
      timeEl.textContent = { claimed: "Returned", burned: "Burned", refunded: "Refunded" }[view.state];
    }
  }

  const pct = Math.round(view.progress * 1000) / 10;
  $("progressBar").style.width = `${Math.max(pct, 1)}%`;
  $("meter").classList.toggle("burned", view.state === "burned");
  $("progressText").textContent =
    `Market cap ${usdText(view.mcap)} / ${usdText(view.target)} (${pct}%)${view.complete ? " — graduated from the pump.fun curve" : ""}`;

  $("actionText").textContent = TEXT[view.state] || "";
  $("actionText").classList.toggle("win", view.state === "reached" || view.state === "claimed");
  $("actionText").classList.toggle("lose", view.state === "burned" || view.state === "expired");
  renderActions();
}

function renderActions() {
  const view = state.view;
  if (!view) return;
  const claimBtn = $("claimBtn");
  const burnBtn = $("burnBtn");
  const me = wallet && wallet.publicKey.toBase58();
  if (custodial) {
    const op = isOperatorWallet();
    claimBtn.hidden = !(op && view.state === "reached");
    burnBtn.hidden = !(op && view.state === "expired");
    return;
  }
  claimBtn.hidden = !(me === view.founder && view.state === "reached");
  burnBtn.hidden = !(me && state.burners.includes(me) && view.state === "expired");
}

async function refresh() {
  const data = await fetchBond(state.mint);
  if (!data) return;
  state.view = data.view;
  state.curve = data.curve;
  paint();
  await refreshTrades();
  for (const fn of state.listeners) {
    try {
      await fn();
    } catch (err) {
      console.warn(err);
    }
  }
}

// ---------------------------------------------------------------------
// Trades table + chart
// ---------------------------------------------------------------------
let tradesShown = 20;
let chartWindow = 0; // seconds; 0 = all

// GeckoTerminal's own chart (real candles, same look as DexScreener) once the coin is indexed.
// Our SVG chart stays as the fallback for coins the indexer hasn't seen yet.
function showEmbeddedChart() {
  if (!state.pool) return;
  const frame = $("gtFrame");
  const src = `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(state.pool)}?embed=1&info=0&swaps=0&light_chart=0&chart_type=market_cap&resolution=15m`;
  if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
  const links = $("gtLinks");
  if (!links.childElementCount) {
    for (const [label, url] of [
      ["Open on GeckoTerminal", `https://www.geckoterminal.com/solana/pools/${state.pool}`],
      ["Open on DexScreener", `https://dexscreener.com/solana/${state.pool}`],
    ]) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = label;
      links.appendChild(a);
    }
  }
  $("gtEmbed").hidden = false;
  $("chartWrap").hidden = true;
  $("chartTabs").hidden = true;
  $("chartLegend").hidden = true;
}

async function refreshTrades() {
  // Preferred: the indexer's history (hundreds of trades + candles). Fallback: read the chain.
  try {
    const h = await fetchMarketHistory(state.mint);
    if (h) {
      state.pool = h.pool;
      showEmbeddedChart(); // the chart only needs the pool, even if the trade list is rate-limited
    }
    if (h && h.trades.length) {
      state.trades = h.trades;
      state.candles = h.candles;
      state.source = "index";
      renderTrades();
      renderChart();
      return;
    }
  } catch (err) {
    console.warn("Market history unavailable", err?.message || err);
    if (state.source === "index") return; // rate-limited mid-session: keep what we have
  }
  state.source = "chain";
  state.candles = [];
  try {
    state.trades = await fetchCoinTrades(state.mint, 80, (partial) => {
      state.trades = partial;
      renderTrades();
      renderChart();
    });
  } catch (err) {
    console.warn("Could not load trades", err);
    $("tradesNote").textContent = "Couldn't load trades right now. They'll retry automatically.";
    return;
  }
  renderTrades();
  renderChart();
}

function renderTrades() {
  const body = $("tradesBody");
  const note = $("tradesNote");
  const more = $("tradesMore");
  body.innerHTML = "";
  const me = wallet?.publicKey.toBase58();
  if (state.trades.length === 0) {
    note.textContent = "No trades yet. Be the first.";
    more.hidden = true;
    return;
  }
  note.textContent = `${state.trades.length} trade${state.trades.length === 1 ? "" : "s"}, newest first. ${state.source === "index" ? "Market data from GeckoTerminal." : "Read straight from the blockchain."}`;
  for (const t of state.trades.slice(0, tradesShown)) {
    const tr = document.createElement("tr");
    const acc = document.createElement("td");
    const a = document.createElement("a");
    a.href = solscanUrl(t.user, "account");
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = shortAddress(t.user);
    acc.appendChild(a);
    for (const [cond, cls, text] of [[t.user === state.view.founder, "dev", "dev"], [t.user === me, "you", "you"]]) {
      if (!cond) continue;
      const tag = document.createElement("span");
      tag.className = `tx-tag ${cls}`;
      tag.textContent = text;
      acc.appendChild(tag);
    }
    const type = document.createElement("td");
    type.className = t.isBuy ? "tx-buy" : "tx-sell";
    type.textContent = t.isBuy ? "Buy" : "Sell";
    const sol = document.createElement("td");
    sol.className = "num";
    sol.textContent = formatSol(t.sol, 3);
    const tok = document.createElement("td");
    tok.className = "num";
    tok.textContent = fmtTokens(t.tokens);
    const time = document.createElement("td");
    time.className = "num";
    time.textContent = timeAgoText(t.time);
    const tx = document.createElement("td");
    tx.className = "num";
    const link = document.createElement("a");
    link.href = solscanUrl(t.sig, "tx");
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "Open the transaction in Solscan";
    link.textContent = "↗";
    tx.appendChild(link);
    tr.append(acc, type, sol, tok, time, tx);
    body.appendChild(tr);
  }
  more.hidden = state.trades.length <= tradesShown;
}

// Chart points, oldest first: {t, v (lamports), trade?}. Starts at the coin's launch market cap,
// follows every trade, and ends at the live market cap.
function chartPoints() {
  const asc = [...state.trades].sort((x, y) => x.time - y.time);
  const created = state.view.deadline - BOND_DURATION_SECS;
  const pts = [];
  if (state.candles.length && state.solUsd) {
    // candle closes are USD market caps; the chart works in lamports
    for (const c of state.candles) pts.push({ t: c.t, v: (c.usd / state.solUsd) * 1e9 });
    for (const tr of asc) pts.push({ t: tr.time, v: tr.mcap, trade: tr });
    pts.sort((a, b) => a.t - b.t);
  } else {
    if (state.startMcap) pts.push({ t: Math.min(created, asc[0]?.time ?? created), v: state.startMcap });
    for (const tr of asc) pts.push({ t: tr.time, v: tr.mcap, trade: tr });
  }
  pts.push({ t: Math.floor(Date.now() / 1000), v: state.view.mcap });
  return pts;
}

const SVG = "http://www.w3.org/2000/svg";
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function renderChart() {
  const svg = $("priceChart");
  const wrap = $("chartWrap");
  svg.innerHTML = "";
  $("chartTip").hidden = true;
  let pts = chartPoints();
  const now = pts[pts.length - 1].t;
  if (chartWindow) {
    const from = now - chartWindow;
    const before = [...pts].reverse().find((p) => p.t < from);
    pts = pts.filter((p) => p.t >= from);
    if (before) pts.unshift({ t: from, v: before.v }); // step in from the value held at the window start
  }
  const overlay =
    wrap.querySelector(".chart-marks") ||
    (() => {
      const d = document.createElement("div");
      d.className = "chart-marks";
      d.style.cssText = "position:absolute;inset:0;pointer-events:none;";
      wrap.appendChild(d);
      return d;
    })();
  overlay.innerHTML = "";
  $("chartEmpty").hidden = state.trades.length > 0;
  if (pts.length < 2) return;

  const W = 640, H = 260, L = 8, R = 8, T = 16, B = 22;
  const toV = (lamports) => (state.solUsd ? lamportsToSol(lamports) * state.solUsd : lamportsToSol(lamports));
  const fmtV = (v) => (state.solUsd ? formatUsdCompact(v) : `${v.toFixed(1)} SOL`);
  const vals = pts.map((p) => toV(p.v));
  const targetV = toV(state.view.target);
  let max = Math.max(...vals);
  const showTarget = targetV <= max * 3; // a target far above the price would flatten the whole chart
  if (showTarget) max = Math.max(max, targetV);
  let min = Math.min(...vals);
  const pad = (max - min) * 0.12 || max * 0.1 || 1;
  min = Math.max(0, min - pad);
  max += pad;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t > t0 ? pts[pts.length - 1].t : t0 + 1;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - min) / Math.max(1e-9, max - min)) * (H - T - B);

  const defs = svgEl("defs");
  const grad = svgEl("linearGradient", { id: "areaGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
  grad.append(
    svgEl("stop", { offset: "0", "stop-color": "#d5d8df", "stop-opacity": "0.38" }),
    svgEl("stop", { offset: "1", "stop-color": "#d5d8df", "stop-opacity": "0" })
  );
  defs.appendChild(grad);
  svg.appendChild(defs);

  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "#2a2a32", "stroke-width": "1", "vector-effect": "non-scaling-stroke" }));
  }
  if (showTarget) {
    svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: y(targetV), y2: y(targetV), stroke: "#cfd2da", "stroke-width": "1.5", "stroke-dasharray": "6 5", "vector-effect": "non-scaling-stroke" }));
  }

  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(toV(p.v)).toFixed(1)}`).join(" ");
  svg.appendChild(svgEl("path", { d: `${line} L${x(t1).toFixed(1)},${H - B} L${x(t0).toFixed(1)},${H - B} Z`, fill: "url(#areaGrad)" }));
  svg.appendChild(svgEl("path", { d: line, fill: "none", stroke: "#e9ebf0", "stroke-width": "2", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }));

  // trade markers and captions live in an HTML overlay so they don't stretch with the viewBox
  const pct = (val, total) => `${(val / total) * 100}%`;
  for (const p of pts.filter((q) => q.trade).slice(-80)) {
    const dot = document.createElement("i");
    dot.style.cssText = `position:absolute;width:7px;height:7px;border-radius:50%;transform:translate(-50%,-50%);left:${pct(x(p.t), W)};top:${pct(y(toV(p.v)), H)};background:${p.trade.isBuy ? "#b8f227" : "#ff5a1f"};box-shadow:0 0 0 2px #101013;`;
    overlay.appendChild(dot);
  }
  const cap = (txt, side, topPct, extra = "") => {
    const c = document.createElement("span");
    c.textContent = txt;
    c.style.cssText = `position:absolute;${side}:8px;top:${topPct}%;font-size:11px;color:#8b8c94;pointer-events:none;font-variant-numeric:tabular-nums;${extra}`;
    overlay.appendChild(c);
  };
  cap(fmtV(max - pad), "left", 1);
  cap(fmtV(min), "left", 84);
  cap(timeAgoText(t0), "left", 92.5);
  cap("now", "right", 92.5);
  if (showTarget) cap(`Target ${fmtV(targetV)}`, "right", Math.max(0, (y(targetV) / H) * 100 - 7), "color:#cfd2da;");
  else cap(`Target ${fmtV(targetV)} is above this chart`, "right", 1, "color:#cfd2da;");

  // hover / touch readout
  const tip = $("chartTip");
  const show = (clientX) => {
    const box = wrap.getBoundingClientRect();
    const t = t0 + ((clientX - box.left) / box.width) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    tip.hidden = false;
    tip.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = fmtV(toV(best.v));
    const small = document.createElement("div");
    small.textContent = best.trade ? `${best.trade.isBuy ? "Buy" : "Sell"} ${formatSol(best.trade.sol, 3)} SOL · ${timeAgoText(best.t)}` : timeAgoText(best.t);
    tip.append(b, small);
    tip.style.left = `${Math.min(Math.max(4, (x(best.t) / W) * box.width - 60), box.width - 150)}px`;
  };
  wrap.onpointermove = (e) => show(e.clientX);
  wrap.onpointerleave = () => (tip.hidden = true);
}

// ---------------------------------------------------------------------
// Buy / sell panel: plain pump.fun trades. Hidden once the coin has graduated
// off the curve (those trades happen on PumpSwap, via pump.fun).
// ---------------------------------------------------------------------
async function initTrade(mint, creator) {
  const card = $("tradeCard");
  if (!state.curve) return;
  card.hidden = false;

  const prompt = $("tradeConnectPrompt");
  const panel = $("tradePanel");
  const amountEl = $("tradeAmount");
  const balanceEl = $("tradeBalance");
  const previewEl = $("tradePreview");
  const submit = $("tradeSubmit");
  let tab = "buy";
  let balances = null;
  const fmtTok = (raw) => (Number(raw) / 10 ** TOKEN_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 });

  function applyGraduation() {
    const graduated = !!state.curve?.complete;
    $("tradeGraduated").hidden = !graduated;
    if (graduated) {
      prompt.hidden = true;
      panel.hidden = true;
    }
    return graduated;
  }
  async function refreshBalances() {
    balances = await fetchBalances(mint);
    updateBalanceLine();
    renderQuick();
  }
  function updateBalanceLine() {
    if (!balances) return void (balanceEl.textContent = "-");
    balanceEl.textContent = tab === "buy" ? `${formatSol(balances.lamports, 4)} SOL` : `${fmtTok(balances.tokens)} tokens`;
  }
  const rawToInput = (raw) => {
    const s = raw.toString().padStart(TOKEN_DECIMALS + 1, "0");
    const whole = s.slice(0, -TOKEN_DECIMALS);
    const frac = s.slice(-TOKEN_DECIMALS).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  };
  const FEE_RESERVE = 10_000_000n; // keep 0.01 SOL back for fees and rent on "max"
  function renderQuick() {
    const row = $("tradeQuick");
    row.innerHTML = "";
    row.classList.toggle("sell", tab === "sell");
    const opts =
      tab === "buy"
        ? [["0.1", () => "0.1"], ["0.5", () => "0.5"], ["1", () => "1"], ["Max", () => {
            if (!balances || balances.lamports <= FEE_RESERVE) return null;
            return (Number(balances.lamports - FEE_RESERVE) / 1e9).toFixed(4);
          }]]
        : [["25%", 25n], ["50%", 50n], ["75%", 75n], ["100%", 100n]].map(([label, pct]) => [
            label,
            () => (balances && balances.tokens > 0n ? rawToInput((balances.tokens * pct) / 100n) : null),
          ]);
    for (const [label, get] of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "quick-btn";
      b.textContent = label;
      b.addEventListener("click", () => {
        const v = get();
        if (v === null) return showToast(tab === "buy" ? "Not enough SOL." : "You have no tokens to sell.");
        amountEl.value = v;
        updatePreview();
      });
      row.appendChild(b);
    }
  }
  function updatePreview() {
    previewEl.textContent = "-";
    const v = amountEl.value.trim();
    if (!v || !state.curve) return;
    try {
      if (tab === "buy") {
        const spend = solToLamports(v);
        if (!spend) return;
        previewEl.textContent = `≈ ${fmtTok(estimateBuyTokens(state.curve, spend))} tokens`;
      } else {
        const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
        if (!m) return;
        const raw = BigInt(m[1]) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((m[2] || "").padEnd(TOKEN_DECIMALS, "0") || "0");
        previewEl.textContent = `≈ ${formatSol(estimateSellLamports(state.curve, raw), 4)} SOL`;
      }
    } catch {}
  }
  function setTab(t) {
    tab = t;
    $("tradeTabBuy").classList.toggle("selected", t === "buy");
    $("tradeTabSell").classList.toggle("selected", t === "sell");
    $("tradeUnit").textContent = t === "buy" ? "SOL" : "TOKENS";
    submit.classList.toggle("sell", t === "sell");
    submit.textContent = t === "buy" ? "Buy" : "Sell";
    renderQuick();
    amountEl.value = "";
    updateBalanceLine();
    updatePreview();
  }
  $("tradeTabBuy").addEventListener("click", () => setTab("buy"));
  $("tradeTabSell").addEventListener("click", () => setTab("sell"));
  amountEl.addEventListener("input", updatePreview);
  $("tradeConnectBtn").addEventListener("click", () => $("connectBtn").click());

  function gate() {
    if (applyGraduation()) return;
    prompt.hidden = !!wallet;
    panel.hidden = !wallet;
    if (wallet) refreshBalances();
  }
  renderQuick();
  gate();
  onWalletChange(gate);
  state.listeners.push(async () => {
    updatePreview();
    if (!applyGraduation() && wallet) await refreshBalances();
  });

  $("tradeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = amountEl.value.trim();
    submit.disabled = true;
    const label = tab === "buy" ? "Buy" : "Sell";
    try {
      submit.textContent = "Approve in your wallet…";
      if (tab === "buy") {
        await buyCoin({ mint, creator, spendSol: v, onStep: (t) => (submit.textContent = t) });
      } else {
        const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
        if (!m) throw new Error("Enter a plain number of tokens.");
        const raw = BigInt(m[1]) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((m[2] || "").padEnd(TOKEN_DECIMALS, "0") || "0");
        await sellCoin({ mint, creator, tokenAmountRaw: raw, onStep: (t) => (submit.textContent = t) });
      }
      showToast(`${label} confirmed`);
      amountEl.value = "";
      updatePreview();
      await sleep(1500); // let the RPC index the new transaction, then repaint in place (wallet stays connected)
      await refresh();
    } catch (err) {
      console.error(err);
      showToast(err.message || `${label} failed.`);
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
}

// ---------------------------------------------------------------------
async function main() {
  initNav();
  const mint = mintFromUrl();
  let valid = false;
  try {
    valid = !!mint && !!new web3.PublicKey(mint);
  } catch {}
  if (!valid) return void ($("coinNotFound").hidden = false);
  state.mint = mint;

  let data;
  try {
    data = await fetchBond(mint);
  } catch (err) {
    console.warn("Could not load bond", err);
    return void ($("coinLoadError").hidden = false);
  }
  if (!data) return void ($("coinNotFound").hidden = false);
  state.view = data.view;
  state.curve = data.curve;
  state.solUsd = await getSolUsdPrice();
  fetchPumpStartMcap()
    .then((v) => {
      state.startMcap = v;
      renderChart();
    })
    .catch(() => {});

  $("coinContent").hidden = false;
  $("coinName").textContent = shortAddress(mint);
  $("coinIcon").textContent = "?";
  const view = state.view;

  // static receipts
  fillCopyRow("detailMint", mint, "token");
  fillCopyRow("detailFounder", view.founder, "account");
  const bondPda = custodial ? "" : bondPdaFor(mint).toBase58();
  if (bondPda) fillCopyRow("detailBond", bondPda, "account");
  if (custodial) {
    $("detailBondLabel").textContent = "Bond transaction";
    $("detailBond").innerHTML = `<a class="solscan-link" href="${solscanUrl(view.bondSig, "tx")}" target="_blank" rel="noopener">${shortAddress(view.bondSig)} ↗</a>`;
    $("detailVaultLabel").textContent = "Collateral held by (Balls wallet)";
    fillCopyRow("detailVault", OPERATOR, "account");
  } else {
    $("detailVaultLabel").textContent = "Collateral vault (program-owned)";
    $("programRow").hidden = false;
    fillCopyRow("detailProgram", PROGRAM_ID.toBase58(), "account");
    const [vault] = web3.PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), new web3.PublicKey(bondPda).toBytes()], PROGRAM_ID);
    fillCopyRow("detailVault", vault.toBase58(), "account");
  }
  if (view.settlementSig) {
    $("settleRow").hidden = false;
    $("detailSettle").innerHTML = `<a class="solscan-link" href="${solscanUrl(view.settlementSig, "tx")}" target="_blank" rel="noopener">${shortAddress(view.settlementSig)} ↗</a>`;
  }

  fetchCoinMetadata(mint).then((m) => {
    if (!m) return;
    $("coinName").textContent = `${m.name} (${m.symbol})`;
    $("pageTitle").textContent = `${m.symbol} bond — Balls`;
    setIcon($("coinIcon"), m.image, m.symbol.slice(0, 1).toUpperCase());
    // Social links from the metadata: only plain http(s) URLs, built with DOM APIs (never innerHTML).
    const box = $("coinLinks");
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
      const d = $("coinDescription");
      d.textContent = m.description;
      d.hidden = false;
    }
  });

  // actions
  const pumpLink = $("pumpLink");
  const url = pumpFunUrl(mint);
  if (url) {
    pumpLink.href = url;
    pumpLink.hidden = false;
  }
  $("claimBtn").textContent = custodial ? "Return the founder's SOL" : "Claim your SOL back";
  $("burnBtn").textContent = "Buy & burn";
  state.burners = custodial ? [] : await fetchBurners();
  paint();
  onWalletChange(() => {
    renderActions();
    renderTrades(); // re-mark "you"
  });

  async function run(btn, label, fn) {
    btn.disabled = true;
    btn.textContent = "Confirm in wallet…";
    try {
      const sig = await fn((step) => (btn.textContent = step));
      console.log(label, "tx", sig);
      showToast(`${label} done`);
      await sleep(2000);
      await refresh();
    } catch (err) {
      console.error(err);
      showToast(err.message || `${label} failed.`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  $("claimBtn").addEventListener("click", () =>
    run($("claimBtn"), $("claimBtn").textContent, () => (custodial ? operatorReturn(state.view) : claimBond(mint)))
  );
  $("burnBtn").addEventListener("click", () =>
    run($("burnBtn"), $("burnBtn").textContent, (onStep) =>
      custodial ? operatorBurn(state.view, onStep) : resolveBond(mint, state.view.founder, state.view.founder)
    )
  );

  // chart tabs + "show more"
  document.querySelectorAll("#chartTabs .chart-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll("#chartTabs .chart-tab").forEach((t) => t.classList.remove("selected"));
      tab.classList.add("selected");
      chartWindow = Number(tab.dataset.window);
      renderChart();
    })
  );
  $("tradesMore").addEventListener("click", () => {
    tradesShown += 20;
    renderTrades();
  });

  initTrade(mint, view.founder).catch((err) => console.warn("Trade panel unavailable", err));
  await refreshTrades();

  // keep everything live without reloading
  setInterval(() => {
    if (document.visibilityState === "visible") refresh().catch((err) => console.warn("refresh failed", err));
  }, 20000);
}

document.addEventListener("DOMContentLoaded", () => {
  main();
  $("coinRetryBtn")?.addEventListener("click", () => window.location.reload());
});
