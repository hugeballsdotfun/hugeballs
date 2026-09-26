import {
  initNav,
  fetchAllBonds,
  fetchCoinMetadata,
  getSolUsdPrice,
  computeStats,
  formatSol,
  formatUsd,
  formatUsdCompact,
  lamportsToSol,
  shortAddress,
  startCountdowns,
} from "./shared.js";

let views = [];
let countdownsStarted = false;
const startCountdownsOnce = () => {
  if (!countdownsStarted) {
    countdownsStarted = true;
    startCountdowns();
  }
};
const meta = new Map(); // mint -> { name, symbol, image }
let solUsd = null;
let filter = "all";
let sort = "closest";
let search = "";

const BADGE = {
  locked: ["locked", "Live"],
  reached: ["hit", "Target hit"],
  expired: ["expired", "Time's up"],
  claimed: ["hit", "Got it back"],
  burned: ["burned", "Burned"],
  refunded: ["expired", "Refunded"],
};
const isLive = (s) => s === "locked" || s === "reached" || s === "expired";
const isHit = (s) => s === "reached" || s === "claimed";

// All text that came from chain metadata goes through textContent / this, never innerHTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const money = (lamports, digits = 2) => {
  const sol = `${formatSol(lamports, digits)} SOL`;
  return solUsd ? `${sol}<span class="usd">≈ ${formatUsd(lamportsToSol(lamports) * solUsd)}</span>` : sol;
};
// Market caps and targets are shown in dollars (falls back to SOL only if no price loaded).
const usdText = (lamports) => (solUsd ? formatUsdCompact(lamportsToSol(lamports) * solUsd) : `${formatSol(lamports, 1)} SOL`);
const label = (v) => {
  const m = meta.get(v.mint);
  return m ? `${m.name} (${m.symbol})` : shortAddress(v.mint);
};

function visible() {
  let list = views;
  if (filter === "live") list = list.filter((v) => isLive(v.state));
  if (filter === "hit") list = list.filter((v) => isHit(v.state));
  if (filter === "burned") list = list.filter((v) => v.state === "burned");
  if (search) {
    const q = search.toLowerCase();
    list = list.filter((v) => {
      const m = meta.get(v.mint);
      return [v.mint, v.founder, m?.name, m?.symbol].filter(Boolean).some((s) => s.toLowerCase().includes(q));
    });
  }
  const by = {
    closest: (a, b) => (isLive(b.state) - isLive(a.state)) || b.progress - a.progress,
    newest: (a, b) => b.createdAt - a.createdAt,
    stake: (a, b) => Number(b.collateral - a.collateral),
    deadline: (a, b) => (isLive(b.state) - isLive(a.state)) || a.deadline - b.deadline,
  }[sort];
  return [...list].sort(by);
}

function renderStats() {
  const s = computeStats(views);
  document.getElementById("stBurned").textContent = `${formatSol(s.burnedLamports, 2)}`;
  document.getElementById("stReturned").textContent = `${formatSol(s.returnedLamports, 2)}`;
  document.getElementById("stLive").textContent = String(s.liveCount);
  document.getElementById("stTotal").textContent = String(s.total);
}

function renderTicker() {
  const done = views.filter((v) => v.state === "burned" || v.state === "claimed").slice(0, 12);
  const wrap = document.getElementById("ticker");
  if (done.length === 0) return void (wrap.hidden = true);
  const item = (v) =>
    v.state === "burned"
      ? `<span class="ticker-item"> <b>${esc(label(v))}</b> burned ${esc(formatSol(v.collateral, 2))} SOL</span>`
      : `<span class="ticker-item"> <b>${esc(label(v))}</b> got ${esc(formatSol(v.collateral, 2))} SOL back</span>`;
  const html = done.map(item).join("");
  document.getElementById("tickerTrack").innerHTML = html + html; // doubled for a seamless loop
  wrap.hidden = false;
}

