export interface Env {
  /** Receiving wallet address (0x…). Address only — the seller never holds keys. */
  PAYMENT_ADDRESS: string;
  /** x402 facilitator base URL (defaults to the public testnet facilitator). */
  FACILITATOR_URL?: string;
  /** Replay-protection + rate-limit storage. */
  PARSER_KV: KVNamespace;
}
