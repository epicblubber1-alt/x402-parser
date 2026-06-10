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

/** KV value once a proof has produced a successful (settling) parse. */
const PROOF_USED = "used";

/**
 * Reject already-seen payment proofs (409) before spending a facilitator
 * round-trip on them. The x402 exact-scheme payload signs only the EIP-3009
 * transfer fields — nothing in the proof references the document — so we
 * bind proof -> document SHA ourselves on first verified use (see the /parse
 * handler). A proof that already paid out is dead ("used"); a proof bound to
 * a different document is rejected so one payment can't be shopped across
 * payloads until one parses. Retrying the SAME document after a 422/failed
 * settle stays allowed. Requests without a payment header fall through — the
 * x402 middleware owns the 402 challenge. Runs after shaHeaderGuard, so the
 * declared SHA is present and well-formed here.
 */
export async function replayGuard(c: Ctx, next: Next) {
  const paymentHeader = getPaymentHeader(c);
  if (paymentHeader) {
    const proofId = await paymentProofId(paymentHeader);
    const seen = await c.env.PARSER_KV.get(replayKey(proofId));
    if (seen === PROOF_USED) {
      return c.json({ error: "replayed_payment", detail: "This payment proof was already used" }, 409);
    }
    const declaredSha = c.req.header(SHA256_HEADER)!.toLowerCase();
    if (seen && seen !== declaredSha) {
      return c.json(
        { error: "replayed_payment", detail: "This payment proof is bound to a different document" },
        409,
      );
    }
  }
  return next();
}

export function replayKey(proofId: string): string {
  return `replay:${proofId}`;
}

/** Bind a verified proof to the document it was first used with (pre-parse). */
export async function bindPaymentProof(kv: KVNamespace, proofId: string, sha256: string): Promise<void> {
  await kv.put(replayKey(proofId), sha256, { expirationTtl: REPLAY_TTL_SECONDS });
}

/** Mark a proof as fully consumed after a successful parse. */
export async function recordPaymentProof(kv: KVNamespace, proofId: string): Promise<void> {
  await kv.put(replayKey(proofId), PROOF_USED, { expirationTtl: REPLAY_TTL_SECONDS });
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