function setIcon(el, image, letter) {
  el.textContent = letter;
  if (!image || !/^https?:\/\//.test(image)) return;
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = image;
  img.addEventListener("load", () => {
    el.textContent = "";
    el.appendChild(img);
  });
}

function card(v) {
  const el = document.createElement("div");
  const [cls, badgeText] = BADGE[v.state] || ["locked", v.state];
  el.className = `card coin-card ${v.state === "burned" ? "burned" : isHit(v.state) ? "hit" : ""}`;
  const pct = Math.max(0, Math.min(100, Math.round(v.progress * 100)));
  const bondLabel = v.state === "burned" ? "Bond burned" : v.state === "claimed" || v.state === "refunded" ? "Bond returned" : "Bond on the line";
  const amountCls = v.state === "burned" ? "fire" : v.state === "claimed" ? "lime" : "";
  const usd = solUsd ? `<span class="cc-usd">≈ ${formatUsd(lamportsToSol(v.collateral) * solUsd)}</span>` : "";
  const foot =
    v.state === "locked"
      ? `<span class="cc-label">Time left</span><span class="cc-timer" data-deadline="${v.deadline}">--:--:--</span>`
      : v.state === "reached"
        ? `<span class="cc-label">Status</span><span class="cc-outcome win">Target hit, ready to claim</span>`
        : v.state === "expired"
          ? `<span class="cc-label">Status</span><span class="cc-outcome lose">Deadline passed, burn pending</span>`
          : v.state === "claimed"
            ? `<span class="cc-label">Outcome</span><span class="cc-outcome win">Claimed by the founder</span>`
            : v.state === "refunded"
              ? `<span class="cc-label">Outcome</span><span class="cc-outcome lose">Reclaimed after the grace period</span>`
              : `<span class="cc-label">Outcome</span><span class="cc-outcome lose">Bought the coin and burned it</span>`;
  el.innerHTML = `
    <div class="cc-head">
      <div class="tok-icon">?</div>
      <div class="cc-id">
        <div class="cc-name"></div>
        <div class="cc-sub"></div>
      </div>
      <span class="badge ${cls}">${badgeText}</span>
    </div>
    <div class="cc-bond ${amountCls}">
      <span class="cc-label">${bondLabel}</span>
      <span class="cc-amount">${formatSol(v.collateral, 2)} <small>SOL</small></span>
      ${usd}
    </div>
    <div class="cc-progress">
      <div class="cc-progress-top">
        <span>Market cap <b>${usdText(v.mcap)}</b></span>
        <span>Target <b>${usdText(v.target)}</b></span>
      </div>
      <div class="meter ${v.state === "burned" ? "burned" : ""}"><div class="meter-fill" style="width:${Math.max(pct, 2)}%"></div><span class="meter-flag"></span></div>
      <div class="cc-progress-bot"><span>${pct}% of the way there</span><span>${v.target > v.mcap ? usdText(v.target - v.mcap) + " to go" : "Target reached"}</span></div>
    </div>
    <div class="cc-foot">${foot}</div>`;
  const m = meta.get(v.mint);
  el.querySelector(".cc-name").textContent = m ? m.name : shortAddress(v.mint);
  el.querySelector(".cc-sub").textContent = `${m ? m.symbol + "  ·  " : ""}dev ${shortAddress(v.founder)}`;
  setIcon(el.querySelector(".tok-icon"), m?.image, (m?.symbol || "?").slice(0, 1).toUpperCase());
  el.addEventListener("click", () => (window.location.href = `coin.html?mint=${v.mint}`));
  return el;
}

function render() {
  const grid = document.getElementById("coinGrid");
  const note = document.getElementById("coinNote");
  const list = visible();
  grid.innerHTML = "";
  if (list.length === 0) {
    grid.innerHTML = `<div class="empty">${
      views.length === 0 ? "No coins yet. Be the first founder with the balls to launch one. " : "Nothing matches. Try another filter."
    }</div>`;
    note.textContent = "";
    return;
  }
  list.forEach((v) => grid.appendChild(card(v)));
  startCountdownsOnce();
  note.textContent = `${list.length} coin${list.length === 1 ? "" : "s"} · live from the blockchain`;
}

function loadMetadata() {
  let pending = views.filter((v) => !meta.has(v.mint));
  const queue = [...pending];
  let refreshed = false;
  const worker = async () => {
    while (queue.length) {
      const v = queue.shift();
      const m = await fetchCoinMetadata(v.mint);
      if (m) {
        meta.set(v.mint, m);
        refreshed = true;
      }
    }
  };
  // a few at a time, so a long list doesn't hammer the RPC
  Promise.all([worker(), worker(), worker()]).then(() => {
    if (refreshed) {
      render();
      renderTicker();
    }
  });
}

async function load() {
  try {
    const [bonds, price] = await Promise.all([fetchAllBonds(), getSolUsdPrice()]);
    views = bonds.map((b) => b.view);
    solUsd = price;
  } catch (err) {
    console.warn("Could not load coins", err);
    document.getElementById("coinNote").textContent = "Couldn't load coins — check your connection and refresh.";
    return;
  }
  renderStats();
  render();
  renderTicker();
  loadMetadata();
}

document.addEventListener("DOMContentLoaded", () => {
  initNav();
  document.getElementById("coinSearch").addEventListener("input", (e) => {
    search = e.target.value.trim();
    render();
  });
  document.getElementById("sortSelect").addEventListener("change", (e) => {
    sort = e.target.value;
    render();
  });
  document.querySelectorAll(".tab[data-filter]").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab[data-filter]").forEach((t) => t.classList.remove("selected"));
      tab.classList.add("selected");
      filter = tab.dataset.filter;
      render();
    })
  );
  load();
});
