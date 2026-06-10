import type { Context, Next } from "hono";
import {
  MAX_DOCUMENT_BYTES,
  RATE_LIMIT_PER_HOUR,
  REPLAY_TTL_SECONDS,
  SHA256_HEADER,
  decodePayerAddress,
  isSha256Hex,
  sha256HexOfString,
} from "@x402-parser/core";
import type { Env } from "./env.ts";

type Ctx = Context<{ Bindings: Env }>;

function getPaymentHeader(c: Ctx): string | undefined {
  return c.req.header("payment-signature") ?? c.req.header("x-payment");
}

/** Reject oversized uploads before any payment work. */
export async function sizeGuard(c: Ctx, next: Next) {
  const contentLength = c.req.header("content-length");
  if (!contentLength) {
    return c.json({ error: "length_required", detail: "Content-Length header is required" }, 411);
  }
  if (Number(contentLength) > MAX_DOCUMENT_BYTES) {
    return c.json(
      { error: "payload_too_large", detail: `Documents are limited to ${MAX_DOCUMENT_BYTES} bytes` },
      413,
    );
  }
  return next();
}

/** Require a well-formed X-Document-SHA256 up front (verified against bytes later). */
export async function shaHeaderGuard(c: Ctx, next: Next) {
  const declared = c.req.header(SHA256_HEADER);
  if (!declared || !isSha256Hex(declared)) {
    return c.json(
      { error: "missing_document_sha256", detail: `${SHA256_HEADER} header (hex SHA-256 of the upload) is required` },
      400,
    );
  }
  return next();
}

/** Stable replay ID for a payment proof: hash of the raw payment header. */
export function paymentProofId(paymentHeader: string): Promise<string> {
  return sha256HexOfString(paymentHeader);
}

/**
 * Reject already-seen payment proofs (409) before spending a facilitator
 * round-trip on them. The proof is recorded by the /parse handler only after
 * a successful parse, so a request that fails pre-settlement can be retried
 * with the same proof. Requests without a payment header fall through — the
 * x402 middleware owns the 402 challenge.
 */
export async function replayGuard(c: Ctx, next: Next) {
  const paymentHeader = getPaymentHeader(c);
  if (paymentHeader) {
    const proofId = await paymentProofId(paymentHeader);
    if (await c.env.PARSER_KV.get(replayKey(proofId))) {
      return c.json({ error: "replayed_payment", detail: "This payment proof was already used" }, 409);
    }
  }
  return next();
}

export function replayKey(proofId: string): string {
  return `replay:${proofId}`;
}

export async function recordPaymentProof(kv: KVNamespace, proofId: string): Promise<void> {
  await kv.put(replayKey(proofId), "1", { expirationTtl: REPLAY_TTL_SECONDS });
}

/**
 * Per-payer-wallet hourly rate limit. The payer address is read from the
 * (unverified) payment payload — good enough for throttling, since a forged
 * address still fails facilitator verification and costs the caller a 402.
 * KV counters are eventually consistent; the limit is approximate by design.
 */
export async function rateLimitGuard(c: Ctx, next: Next) {
  const paymentHeader = getPaymentHeader(c);
  if (paymentHeader) {
    const payer = decodePayerAddress(paymentHeader);
    if (payer) {
      const hourBucket = Math.floor(Date.now() / 3_600_000);
      const key = `rate:${payer}:${hourBucket}`;
      const count = Number((await c.env.PARSER_KV.get(key)) ?? "0");
      if (count >= RATE_LIMIT_PER_HOUR) {
        c.header("Retry-After", "3600");
        return c.json(
          { error: "rate_limited", detail: `Limit is ${RATE_LIMIT_PER_HOUR} requests/hour per wallet` },
          429,
        );
      }
      await c.env.PARSER_KV.put(key, String(count + 1), { expirationTtl: 7_200 });
    }
  }
  return next();
}
