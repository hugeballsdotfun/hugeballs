import {
  initNav,
  onWalletChange,
  PROGRAM_ID,
  isProgramLive,
  launchCoin,
  showToast,
  getSolUsdPrice,
  fetchPumpStartMcap,
  formatSol,
  formatUsdCompact,
  parseUsd,
  usdToLamports,
  formatUsd,
  lamportsToSol,
  solToLamports,
} from "./shared.js";
import { normalizeLinks } from "./links.js";

function initImagePreview() {
  const input = document.getElementById("imageInput");
  const preview = document.getElementById("imagePreview");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) {
      preview.textContent = "No image";
      return;
    }
    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
  });
}

async function initLaunchForm() {
  const connectPrompt = document.getElementById("launchConnectPrompt");
  const formCard = document.getElementById("launchFormCard");
  const form = document.getElementById("launchForm");
  const btn = document.getElementById("launchBtn");
  const targetHint = document.getElementById("targetHint");
  const collateralHint = document.getElementById("collateralHint");
  const targetInput = document.getElementById("targetInput");
  const collateralInput = document.getElementById("collateralInput");

  document.getElementById("launchConnectBtn").addEventListener("click", () => document.getElementById("connectBtn").click());
  const opEl = document.getElementById("operatorAddr");
  if (opEl) opEl.textContent = `(${PROGRAM_ID.toBase58().slice(0, 4)}…${PROGRAM_ID.toBase58().slice(-4)})`;
  connectPrompt.hidden = false;
  formCard.hidden = true;
  onWalletChange((w) => {
    connectPrompt.hidden = !!w;
    formCard.hidden = !w;
  });

  // The coin starts at pump.fun's initial market cap — the target has to be above it.
  let startMcap = null;
  let solUsd = null;
  try {
    [startMcap, solUsd] = await Promise.all([fetchPumpStartMcap(), getSolUsdPrice()]);
  } catch (err) {
    console.warn("Could not read pump.fun's starting market cap", err);
  }
  const usd = (lamports) => (solUsd ? ` (≈ ${formatUsd(lamportsToSol(lamports) * solUsd)})` : "");
  const startUsd = startMcap && solUsd ? lamportsToSol(startMcap) * solUsd : null;
  if (startUsd) {
    targetHint.textContent = `A new pump.fun coin starts around ${formatUsdCompact(startUsd)} market cap. Your target must be higher than that.`;
  } else if (startMcap) {
    targetHint.textContent = `A new pump.fun coin starts around ${formatSol(startMcap, 1)} SOL. Waiting for the SOL price to convert dollars…`;
  }
  function refreshUsdHints() {
    const t = parseUsd(targetInput.value);
    const c = solToLamports(collateralInput.value);
    if (startUsd && t) {
      targetHint.textContent =
        t <= startUsd
          ? `Too low. A new coin already starts around ${formatUsdCompact(startUsd)}.`
          : `Target ${formatUsdCompact(t)}, ${(t / startUsd).toFixed(1)}x where a new coin starts. It's recorded as ${formatSol(usdToLamports(t, solUsd), 2)} SOL at today's price, so its dollar value will move with SOL.`;
    }
    if (c) collateralHint.textContent = `You're putting ${formatSol(c, 3)} SOL${usd(c)} on the line. Miss the target and it's gone. Minimum 0.01 SOL.`;
  }
  // quick-pick chips
  function chips(containerId, items, apply) {
    const box = document.getElementById(containerId);
    box.innerHTML = "";
    for (const [text, value] of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = text;
      b.addEventListener("click", () => {
        apply(value);
        refreshUsdHints();
      });
      box.appendChild(b);
    }
  }
  if (startUsd) {
    const nice = (x) => (x < 10_000 ? Math.round(x / 100) * 100 : x < 100_000 ? Math.round(x / 500) * 500 : Math.round(x / 1000) * 1000);
    chips(
      "targetChips",
      [2, 3, 5, 10, 25].map((m) => {
        const v = nice(startUsd * m);
        return [`${m}x start (${formatUsdCompact(v)})`, String(v)];
      }),
      (v) => (targetInput.value = v)
    );
  }
  chips("collateralChips", ["0.1", "0.5", "1", "2", "5"].map((v) => [`${v} SOL`, v]), (v) => (collateralInput.value = v));
  targetInput.addEventListener("input", refreshUsdHints);
  collateralInput.addEventListener("input", refreshUsdHints);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await isProgramLive())) return showToast("Launches aren't open yet: the Balls contract isn't live on mainnet. Check back soon.");
    const data = new FormData(form);
    const name = data.get("name").toString().trim();
    const symbol = data.get("symbol").toString().trim();
    const description = data.get("description").toString().trim();
    const collateralSol = data.get("collateral").toString().trim();
    const targetUsd = parseUsd(data.get("target").toString());
    const collateral = solToLamports(collateralSol);
    if (!targetUsd) return showToast("Enter the target market cap in dollars, like 25000 or 25k.");
    if (!collateral) return showToast("Enter the bond as a plain number of SOL.");
    if (!solUsd) return showToast("Couldn't load the SOL price to convert your dollar target. Refresh and try again.");
    const target = usdToLamports(targetUsd, solUsd);
    if (collateral < 10_000_000n) return showToast("Collateral must be at least 0.01 SOL.");
    if (startMcap && target <= startMcap) return showToast("Target must be above where a new coin starts.");
    const imageFile = document.getElementById("imageInput").files?.[0] || null;
    const parsed = normalizeLinks({
      website: data.get("website"),
      twitter: data.get("twitter"),
      telegram: data.get("telegram"),
    });
    if (parsed.error) return showToast(parsed.error);

    btn.disabled = true;
    try {
      btn.textContent = imageFile ? "Uploading image…" : "Uploading metadata…";
      // launchCoin uploads metadata first, then asks the wallet to sign the
      // combined create + bond transaction.
      const { txSig, mint } = await launchCoin({ name, symbol, description, imageFile, links: parsed.links, targetLamports: target, collateralSol, onStep: (t) => (btn.textContent = t) });
      console.log("launch tx", txSig, "mint", mint);
      showToast(`${symbol} is live, and the dev has the balls to back it. Redirecting…`);
      window.location.href = `coin.html?mint=${mint}`;
    } catch (err) {
      console.error(err);
      showToast(err.message || "Launch failed.");
      btn.disabled = false;
      btn.textContent = "Launch with my balls";
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNav();
  initLaunchForm();
  initImagePreview();
});
