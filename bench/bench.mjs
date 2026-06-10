// Latency benchmark for the x402 PDF parser (TESTNET).
//
// Usage:
//   BENCH_URL=https://<worker>.workers.dev \
//   BENCH_PRIVATE_KEYS=0xkey1,0xkey2,0xkey3 \
//   node bench/bench.mjs [runs-per-doc]
//
// Each run is a full paid exchange: POST -> 402 challenge -> sign -> retry.
// The seller rate-limits 50 req/hour per wallet, so pass one funded Base
// Sepolia key per document (3 docs x 50 runs). Keys live in .env only.
import "dotenv/config";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
const NETWORK = "eip155:84532"; // Base Sepolia — testnet only
const DOCS = ["text-2p.pdf", "text-50p.pdf", "text-5mb.pdf"];

const BENCH_URL = process.env.BENCH_URL;
const RUNS = Number(process.argv[2] ?? process.env.BENCH_RUNS ?? 50);
const keys = (process.env.BENCH_PRIVATE_KEYS ?? process.env.BENCH_PRIVATE_KEY ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

if (!BENCH_URL || keys.length === 0) {
  console.error("Set BENCH_URL and BENCH_PRIVATE_KEYS (comma-separated testnet keys).");
  process.exit(1);
}
if (keys.length < DOCS.length && RUNS * DOCS.length > 50) {
  console.warn(
    `Warning: ${keys.length} key(s) for ${RUNS * DOCS.length} paid requests — ` +
      "the 50/hour/wallet rate limit will trip. Pass one key per document.",
  );
}

function paidFetchFor(keyIndex) {
  const account = privateKeyToAccount(keys[keyIndex % keys.length]);
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
  });
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

async function benchDoc(file, paidFetch) {
  const bytes = await readFile(path.join(SAMPLES_DIR, file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const totals = [];
  const parses = [];
  let failures = 0;

  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    try {
      const res = await paidFetch(`${BENCH_URL}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf", "X-Document-SHA256": sha256 },
        body: bytes,
      });
      const elapsed = performance.now() - started;
      if (!res.ok) {
        failures++;
        console.error(`  ${file} run ${i + 1}: HTTP ${res.status} ${await res.text()}`);
        continue;
      }
      const body = await res.json();
      totals.push(elapsed);
      parses.push(body.parse_ms);
    } catch (err) {
      failures++;
      console.error(`  ${file} run ${i + 1}: ${err.message}`);
    }
    process.stdout.write(`\r${file}: ${i + 1}/${RUNS}`);
  }
  process.stdout.write("\n");
  return { file, sizeMB: bytes.length / 1048576, totals, parses, failures };
}

function ms(n) {
  return `${n.toFixed(0)}ms`;
}

async function main() {
  console.log(`Benchmarking ${BENCH_URL} — ${RUNS} runs per document (testnet)\n`);
  const results = [];
  for (let d = 0; d < DOCS.length; d++) {
    results.push(await benchDoc(DOCS[d], paidFetchFor(d)));
  }

  const lines = [
    "| document | size | runs ok | total p50 | total p95 | total p99 | parse p50 | parse p95 | parse p99 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    if (r.totals.length === 0) {
      lines.push(`| ${r.file} | ${r.sizeMB.toFixed(2)}MB | 0/${RUNS} | — | — | — | — | — | — |`);
      continue;
    }
    const t = stats(r.totals);
    const p = stats(r.parses);
    lines.push(
      `| ${r.file} | ${r.sizeMB.toFixed(2)}MB | ${r.totals.length}/${RUNS} ` +
        `| ${ms(t.p50)} | ${ms(t.p95)} | ${ms(t.p99)} ` +
        `| ${ms(p.p50)} | ${ms(p.p95)} | ${ms(p.p99)} |`,
    );
  }

  console.log("\nTotal = full paid exchange (402 challenge + signing + paid retry).");
  console.log("Parse = server-reported parse_ms; the gap is payment + network overhead.\n");
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
