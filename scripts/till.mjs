// Daily revenue check: `npm run till`
//
// Read-only. Queries Base mainnet over the public RPC (no keys, no
// transactions) for USDC Transfer events paying the seller address, reports
// what arrived since the last run, and pings the mainnet Worker's /health.
// State (last scanned block + every payer ever seen) lives in
// .till-state.json at the repo root, gitignored.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYMENT_ADDRESS = "0xa7737300F4A0dDB4aF3fA6e2D886D0dE37e01e08";
const HEALTH_URL = "https://x402-parser-edge-mainnet.epicblubber.workers.dev/health";
// Block of the service's first-ever settlement — the baseline for run #1.
const FIRST_SETTLEMENT_BLOCK = 47179450;
const CHUNK = 5_000; // public-RPC-friendly eth_getLogs range

const BENCH_WALLETS = new Set([
  "0x8b9b71108532a6e538e8dcf36096df32ba8d5d63",
  "0x6979aaa1231a5e4048aeea44f079bc5caa0e3513",
  "0xef2a46aaf2bf5645bb6b08d1795ffdcf87a0795f",
]);

const STATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".till-state.json");

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function pad32(address) {
  return "0x" + address.toLowerCase().replace("0x", "").padStart(64, "0");
}

/** eth_getLogs over [from, to], halving the range on provider limits. */
async function getLogsChunked(from, to) {
  if (from > to) return [];
  try {
    return await rpc("eth_getLogs", [
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, null, pad32(PAYMENT_ADDRESS)],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      },
    ]);
  } catch (err) {
    if (to - from < 10) throw err; // not a range problem
    const mid = Math.floor((from + to) / 2);
    return [...(await getLogsChunked(from, mid)), ...(await getLogsChunked(mid + 1, to))];
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return { lastBlock: FIRST_SETTLEMENT_BLOCK - 1, lastRunAt: null, seenPayers: {} };
  }
}

function usd(microUsdc) {
  return (Number(microUsdc) / 1e6).toFixed(3);
}

async function main() {
  const state = await loadState();
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const from = state.lastBlock + 1;

  // Health ping first — if the till is open but the shop is down, lead with it.
  let health = "UNREACHABLE";
  try {
    const h = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    health = `${h.status} (${h.network}, v${h.version})`;
  } catch {
    /* reported as UNREACHABLE */
  }

  console.log(`x402-parser till — blocks ${from}..${latest}` + (state.lastRunAt ? ` (last till: ${state.lastRunAt})` : " (first run)"));
  console.log(`mainnet /health: ${health}\n`);

  const logs = [];
  for (let start = from; start <= latest; start += CHUNK) {
    logs.push(...(await getLogsChunked(start, Math.min(start + CHUNK - 1, latest))));
  }

  const payments = logs.map((l) => ({
    payer: "0x" + l.topics[1].slice(26),
    microUsdc: BigInt(l.data),
    block: parseInt(l.blockNumber, 16),
    tx: l.transactionHash,
  }));

  const bench = payments.filter((p) => BENCH_WALLETS.has(p.payer));
  const real = payments.filter((p) => !BENCH_WALLETS.has(p.payer));

  const byPayer = new Map();
  for (const p of real) {
    const cur = byPayer.get(p.payer) ?? { count: 0, microUsdc: 0n };
    byPayer.set(p.payer, { count: cur.count + 1, microUsdc: cur.microUsdc + p.microUsdc });
  }
  const total = real.reduce((acc, p) => acc + p.microUsdc, 0n);

  console.log(`${real.length} payment(s), $${usd(total)} USDC, ${byPayer.size} distinct payer(s)`);
  if (bench.length > 0) {
    const benchTotal = bench.reduce((acc, p) => acc + p.microUsdc, 0n);
    console.log(`bench wallets (excluded above): ${bench.length} payment(s), $${usd(benchTotal)} USDC`);
  }

  // The one signal that matters: wallets seen in a PREVIOUS run, back again.
  const repeats = [...byPayer.keys()].filter((payer) => state.seenPayers[payer]);
  if (repeats.length > 0) {
    console.log(`\n*** REPEAT BUYER(S): ${repeats.length} ***`);
    for (const payer of repeats) {
      const prev = state.seenPayers[payer];
      const now = byPayer.get(payer);
      console.log(
        `  ${payer} — ${now.count} new payment(s), $${usd(now.microUsdc)} this run; ` +
          `${prev.count} payment(s), $${usd(BigInt(prev.microUsdc))} before (first seen ${prev.firstSeen})`,
      );
    }
  } else if (byPayer.size > 0) {
    console.log("\nno repeat buyers yet — all payers this run are new");
  }

  for (const [payer, agg] of byPayer) {
    if (!repeats.includes(payer)) console.log(`  new payer: ${payer} — ${agg.count} payment(s), $${usd(agg.microUsdc)}`);
  }

  // Persist: advance the block cursor, fold this run's payers into the registry.
  for (const [payer, agg] of byPayer) {
    const prev = state.seenPayers[payer];
    state.seenPayers[payer] = {
      firstSeen: prev?.firstSeen ?? new Date().toISOString().slice(0, 10),
      count: (prev?.count ?? 0) + agg.count,
      microUsdc: String(BigInt(prev?.microUsdc ?? 0) + agg.microUsdc),
    };
  }
  state.lastBlock = latest;
  state.lastRunAt = new Date().toISOString();
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error("till failed:", err.message);
  process.exit(1);
});
