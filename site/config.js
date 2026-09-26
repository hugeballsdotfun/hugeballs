// Site configuration.
//
// Mainnet RPC. "/rpc" (and "/rpc-ws" for WebSocket) is the site's OWN proxy
// on the server (see deploy/balls.nginx.conf), which holds the real provider
// URL and API key so visitors never see them. Set that up with
// deploy/set-rpc.sh. On localhost (no proxy) the site falls back to Solana's
// public RPC. To point the site at a provider directly instead, put a full
// https URL here — but then the key is visible to everyone.
export const MAINNET_RPC_URL = "/rpc";
export const MAINNET_WS_URL = "/rpc-ws";
