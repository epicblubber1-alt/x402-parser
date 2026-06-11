export interface Env {
  /** Receiving wallet address (0x…). Address only — the seller never holds wallet keys. */
  PAYMENT_ADDRESS: string;
  /** "eip155:84532" (Base Sepolia, default) or "eip155:8453" (Base mainnet). */
  NETWORK?: string;
  /** x402 facilitator base URL — testnet only; mainnet always uses the CDP facilitator. */
  FACILITATOR_URL?: string;
  /** CDP API credentials (Worker secrets, mainnet only) for the Coinbase facilitator. */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /** Replay-protection + rate-limit storage. */
  PARSER_KV: KVNamespace;
  /** Edge per-IP throttle (Workers Rate Limiting API) for unpaid floods. */
  IP_RATE_LIMIT: RateLimit;
}
