import init, { LiteParse } from "@llamaindex/liteparse-wasm";
// Wrangler compiles .wasm imports to a WebAssembly.Module at deploy time.
import wasmModule from "@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm";
import { PARSE_DEADLINE_MS } from "@x402-parser/core";

export class ParseFailedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ParseFailedError";
  }
}

let wasmReady: Promise<unknown> | null = null;

function ensureWasm(): Promise<unknown> {
  // Lazy so module init stays cheap; cached per isolate across requests.
  wasmReady ??= init({ module_or_path: wasmModule });
  return wasmReady;
}

export interface ParsedDocument {
  text: string;
  pages: number;
  parse_ms: number;
}

/**
 * Parse PDF bytes inside the 5s "parse jail". Malformed input or a blown
 * deadline both surface as ParseFailedError so the route can map them to a
 * clean 422 — the raw parser error never reaches the client as a 500.
 *
 * Note: the deadline cannot interrupt WASM mid-computation (single-threaded
 * isolate); it bounds total wait and lets the Workers CPU limit backstop
 * pathological documents.
 */
export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  await ensureWasm();

  const parser = new LiteParse({ ocrEnabled: false, outputFormat: "json", quiet: true });
  const started = Date.now();
  try {
    const result = await withParseDeadline(parser.parse(bytes));
    const parse_ms = Date.now() - started;

    const text = typeof result?.text === "string" ? result.text : "";
    const pages = Array.isArray(result?.pages) ? result.pages.length : 0;
    return { text, pages, parse_ms };
  } catch (err) {
    if (err instanceof ParseFailedError) throw err;
    throw new ParseFailedError(err instanceof Error ? err.message : "unparseable document");
  } finally {
    parser.free();
  }
}

function withParseDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ParseFailedError(`parse exceeded ${PARSE_DEADLINE_MS}ms deadline`)),
      PARSE_DEADLINE_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
