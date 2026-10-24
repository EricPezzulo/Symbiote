import type { Logger, ProviderStatus } from "../types.js";
import { BaseProvider, chunk } from "./base.js";
import { errMsg } from "./managed-socket.js";
import type { FetchLike } from "./alpaca-rest.js";
import { COINGECKO_IDS } from "../symbols.js";

export type CoinGeckoOpts = {
  baseUrl: string; // https://api.coingecko.com/api/v3
  apiKey?: string; // optional demo key
  pollMs: number; // free demo ~30 calls/min; default 60s
  idOverrides?: Record<string, string>;
  fetch?: FetchLike;
};

/** REST polling crypto fallback (free, rate limited). One request per poll for up to 250 coins. */
export class CoinGeckoProvider extends BaseProvider {
  readonly name = "coingecko";
  readonly assetType = "crypto" as const;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private unknown = new Set<string>();
  private backoffUntil = 0;
  private lastOk = true;

  constructor(private readonly o: CoinGeckoOpts, log: Logger) {
    super(log);
  }

  private idFor(symbol: string): string | undefined {
    return this.o.idOverrides?.[symbol] ?? COINGECKO_IDS[symbol];
  }

  start() {
    this.running = true;
    this.timer = setInterval(() => void this.poll(), this.o.pollMs);
    this.timer.unref?.();
    void this.poll();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): ProviderStatus {
    if (!this.running) return "stopped";
    return this.lastOk ? "open" : "reconnecting";
  }

  protected onSubscribed(symbols: string[]) {
    for (const s of symbols) {
      if (!this.idFor(s) && !this.unknown.has(s)) {
        this.unknown.add(s);
        this.log.warn("no CoinGecko id for symbol; add it via COINGECKO_IDS (SYM:coin-id)", { symbol: s });
      }
    }
    if (this.running) void this.poll(symbols);
  }

  protected onUnsubscribed() {}

  async poll(only?: string[]) {
    if (Date.now() < this.backoffUntil) return;
    const syms = (only ?? [...this.desired]).filter((s) => this.idFor(s) && this.desired.has(s));
    if (!syms.length) return;
    const f = this.o.fetch ?? (fetch as unknown as FetchLike);
    try {
      for (const part of chunk(syms, 200)) {
        const ids = [...new Set(part.map((s) => this.idFor(s)!))];
        const url =
          `${this.o.baseUrl.replace(/\/$/, "")}/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
          `&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true`;
        const headers: Record<string, string> = {};
        if (this.o.apiKey) headers["x-cg-demo-api-key"] = this.o.apiKey;
        const res = await f(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (res.status === 429) {
          this.backoffUntil = Date.now() + 2 * this.o.pollMs;
          throw new Error("rate limited (HTTP 429); backing off");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number | null; usd_24h_vol?: number; last_updated_at?: number }>;
        for (const s of part) {
          const d = body[this.idFor(s)!];
          if (!d || typeof d.usd !== "number" || !(d.usd > 0)) continue;
          const chg = typeof d.usd_24h_change === "number" ? d.usd_24h_change : null;
          this.emit({
            symbol: s,
            assetType: "crypto",
            price: d.usd,
            ts: d.last_updated_at ? d.last_updated_at * 1000 : Date.now(),
            volume: d.usd_24h_vol ?? null,
            changePct: chg,
            prevClose: chg !== null && chg > -100 ? d.usd / (1 + chg / 100) : null,
            source: "coingecko",
          });
        }
      }
      this.lastOk = true;
    } catch (err) {
      this.lastOk = false;
      this.log.warn("CoinGecko poll failed", { error: errMsg(err) });
    }
  }
}
