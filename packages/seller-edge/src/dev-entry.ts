// DEV ONLY — never referenced by wrangler.toml `main`, never deployed.
// Exposes the parse pipeline without the payment gate so the WASM path can
// be smoke-tested under workerd: npx wrangler dev src/dev-entry.ts
import { Hono } from "hono";
import { sha256Hex } from "@x402-parser/core";
import { ParseFailedError, parsePdf } from "./parser.ts";
import type { Env } from "./env.ts";

const app = new Hono<{ Bindings: Env }>();

// Tripwire: even if this entry is ever deployed by mistake, it only answers
// on a loopback host (wrangler dev), never on a workers.dev/custom domain.
app.use(async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    return c.json({ error: "dev_only", detail: "This entry point is for local development" }, 403);
  }
  return next();
});

app.post("/dev/parse", async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  try {
    const parsed = await parsePdf(bytes);
    return c.json({ ...parsed, sha256: await sha256Hex(bytes) });
  } catch (err) {
    const detail = err instanceof ParseFailedError ? err.message : "unparseable document";
    return c.json({ error: "unparseable_document", detail }, 422);
  }
});

export default app;
