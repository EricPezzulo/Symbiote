import { parseFeed } from "../feed.js";
import { HttpError, type Http } from "../http.js";
import type { RateLimiter } from "./ratelimit.js";
import type { NewsSource, PollContext, RawNewsItem } from "../types.js";

/**
 * SEC EDGAR "browse-edgar" Atom feed of 8-K filings, one request per held/watched STOCK ticker.
 * SEC requires a descriptive User-Agent with contact info and caps clients at 10 requests/second;
 * we pace at ~4/s. Feed is public domain data; no filing text is fetched, only the Atom summary.
 */
export class EdgarSource implements NewsSource {
  readonly name = "sec-edgar";
  readonly category = "company" as const;
  readonly timeoutMs = 15_000;
  private offset = 0;

  constructor(
    private readonly http: Http,
    private readonly limiter: RateLimiter,
    readonly intervalMs = 15 * 60_000,
    private readonly maxTickersPerCycle = 40,
    private readonly maxAgeMs = 7 * 86_400_000,
  ) {}

  enabled() {
    return true;
  }

  async poll(ctx: PollContext): Promise<RawNewsItem[]> {
    const tickers = [...ctx.universe.symbols].filter(([, c]) => c === "stock").map(([s]) => s).filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)).sort();
    if (!tickers.length) return [];
    const slice: string[] = [];
    for (let i = 0; i < Math.min(this.maxTickersPerCycle, tickers.length); i++) slice.push(tickers[(this.offset + i) % tickers.length]);
    this.offset = (this.offset + slice.length) % tickers.length;
    const out: RawNewsItem[] = [];
    let failures = 0;
    for (const sym of slice) {
      await this.limiter.wait();
      const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(sym.replace(".", "-"))}&type=8-K&dateb=&owner=include&count=10&output=atom`;
      try {
        const res = await this.http.get(url, { conditional: true, timeoutMs: this.timeoutMs, maxBytes: 2_000_000 });
        if (res.notModified) continue;
        for (const e of parseFeed(res.body, 800)) {
          const ts = e.published ? Date.parse(e.published) : NaN;
          if (!e.link || (Number.isFinite(ts) && ctx.now - ts > this.maxAgeMs)) continue;
          const items = [...new Set([...e.summary.matchAll(/Item\s+(\d\.\d\d)/g)].map((m) => m[1]))];
          const day = Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "recent";
          out.push({
            source: this.name,
            externalId: e.id,
            url: e.link,
            title: `${sym} files Form 8-K${items.length ? ` (Items ${items.join(", ")})` : ""} on ${day}`,
            summary: e.summary,
            publishedAt: e.published,
            category: "company",
            symbols: [sym],
          });
        }
      } catch (err) {
        failures++;
        ctx.log.warn("edgar request failed", { symbol: sym, error: err instanceof Error ? err.message : String(err) });
        if (err instanceof HttpError && (err.status === 403 || err.status === 429)) break; // blocked / throttled: stop this cycle
      }
    }
    if (failures && failures === slice.length) throw new Error("all EDGAR requests failed");
    return out;
  }
}
