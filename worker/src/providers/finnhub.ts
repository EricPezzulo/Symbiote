import type { Logger, ProviderStatus } from "../types.js";
import { BaseProvider } from "./base.js";
import { ManagedSocket, errMsg, type BackoffOpts, type SocketFactory } from "./managed-socket.js";
import type { FetchLike } from "./alpaca-rest.js";

export type FinnhubOpts = {
  apiKey: string;
  wsUrl?: string; // default wss://ws.finnhub.io
  restUrl?: string; // default https://finnhub.io/api/v1
  heartbeatMs: number;
  backoff: BackoffOpts;
  factory?: SocketFactory;
  fetch?: FetchLike;
  random?: () => number;
  /** Free tier REST is ~60 calls/min; quotes are fetched at this gap for prev-close seeding. */
  quoteGapMs?: number;
};

/** Optional stock fallback: Finnhub trade websocket + /quote for previous close. */
export class FinnhubProvider extends BaseProvider {
  readonly name = "finnhub";
  readonly assetType = "stock" as const;
  private sock: ManagedSocket;
  private stopped = false;
  private failed = false;
  private prevClose = new Map<string, number>();
  private quoteQueue: string[] = [];
  private quoteTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: FinnhubOpts, log: Logger) {
    super(log);
    this.sock = new ManagedSocket({
      name: "finnhub",
      url: () => `${o.wsUrl ?? "wss://ws.finnhub.io"}?token=${encodeURIComponent(o.apiKey)}`,
      log,
      backoff: o.backoff,
      heartbeatMs: o.heartbeatMs,
      factory: o.factory,
      random: o.random,
      onOpen: () => {
        for (const s of this.desired) this.sock.send({ type: "subscribe", symbol: s });
      },
      onMessage: (raw) => this.handle(raw),
      onError: (err) => {
        if (/\b401\b|\b403\b/.test(err.message)) {
          this.failed = true;
          this.log.error("Finnhub rejected the API key; provider halted");
          this.sock.halt();
        }
      },
    });
  }

  start() {
    this.stopped = false;
    this.sock.start();
  }

  async stop() {
    this.stopped = true;
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    this.quoteTimer = null;
    await this.sock.stop();
  }

  status(): ProviderStatus {
    if (this.failed) return "failed";
    if (this.stopped) return "stopped";
    if (this.sock.state === "open") return "open";
    if (this.sock.state === "waiting") return "reconnecting";
    return this.sock.state === "idle" ? "idle" : "connecting";
  }

  protected onSubscribed(symbols: string[]) {
    for (const s of symbols) this.sock.send({ type: "subscribe", symbol: s });
    this.quoteQueue.push(...symbols);
    this.drainQuotes();
  }

  protected onUnsubscribed(symbols: string[]) {
    for (const s of symbols) {
      this.sock.send({ type: "unsubscribe", symbol: s });
      this.prevClose.delete(s);
    }
  }

  private handle(raw: string) {
    let m: { type?: string; data?: Array<{ s?: string; p?: number; t?: number; v?: number }>; msg?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      this.log.warn("malformed frame ignored", { bytes: raw.length });
      return;
    }
    if (m?.type === "error") {
      this.log.warn("Finnhub error", { msg: m.msg });
      return;
    }
    if (m?.type !== "trade" || !Array.isArray(m.data)) return;
    // Several trades per symbol can arrive in one frame; the last one is the latest.
    const last = new Map<string, { p: number; t: number; v: number }>();
    for (const d of m.data) {
      if (!d || typeof d.s !== "string" || typeof d.p !== "number" || !(d.p > 0)) continue;
      last.set(d.s, { p: d.p, t: typeof d.t === "number" ? d.t : Date.now(), v: d.v ?? 0 });
    }
    for (const [symbol, d] of last) {
      this.emit({ symbol, assetType: "stock", price: d.p, ts: d.t, volume: d.v, prevClose: this.prevClose.get(symbol) ?? null, source: "finnhub" });
    }
  }

  private drainQuotes() {
    if (this.quoteTimer || !this.quoteQueue.length) return;
    const symbol = this.quoteQueue.shift()!;
    this.quoteTimer = setTimeout(() => {
      this.quoteTimer = null;
      this.drainQuotes();
    }, this.o.quoteGapMs ?? 1_100);
    this.quoteTimer.unref?.();
    if (!this.desired.has(symbol)) return;
    void this.fetchQuote(symbol);
  }

  private async fetchQuote(symbol: string) {
    try {
      const f = this.o.fetch ?? (fetch as unknown as FetchLike);
      const url = `${this.o.restUrl ?? "https://finnhub.io/api/v1"}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(this.o.apiKey)}`;
      const res = await f(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const q = (await res.json()) as { c?: number; pc?: number; t?: number };
      if (typeof q.pc === "number" && q.pc > 0) this.prevClose.set(symbol, q.pc);
      if (typeof q.c === "number" && q.c > 0 && this.desired.has(symbol)) {
        this.emit({ symbol, assetType: "stock", price: q.c, ts: q.t ? q.t * 1000 : Date.now(), prevClose: q.pc && q.pc > 0 ? q.pc : null, source: "finnhub" });
      }
    } catch (err) {
      this.log.warn("quote fetch failed", { symbol, error: errMsg(err) });
    }
  }
}
