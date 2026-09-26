import { chromium } from "playwright";
import * as web3 from "@solana/web3.js";
import nacl from "tweetnacl";
const HEL = process.env.HEL;
const kp = web3.Keypair.generate(); // throwaway, unfunded: it can sign but has no SOL, so nothing can be sent
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on("pageerror", (e) => console.log("pageerror:", e.message));
await p.route("https://api.mainnet-beta.solana.com/**", async (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST,OPTIONS" } });
  const r = await fetch(HEL, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
  route.fulfill({ status: r.status, contentType: "application/json", body: await r.text(), headers: { "access-control-allow-origin": "*" } });
});
await p.exposeFunction("__signMsg", (arr) => Array.from(nacl.sign.detached(Uint8Array.from(arr), kp.secretKey)));
await p.exposeFunction("__signTx", (arr) => { const t = web3.Transaction.from(Uint8Array.from(arr)); t.partialSign(kp); return Array.from(t.serialize({ requireAllSignatures: false })); });
await p.addInitScript((pub) => {
  const publicKey = Uint8Array.from(pub);
  const account = { address: "mock", publicKey, chains: ["solana:mainnet"], features: ["solana:signMessage", "solana:signTransaction"] };
  const wallet = {
    version: "1.0.0", name: "Mock Wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
    chains: ["solana:mainnet"], accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: Uint8Array.from(await window.__signMsg(Array.from(i.message))) }))) },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedTransaction: Uint8Array.from(await window.__signTx(Array.from(i.transaction))) }))) },
    },
  };
  const reg = (api) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => reg(e.detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: reg }));
}, Array.from(kp.publicKey.toBytes()));
await p.goto("http://localhost:8000/launch.html");
await p.waitForTimeout(1500);
await p.click("#connectBtn");
await p.waitForFunction(() => document.getElementById("connectBtn").classList.contains("connected"), null, { timeout: 20000 });
console.log("connected via Wallet Standard mock:", await p.locator("#connectBtn").innerText());
const run = async (label) => {
  const res = await p.evaluate(async () => {
    const m = await import("/shared.js");
    try {
      await m.launchCoin({ name: "Mock Launch", symbol: "MOCK", description: "browser test", imageFile: null, links: { website: "https://example.com" }, targetLamports: 200_000_000_000n, collateralSol: "0.01" });
      return "LAUNCHED (unexpected: the mock wallet has no SOL)";
    } catch (e) { return "stopped with: " + (e.message || e); }
  });
  console.log(label.padEnd(30), res.slice(0, 200));
};
await run("1st attempt (fresh upload):");
await run("2nd attempt (same data again):");
await b.close();
