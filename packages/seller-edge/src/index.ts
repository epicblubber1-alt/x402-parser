import { Hono } from "hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  MAX_DOCUMENT_BYTES,
  NETWORK,
  PRICE_USD,
  RATE_LIMIT_PER_HOUR,
  SHA256_HEADER,
  sha256Hex,
  type ErrorResponse,
  type HealthResponse,
  type ParseResponse,
} from "@x402-parser/core";
import type { Env } from "./env.ts";
import { TimeoutFacilitatorClient, VERIFY_TIMEOUT_MARKER } from "./facilitator.ts";
import { ParseFailedError, parsePdf } from "./parser.ts";
import {
  paymentProofId,
  rateLimitGuard,
  recordPaymentProof,
  replayGuard,
  shaHeaderGuard,
  sizeGuard,
} from "./guards.ts";

const VERSION = "0.1.0";
// Public Coinbase-run testnet facilitator. facilitator.x402.org (the v2 docs
// default) was returning internal errors as of 2026-06; the x402.org path is
// the same service and answers directly without a redirect hop.
const DEFAULT_FACILITATOR_URL = "https://www.x402.org/facilitator";

type Ctx = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Free routes
// ---------------------------------------------------------------------------

app.get("/health", (c) => {
  const body: HealthResponse = { status: "ok", version: VERSION, network: NETWORK };
  return c.json(body);
});

app.get("/", (c) =>
  c.text(`x402 Fast PDF Parser v${VERSION} (TESTNET)

Pay-per-use PDF text extraction over the x402 payment protocol.
Born-digital PDFs only (no OCR). Speed is the product: every response
includes parse_ms so you can hold us to it.

ENDPOINT
  POST /parse
    Content-Type:      application/pdf   (raw PDF bytes, max ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB)
    ${SHA256_HEADER}: hex SHA-256 of the uploaded bytes (required)
  -> 200 JSON: { "text": "...", "pages": 12, "parse_ms": 38, "sha256": "..." }

PRICE
  ${PRICE_USD} USDC per document on Base Sepolia (${NETWORK}). Testnet only —
  this service accepts no real money.

HOW TO PAY (agents)
  1. POST your document. You'll get HTTP 402 with x402 payment requirements.
  2. Sign the payment with any x402 v2 client (e.g. @x402/fetch wrapping fetch,
     funded by a Base Sepolia USDC wallet) and retry with the payment header.
  3. The response settles on-chain automatically; the receipt is in the
     X-PAYMENT-RESPONSE header.

RULES
  - One payment proof per document: replays within 10 minutes get 409.
  - ${RATE_LIMIT_PER_HOUR} requests/hour per paying wallet, then 429.
  - Malformed/unparseable PDFs get 422 (you are not charged: payment only
    settles after a successful parse).

OTHER ROUTES
  GET /health  — free liveness check.
`),
);

// ---------------------------------------------------------------------------
// Paid route: guards -> x402 payment -> parse
// ---------------------------------------------------------------------------

/**
 * The x402 middleware needs PAYMENT_ADDRESS and the facilitator URL, which
 * only exist on c.env in Workers — so build it on first request and cache it
 * for the isolate's lifetime.
 */
let cachedPaymentMiddleware: MiddlewareHandler | null = null;

function getPaymentMiddleware(env: Env): MiddlewareHandler {
  if (!cachedPaymentMiddleware) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAYMENT_ADDRESS ?? "")) {
      throw new Error("PAYMENT_ADDRESS env var must be a 0x wallet address");
    }
    const facilitator = new TimeoutFacilitatorClient(env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL);
    const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
    cachedPaymentMiddleware = paymentMiddleware(
      {
        "POST /parse": {
          accepts: {
            scheme: "exact",
            price: PRICE_USD,
            network: NETWORK,
            payTo: env.PAYMENT_ADDRESS as `0x${string}`,
          },
          description: "Fast PDF text extraction (born-digital, no OCR)",
          mimeType: "application/json",
        },
      },
      resourceServer,
    );
  }
  return cachedPaymentMiddleware;
}

const paymentGate: MiddlewareHandler = (c: Ctx, next: Next) => getPaymentMiddleware(c.env)(c, next);

/**
 * The x402 middleware reports facilitator failures as 502; our verify
 * deadline tags its timeout with a marker message so it can be told apart
 * from genuine facilitator errors and rewritten to 503 + Retry-After.
 */
async function verifyTimeoutTo503(c: Ctx, next: Next) {
  await next();
  if (c.res.status === 502) {
    const body = (await c.res.clone().json().catch(() => null)) as ErrorResponse | null;
    if (body?.error === VERIFY_TIMEOUT_MARKER) {
      c.res = undefined as unknown as Response;
      c.res = Response.json(
        { error: "facilitator_unavailable", detail: "Payment verification timed out; retry shortly" },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
  }
}

app.on(
  "POST",
  "/parse",
  verifyTimeoutTo503,
  sizeGuard,
  shaHeaderGuard,
  replayGuard,
  rateLimitGuard,
  paymentGate,
  async (c: Ctx) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      // Content-Length lied; enforce on actual bytes too.
      return c.json(
        { error: "payload_too_large", detail: `Documents are limited to ${MAX_DOCUMENT_BYTES} bytes` },
        413,
      );
    }
    if (bytes.byteLength === 0) {
      return c.json({ error: "empty_body", detail: "Send raw PDF bytes as the request body" }, 400);
    }

    const sha256 = await sha256Hex(bytes);
    const declared = c.req.header(SHA256_HEADER)!.toLowerCase();
    if (sha256 !== declared) {
      return c.json(
        { error: "sha256_mismatch", detail: `${SHA256_HEADER} does not match the uploaded bytes` },
        400,
      );
    }

    let parsed;
    try {
      parsed = await parsePdf(bytes);
    } catch (err) {
      const detail = err instanceof ParseFailedError ? err.message : "unparseable document";
      return c.json({ error: "unparseable_document", detail }, 422);
    }

    // Burn the payment proof only after a successful parse, so failed
    // requests (4xx never settle) can be retried with the same proof.
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment");
    if (paymentHeader) {
      await recordPaymentProof(c.env.PARSER_KV, await paymentProofId(paymentHeader));
    }

    const body: ParseResponse = { ...parsed, sha256 };
    return c.json(body);
  },
);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("unhandled error:", err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
