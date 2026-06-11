// One-shot paid smoke test (TESTNET): pay -> parse -> 200, then replay the
// exact same payment proof -> 409. Uses wallet 1 from BENCH_PRIVATE_KEYS.
//   BENCH_URL=... BENCH_PRIVATE_KEYS=0x... node bench/smoke.mjs
import "dotenv/config";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_URL = process.env.BENCH_URL;
const key = (process.env.BENCH_PRIVATE_KEYS ?? "").split(",")[0]?.trim();
if (!BENCH_URL || !key) {
  console.error("Set BENCH_URL and BENCH_PRIVATE_KEYS in bench/.env");
  process.exit(1);
}

const account = privateKeyToAccount(key);
console.log(`buyer wallet: ${account.address}`);

// Mainnet targets spend real USDC — require the explicit flag, mirror bench.mjs.
const health = await fetch(`${BENCH_URL}/health`).then((r) => r.json());
const NETWORK = health.network;
if (NETWORK === "eip155:8453" && !process.argv.includes("--mainnet")) {
  console.error(`${BENCH_URL} is a Base MAINNET deployment (real USDC). Re-run with --mainnet to spend $0.002.`);
  process.exit(1);
}

// Capture the payment header the client attaches so we can replay it
// verbatim. The wrapper may call fetch(Request) or fetch(url, init) — check
// both places for the header.
let capturedPayment = null;
const capturingFetch = (input, init = {}) => {
  const headers = new Headers(input instanceof Request ? input.headers : init.headers);
  const payment = headers.get("X-PAYMENT") ?? headers.get("payment-signature");
  if (payment) capturedPayment = payment;
  return fetch(input, init);
};

const paidFetch = wrapFetchWithPaymentFromConfig(capturingFetch, {
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
});

const samples = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
const bytes = await readFile(path.join(samples, "text-2p.pdf"));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const headers = { "Content-Type": "application/pdf", "X-Document-SHA256": sha256 };

console.log("\n[1/2] paid parse (402 -> sign -> retry expected) ...");
const t0 = performance.now();
const res = await paidFetch(`${BENCH_URL}/parse`, { method: "POST", headers, body: bytes });
const totalMs = (performance.now() - t0).toFixed(0);
const body = await res.json();
if (res.status !== 200) {
  console.error(`FAIL: expected 200, got ${res.status}:`, body);
  process.exit(1);
}
console.log(
  `OK 200 in ${totalMs}ms total — pages=${body.pages} parse_ms=${body.parse_ms} ` +
    `text_len=${body.text.length} sha_match=${body.sha256 === sha256}`,
);
console.log("\n--- parsed text ---\n" + body.text);
console.log("response headers:", [...res.headers.keys()].join(", "));

console.log("\n[2/2] replaying the same payment proof (409 expected) ...");
if (!capturedPayment) {
  console.error("FAIL: never captured a payment header");
  process.exit(1);
}
const replay = await fetch(`${BENCH_URL}/parse`, {
  method: "POST",
  headers: { ...headers, "X-PAYMENT": capturedPayment },
  body: bytes,
});
const replayBody = await replay.json();
if (replay.status !== 409) {
  console.error(`FAIL: expected 409, got ${replay.status}:`, replayBody);
  process.exit(1);
}
console.log(`OK 409 — ${replayBody.detail}`);
console.log("\nSmoke test passed.");
