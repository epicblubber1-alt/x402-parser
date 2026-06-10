# x402 Fast PDF Parser

Pay-per-use PDF text extraction sold over the [x402 payment protocol](https://docs.x402.org).
Agents pay **$0.002 testnet USDC** per document on **Base Sepolia** and get structured
text back. Speed is the product: every response carries `parse_ms`, and the target is
sub-second p95 for born-digital PDFs under 5MB.

> **TESTNET ONLY.** This repo contains no mainnet configuration and accepts no real
> money. The seller holds a receiving wallet *address* only — no private keys.

## Status

- ✅ **Phase 1** — edge seller: Cloudflare Worker, Hono, `@x402/hono` v2 middleware,
  LiteParse WASM, public testnet facilitator. *(this repo, current)*
- ⬜ Phase 2 — heavy path (Rust Lambda + OCR) for >5MB / `?ocr=true`
- ⬜ Phase 3 — buyer agent (x402 client, doubles as integration test)

Note: the spec named the `x402-hono` package; that v1 SDK is deprecated upstream
(security patches only), so this uses its successor `@x402/hono` v2. Same protocol,
same flow, current header names (`PAYMENT-REQUIRED` / `X-PAYMENT`).

## API

| Route | Price | Description |
|---|---|---|
| `POST /parse` | $0.002 USDC | Raw PDF bytes in, JSON text out |
| `GET /health` | free | Liveness + version |
| `GET /` | free | Human/agent-readable service description |

### `POST /parse`

Request:
- `Content-Type: application/pdf`, raw PDF bytes as the body (max 10MB)
- `X-Document-SHA256: <hex sha256 of the bytes>` — required
- `X-PAYMENT: <x402 payment>` — obtained from the 402 challenge

Success (200):

```json
{ "text": "…full document text…", "pages": 50, "parse_ms": 79, "sha256": "ab34…" }
```

`pages` is the page count. `parse_ms` measures only the parser, so payment and
network overhead are visible by subtraction in the bench. **Production caveat:**
Cloudflare Workers freeze in-request clocks during CPU execution (Spectre
mitigation; time only advances on I/O), so deployed `parse_ms` reads ~0. It is
accurate under local `wrangler dev` and will be accurate on the Phase 2 Lambda
path; at the edge, total latency is the honest number.

Errors (always JSON, never a raw parser 500):

| Status | Meaning |
|---|---|
| 400 | Missing/invalid `X-Document-SHA256`, or it doesn't match the bytes |
| 402 | No/invalid payment — challenge is in the `PAYMENT-REQUIRED` response header (base64 JSON) |
| 409 | Replayed payment proof (seen in the last 10 minutes) |
| 411 / 413 | Missing `Content-Length` / document over 10MB |
| 422 | Unparseable PDF or parse exceeded the 5s deadline (payment does **not** settle) |
| 429 | Wallet over 50 requests/hour |
| 503 | Facilitator verification timed out (2s budget) — retry per `Retry-After` |

### Request ordering (the paid path)

1. `Content-Length` ≤ 10MB, else 413 — before any payment work
2. `X-Document-SHA256` well-formed, else 400
3. Payment proof not already consumed, and not bound to a *different* document (KV, 10-min TTL), else 409 — before burning a facilitator round trip
4. Payer wallet under 50 req/hour, else 429
5. x402 middleware: missing payment → 402 challenge; facilitator verify with a 2s deadline → 503 + `Retry-After` on breach
6. The verified proof is bound to the document's SHA-256 (the x402 `exact` payload signs only the transfer, not the payload, so the seller enforces this binding), then parse inside a 5s jail → 422 on malformed input
7. Settlement happens only after a successful (2xx) parse, so failed requests never charge the buyer; the proof is fully burned on success. A 422 can be retried with the *same* document, but one proof can't be shopped across different payloads until one parses

## Setup

```bash
npm install --legacy-peer-deps   # @x402/hono's optional React paywall confuses npm's resolver
npm run typecheck
```

### Deploy the seller (Cloudflare)

```bash
cd packages/seller-edge
npx wrangler kv namespace create PARSER_KV   # paste the id into wrangler.toml
# edit wrangler.toml: set PAYMENT_ADDRESS to your Base Sepolia receiving address
npx wrangler deploy
```

Notes:
- `nodejs_compat` is required (the x402 middleware uses `Buffer`).
- The `[limits] cpu_ms` block needs the Workers Paid plan; on the free plan remove it
  and expect big documents to hit the 10ms CPU ceiling.
- The WASM parser is ~2MB gzipped, within the paid-plan bundle limit.

### Local dev

```bash
npm run dev                                  # full app on :8787 (payment-gated)
npx wrangler dev src/dev-entry.ts            # dev-only unpaid parse route for WASM smoke tests
```

`src/dev-entry.ts` is never referenced by `wrangler.toml`, is imported by no other
module, and refuses to answer on non-loopback hosts even if deployed by mistake.

## Paying (until the Phase 3 buyer lands)

Any x402 v2 client works. The bench script is a minimal example using `@x402/fetch`:

```ts
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
});
```

Fund a throwaway wallet with Base Sepolia ETH (gasless transfers — the facilitator
settles) and testnet USDC from the [Circle faucet](https://faucet.circle.com/).

## Benchmark

```bash
node bench/make-pdfs.mjs                     # writes bench/samples/*.pdf
cp bench/.env.example bench/.env             # set BENCH_URL + BENCH_PRIVATE_KEYS
node bench/bench.mjs                         # 50 paid runs per document
```

Pass one funded key per document (`BENCH_PRIVATE_KEYS=0xa,0xb,0xc`) or the
50/hour/wallet rate limit trips mid-run. Keys live in `bench/.env` (gitignored) only.

**Total** is the full paid exchange (POST → 402 → sign → retry → 200);
**parse** is server-reported `parse_ms`. The difference is what x402 costs you.

### Results (testnet, paid end-to-end) — 2026-06-09, 50 runs/doc, US West client

| document | size | runs ok | total p50 | total p95 | total p99 | parse p50 | parse p95 | parse p99 |
|---|---|---|---|---|---|---|---|---|
| text-2p.pdf | 0.00MB | 48/50 | 1427ms | 2095ms | 2160ms | 0ms | 0ms | 0ms |
| text-50p.pdf | 0.05MB | 48/50 | 1676ms | 2167ms | 2234ms | 0ms | 0ms | 0ms |
| text-5mb.pdf | 4.69MB | 49/50 | 3681ms | 4124ms | 4397ms | 0ms | 0ms | 0ms |

What the numbers actually say:

- **Parsing is not the cost — x402 is.** Server parse time is 6–79ms locally
  (production `parse_ms` reads 0 due to the frozen-clock caveat above), while the
  paid exchange p50 is ~1.4s: a 402 round trip, client-side signing, facilitator
  *verify*, and a synchronous on-chain *settle* before the response returns.
  The original sub-second p95 target holds for parsing, not for the full paid
  exchange — closing the gap means async settlement or challenge caching, which
  is future work, not Phase 1.
- **Big documents pay double transit.** The 402 challenge request uploads the
  full body once before payment, the paid retry uploads it again — that's most
  of the 5MB doc's extra ~2s, not parse time.
- **Failure accounting:** the 2-page doc's two misses were 429s (the smoke test
  had already spent 2 of that wallet's 50/hour budget — the rate limiter doing
  its job); the other three were transient facilitator verify failures (~2%,
  402 on the paid retry, buyer not charged, no client-side retry in the bench).

## Honest limitations

- The 5s parse deadline can't preempt WASM mid-instruction; it bounds the wait and
  the Workers CPU limit backstops pathological files.
- KV rate-limit counters are eventually consistent — the 50/hour limit is approximate.
- Replay protection covers the KV TTL window (10 min); the on-chain nonce in the
  `exact` scheme prevents true double-spends beyond it.
- The KV replay guard is eventually consistent (~60s) across edge locations: two
  near-simultaneous requests with the same proof at different PoPs can both reach
  the parser. Worst case is one wasted parse — never a double-settle, because the
  EIP-3009 nonce can only settle once on-chain; the loser gets a settlement failure.
- If settlement fails *after* a successful parse, the proof is already marked used —
  the buyer got the goods but the seller may not get paid. Acceptable at $0.002.
- The payer address used for rate limiting is read from the unverified payment header;
  forging it only earns the forger a 402.

## Repo layout

```
packages/core/         shared types, limits, hashing
packages/seller-edge/  the Worker (Hono + @x402/hono + LiteParse WASM)
packages/seller-lambda/  (Phase 2, not started)
bench/                 sample-PDF generator + paid latency benchmark
```
