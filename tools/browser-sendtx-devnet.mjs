import { chromium } from "playwright";
import * as web3 from "@solana/web3.js";
import nacl from "tweetnacl";
const HEL = process.env.HEL;
const kp = web3.Keypair.generate(); // throwaway, unfunded: it can sign but has no SOL, so nothing can be sent
import fs from "node:fs"; import os from "node:os";
const funder = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + "/.config/solana/id.json"))));
const dc = new web3.Connection(web3.clusterApiUrl("devnet"), "confirmed");
await web3.sendAndConfirmTransaction(dc, new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: 20_000_000 })), [funder]);
console.log("mock wallet funded on devnet with 0.02 SOL:", kp.publicKey.toBase58().slice(0, 6) + "…");
await new Promise((r) => setTimeout(r, 6000)); // public devnet RPC lags on reads right after a write
console.log("balance seen by the RPC:", await dc.getBalance(kp.publicKey));
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("  [page]", m.text().slice(0, 600)); });
p.on("pageerror", (e) => console.log("pageerror:", e.message));
await p.exposeFunction("__signMsg", (arr) => Array.from(nacl.sign.detached(Uint8Array.from(arr), kp.secretKey)));
await p.exposeFunction("__signTx", (arr) => { const t = web3.Transaction.from(Uint8Array.from(arr)); t.partialSign(kp); return Array.from(t.serialize({ requireAllSignatures: false })); });
await p.addInitScript((pub) => {
  const publicKey = Uint8Array.from(pub);
  const account = { address: "mock", publicKey, chains: ["solana:devnet"], features: ["solana:signMessage", "solana:signTransaction"] };
  const wallet = {
    version: "1.0.0", name: "Mock Wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
    chains: ["solana:devnet"], accounts: [account],
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
await p.goto("http://localhost:8000/launch.html?net=devnet");
await p.waitForTimeout(1500);
await p.click("#connectBtn");
await p.waitForFunction(() => document.getElementById("connectBtn").classList.contains("connected"), null, { timeout: 20000 });
console.log("connected via Wallet Standard mock:", await p.locator("#connectBtn").innerText());
const t0 = Date.now();
const res = await p.evaluate(async () => {
  const m = await import("/shared.js");
  const out = { steps: [] };
  const onStep = (t) => out.steps.push(t);
  try {
    // (a) plain transfer
    const to = m.web3.Keypair.generate().publicKey;
    out.transferSig = await m.sendTx([m.web3.SystemProgram.transfer({ fromPubkey: m.wallet.publicKey, toPubkey: to, lamports: 2_000_000 })], [], onStep);
    // (b) needs a SECOND signer, like a new coin's mint: create an account owned by the system program
    const kp = m.web3.Keypair.generate();
    out.extraSignerSig = await m.sendTx([
      m.web3.SystemProgram.createAccount({ fromPubkey: m.wallet.publicKey, newAccountPubkey: kp.publicKey, lamports: await m.connection.getMinimumBalanceForRentExemption(0), space: 0, programId: m.web3.SystemProgram.programId }),
    ], [kp], onStep);
    out.newAccountExists = !!(await m.connection.getAccountInfo(kp.publicKey));
  } catch (e) { out.error = String(e.message || e); }
  return out;
});
console.log(JSON.stringify(res, null, 2));
console.log("elapsed s:", ((Date.now() - t0) / 1000).toFixed(1));
await b.close();
