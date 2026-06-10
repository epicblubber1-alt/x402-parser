/**
 * Shared types and helpers for the x402 PDF parser.
 * Runs in both Cloudflare Workers and Node — WebCrypto only, no Node APIs.
 */

// ---------------------------------------------------------------------------
// Limits & pricing (testnet)
// ---------------------------------------------------------------------------

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 413 above this
export const PARSE_DEADLINE_MS = 5_000; // parse jail
export const FACILITATOR_VERIFY_TIMEOUT_MS = 2_000; // 503 + Retry-After on breach
export const REPLAY_TTL_SECONDS = 600; // 10-min window for seen payment proofs
export const RATE_LIMIT_PER_HOUR = 50; // per payer wallet
export const PRICE_USD = "$0.002";
export const NETWORK = "eip155:84532"; // Base Sepolia — testnet only

export const SHA256_HEADER = "X-Document-SHA256";

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

/** Success body returned by POST /parse. */
export interface ParseResponse {
  /** Full extracted document text. */
  text: string;
  /** Number of pages in the document. */
  pages: number;
  /** Milliseconds spent inside the PDF parser only (excludes payment overhead). */
  parse_ms: number;
  /** Hex SHA-256 of the uploaded bytes, echoing X-Document-SHA256. */
  sha256: string;
}

/** Error body for every non-2xx response from /parse. */
export interface ErrorResponse {
  error: string;
  detail?: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  network: typeof NETWORK;
}

// ---------------------------------------------------------------------------
// Hashing / validation
// ---------------------------------------------------------------------------

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** True if `value` looks like a lowercase-or-uppercase hex SHA-256 digest. */
export function isSha256Hex(value: string): boolean {
  return HEX_SHA256.test(value.toLowerCase());
}

/** Hex SHA-256 of raw bytes via WebCrypto. */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const buf = bytes instanceof Uint8Array ? toArrayBuffer(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex SHA-256 of a UTF-8 string (used for payment-proof replay IDs). */
export async function sha256HexOfString(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// x402 payment-header introspection (pre-verification, untrusted)
// ---------------------------------------------------------------------------

/**
 * Best-effort decode of an x402 payment header (base64 JSON) to extract the
 * claimed payer address for rate limiting. The facilitator is the source of
 * truth for validity — treat this as a routing hint only.
 */
export function decodePayerAddress(paymentHeader: string): string | null {
  try {
    const normalized = paymentHeader.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(normalized));
    const from = json?.payload?.authorization?.from;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from)
      ? from.toLowerCase()
      : null;
  } catch {
    return null;
  }
}
