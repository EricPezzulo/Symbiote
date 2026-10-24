import { HttpError, type Http } from "../http.js";
import type { CalendarEventRow, CalendarSource, NewsSource, PollContext, RawNewsItem } from "../types.js";
import type { RateLimiter } from "./ratelimit.js";

const BASE = "https://finnhub.io/api/v1";
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type FhNews = { category?: string; datetime?: number; headline?: string; id?: number; related?: string; source?: string; summary?: string; url?: string };

/**
 * Finnhub free tier: ~60 API calls/minute (third-party summaries; the docs page did not render for the fetch
 * tool), plus a hard 30 calls/second cap. All Finnhub sources share ONE RateLimiter (default 1.1s gap ~= 54/min).
 * The API key goes in the X-Finnhub-Token header so it never appears in URLs or logs.
 */
export class FinnhubCompanyNews implements NewsSource {
  readonly name = "finnhub";
  readonly category = "company" as const;
  readonly timeoutMs = 15_000;
  private offset = 0;

  constructor(
    private readonly http: Http,
    private readonly limiter: RateLimiter,
    private readonly apiKey: string | undefined,
    readonly intervalMs = 15 * 60_000,
    private readonly maxTickersPerCycle = 40,
    private readonly lookbackDays = 2,
  ) {}

  enabled() {
    return Boolean(this.apiKey);
  }

  async poll(ctx: PollContext): Promise<RawNewsItem[]> {
    const tickers = [...ctx.universe.symbols].filter(([, c]) => c === "stock").map(([s]) => s).filter((s) => /^[A-Z.\-]{1,10}$/.test(s)).sort();
    if (!tickers.length) return [];
    const n = Math.min(this.maxTickersPerCycle, tickers.length);
    const slice = Array.from({ length: n }, (_, i) => tickers[(this.offset + i) % tickers.length]);
    this.offset = (this.offset + n) % tickers.length;
    const from = ymd(ctx.now - this.lookbackDays * 86_400_000);
    const to = ymd(ctx.now + 86_400_000);
    const out: RawNewsItem[] = [];
    let failures = 0;
    for (const sym of slice) {
      await this.limiter.wait();
      try {
        const res = await this.http.get(`${BASE}/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}`, {
          headers: { "x-finnhub-token": this.apiKey! },
          timeoutMs: this.timeoutMs,
          maxBytes: 5_000_000,
        });
        if (res.notModified) continue;
        out.push(...mapFinnhubNews(JSON.parse(res.body), "company", [sym], ctx.now));
      } catch (err) {
        failures++;
        ctx.log.warn("finnhub company-news failed", { symbol: sym, error: err instanceof Error ? err.message : String(err) });
        if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 429)) break;
      }
    }
    if (failures && failures === slice.length) throw new Error("all Finnhub company-news requests failed");
    return out;
  }
}

export class FinnhubMarketNews implements NewsSource {
  readonly name = "finnhub";
  readonly category = "market" as const;
  readonly timeoutMs = 15_000;

  constructor(private readonly http: Http, private readonly limiter: RateLimiter, private readonly apiKey: string | undefined, readonly intervalMs = 10 * 60_000) {}

  enabled() {
    return Boolean(this.apiKey);
  }

  async poll(ctx: PollContext): Promise<RawNewsItem[]> {
    await this.limiter.wait();
    const res = await this.http.get(`${BASE}/news?category=general`, { headers: { "x-finnhub-token": this.apiKey! }, timeoutMs: this.timeoutMs, maxBytes: 5_000_000 });
    if (res.notModified) return [];
    return mapFinnhubNews(JSON.parse(res.body), "market", [], ctx.now);
  }
}

export function mapFinnhubNews(json: unknown, category: "company" | "market", forced: string[], _now: number): RawNewsItem[] {
  if (!Array.isArray(json)) return [];
  const out: RawNewsItem[] = [];
  for (const raw of json as FhNews[]) {
    if (!raw || typeof raw.url !== "string" || typeof raw.headline !== "string") continue;
    const related = typeof raw.related === "string" ? raw.related.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
    const publisher = typeof raw.source === "string" ? raw.source.replace(/[^\w .&-]/g, "").slice(0, 30).trim() : "";
    out.push({
      source: publisher ? `finnhub:${publisher}` : "finnhub",
      externalId: raw.id !== undefined ? `finnhub:${raw.id}` : null,
      url: raw.url,
      title: raw.headline,
      summary: raw.summary ?? null,
      publishedAt: typeof raw.datetime === "number" ? raw.datetime * 1000 : null,
      category,
      symbols: [...forced, ...related],
    });
  }
  return out;
}

type FhEarn = { date?: string; epsActual?: number | null; epsEstimate?: number | null; hour?: string; quarter?: number; revenueActual?: number | null; revenueEstimate?: number | null; symbol?: string; year?: number };

/** Upcoming earnings for the universe (Finnhub /calendar/earnings). Availability on the free key is unverified; failures are non-fatal. */
export class FinnhubEarningsCalendar implements CalendarSource {
  readonly name = "finnhub-earnings";

  constructor(private readonly http: Http, private readonly limiter: RateLimiter, private readonly apiKey: string | undefined, readonly intervalMs = 6 * 3_600_000, private readonly horizonDays = 30) {}

  enabled() {
    return Boolean(this.apiKey);
  }

  async poll(ctx: PollContext): Promise<CalendarEventRow[]> {
    await this.limiter.wait();
    const res = await this.http.get(`${BASE}/calendar/earnings?from=${ymd(ctx.now - 86_400_000)}&to=${ymd(ctx.now + this.horizonDays * 86_400_000)}`, {
      headers: { "x-finnhub-token": this.apiKey! },
      maxBytes: 20_000_000,
    });
    if (res.notModified) return [];
    return mapEarnings(JSON.parse(res.body), ctx.universe.symbols);
  }
}

export function mapEarnings(json: unknown, universe: Map<string, unknown>): CalendarEventRow[] {
  const list = (json as { earningsCalendar?: FhEarn[] } | null)?.earningsCalendar;
  if (!Array.isArray(list)) return [];
  const out: CalendarEventRow[] = [];
  for (const e of list) {
    const sym = typeof e.symbol === "string" ? e.symbol.toUpperCase() : "";
    if (!sym || !universe.has(sym) || typeof e.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    // Finnhub gives a date plus bmo/amc/dmh; store midday UTC as a stable placeholder time.
    out.push({
      unique_key: `earnings:${sym}:${e.date}`,
      kind: "earnings",
      symbol: sym,
      title: `${sym} earnings${e.hour ? ` (${e.hour})` : ""}`,
      event_at: `${e.date}T12:00:00.000Z`,
      country: "US",
      importance: null,
      details: { hour: e.hour ?? null, quarter: e.quarter ?? null, year: e.year ?? null, epsEstimate: e.epsEstimate ?? null, epsActual: e.epsActual ?? null, revenueEstimate: e.revenueEstimate ?? null, revenueActual: e.revenueActual ?? null },
      source: "finnhub",
    });
  }
  return out;
}

/**
 * Economic calendar placeholder. Finnhub's /calendar/economic is reported as premium-only on the free plan, so this
 * is a documented stub that returns nothing. Replace `poll` with a free provider (or a paid Finnhub key) in Phase 5.
 */
export class EconomicCalendarStub implements CalendarSource {
  readonly name = "economic-calendar-stub";
  readonly intervalMs = 24 * 3_600_000;
  enabled() {
    return false;
  }
  async poll(): Promise<CalendarEventRow[]> {
    return [];
  }
}
