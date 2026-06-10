import {
  FacilitatorResponseError,
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from "@x402/core/server";
import { FACILITATOR_VERIFY_TIMEOUT_MS } from "@x402-parser/core";

/**
 * Marker message for verify timeouts. The @x402/hono middleware converts any
 * FacilitatorResponseError into a 502 `{ error: message }` response; the
 * outer middleware in index.ts spots this marker and rewrites it to a 503
 * with Retry-After, per the service contract.
 */
export const VERIFY_TIMEOUT_MARKER = "x402-parser:facilitator-verify-timeout";

export class FacilitatorTimeoutError extends FacilitatorResponseError {
  constructor() {
    super(VERIFY_TIMEOUT_MARKER);
    this.name = "FacilitatorTimeoutError";
  }
}

/**
 * Wraps the HTTP facilitator client with a hard deadline on verify().
 * Settlement is left untimed: it runs after the response body is built, and
 * aborting a settle mid-flight risks charging the buyer without replying.
 */
export class TimeoutFacilitatorClient implements FacilitatorClient {
  private readonly inner: HTTPFacilitatorClient;

  constructor(url: string) {
    this.inner = new HTTPFacilitatorClient({ url });
  }

  verify(...args: Parameters<FacilitatorClient["verify"]>) {
    return withDeadline(
      this.inner.verify(...args),
      FACILITATOR_VERIFY_TIMEOUT_MS,
      () => new FacilitatorTimeoutError(),
    );
  }

  settle(...args: Parameters<FacilitatorClient["settle"]>) {
    return this.inner.settle(...args);
  }

  getSupported() {
    return this.inner.getSupported();
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
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
