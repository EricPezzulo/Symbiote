import type { Logger } from "../types.js";

export type HttpOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Total attempts = 1 + retries. Retries cover network errors, timeouts, 408/429/5xx. */
  retries?: number;
  /** Use ETag / If-Modified-Since from the previous successful response for this URL key. */
  conditional?: boolean;
  /** Key for conditional-request state (defaults to the URL). */
  key?: string;
  maxBytes?: number;
};

export type HttpResult = { notModified: true } | { notModified: false; status: number; body: string };

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type HttpDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  userAgent: string;
  log: Logger;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
};

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Small fetch wrapper: timeouts, retry with exponential backoff (honours Retry-After), conditional GET. Never logs URLs with queries. */
export class Http {
  private readonly validators = new Map<string, { etag?: string; lastModified?: string }>();
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: HttpDeps) {
    this.doFetch = d.fetch ?? fetch;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async get(url: string, o: HttpOptions = {}): Promise<HttpResult> {
    const retries = o.retries ?? 2;
    const base = this.d.backoffBaseMs ?? 1000;
    const max = this.d.backoffMaxMs ?? 30_000;
    const key = o.key ?? url;
    const host = new URL(url).host;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const headers: Record<string, string> = { "user-agent": this.d.userAgent, accept: "application/json, application/xml, application/atom+xml, application/rss+xml, text/xml;q=0.9, */*;q=0.5", ...o.headers };
      const v = o.conditional ? this.validators.get(key) : undefined;
      if (v?.etag) headers["if-none-match"] = v.etag;
      if (v?.lastModified) headers["if-modified-since"] = v.lastModified;
      let waitMs = Math.min(max, base * 2 ** attempt);
      try {
        const res = await this.doFetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
        if (res.status === 304) return { notModified: true };
        if (res.ok) {
          const body = await res.text();
          if (o.maxBytes && body.length > o.maxBytes) throw new HttpError(413, `response from ${host} too large`);
          if (o.conditional) {
            const etag = res.headers.get("etag") ?? undefined;
            const lastModified = res.headers.get("last-modified") ?? undefined;
            if (etag || lastModified) this.validators.set(key, { etag, lastModified });
          }
          return { notModified: false, status: res.status, body };
        }
        const err = new HttpError(res.status, `HTTP ${res.status} from ${host}`);
        if (!RETRYABLE.has(res.status)) throw err;
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) waitMs = Math.min(max, ra * 1000);
        lastErr = err;
      } catch (e) {
        if (e instanceof HttpError && !RETRYABLE.has(e.status)) throw e;
        lastErr = e instanceof HttpError ? e : new Error(`request to ${host} failed: ${e instanceof Error ? e.name : "error"}`);
      }
      if (attempt < retries) {
        this.d.log.debug("retrying request", { host, attempt: attempt + 1, waitMs });
        await this.sleep(waitMs);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`request to ${host} failed`);
  }
}
