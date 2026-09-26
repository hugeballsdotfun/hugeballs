import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { Connection, clusterApiUrl } from "@solana/web3.js";
async function main() {
  const cluster = (process.env.CLUSTER || "devnet") as "devnet" | "mainnet-beta";
  const c = new Connection(process.env.RPC_URL || clusterApiUrl(cluster), "confirmed");
  const sdk = new OnlinePumpSdk(c);
  const g: any = await sdk.fetchGlobal();
  console.log("createV2Enabled", g.createV2Enabled, "feeRecipient", g.feeRecipient.toBase58());
  console.log("initial vs/vt/supply", g.initialVirtualSolReserves.toString(), g.initialVirtualTokenReserves.toString(), g.tokenTotalSupply.toString());
  console.log("feeBps", g.feeBasisPoints.toString(), "creatorFeeBps", g.creatorFeeBasisPoints.toString());
  console.log("feeRecipients", g.feeRecipients.map((k: any) => k.toBase58()));
  console.log("mayhem", g.mayhemModeEnabled, "cashback", g.isCashbackEnabled, "holderReward", g.isHolderRewardEnabled);
}
main().catch((e) => { console.error(e); process.exit(1); });
