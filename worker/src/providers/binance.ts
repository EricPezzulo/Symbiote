import type { Logger, ProviderStatus } from "../types.js";
import { BaseProvider, chunk } from "./base.js";
import { ManagedSocket, type BackoffOpts, type SocketFactory } from "./managed-socket.js";
import { binanceReverseMap, toBinanceStream } from "../symbols.js";

export type BinanceOpts = {
  /** e.g. wss://stream.binance.com:9443 (global) or wss://stream.binance.us:9443 (US). */
  wsUrl: string;
  heartbeatMs: number;
  backoff: BackoffOpts;
  factory?: SocketFactory;
  random?: () => number;
  /** Max streams placed in the connection URL; the rest are sent with SUBSCRIBE. */
  maxUrlStreams?: number;
  /** Binance allows 5 control messages/second per connection. */
  controlGapMs?: number;
};

type MiniTicker = { e?: string; E?: number; s?: string; c?: string; o?: string; q?: string };

/** Binance spot combined stream (`/stream?streams=btcusdt@miniTicker/...`). */
export class BinanceProvider extends BaseProvider {
  readonly name = "binance";
  readonly assetType = "crypto" as const;
  private sock: ManagedSocket;
  private reverse = new Map<string, string>();
  private inUrl = new Set<string>();
  private nextId = 1;
  private queue: unknown[] = [];
  private queueTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private hinted = false;

  constructor(private readonly o: BinanceOpts, log: Logger) {
    super(log);
    this.sock = new ManagedSocket({
      name: "binance",
      url: () => this.buildUrl(),
      log,
      backoff: o.backoff,
      heartbeatMs: o.heartbeatMs,
      factory: o.factory,
      random: o.random,
      onOpen: () => {
        // Anything desired but not in the URL must be subscribed explicitly.
        const rest = [...this.desired].filter((s) => !this.inUrl.has(s));
        this.queue = [];
        this.enqueue("SUBSCRIBE", rest);
      },
      onClose: () => {
        this.queue = [];
      },
      onMessage: (raw) => this.handle(raw),
      onError: (err) => {
        if (!this.hinted && /\b451\b|\b403\b/.test(err.message)) {
          this.hinted = true;
          this.log.error("Binance rejected the connection (likely geo-restricted). Set BINANCE_WS_URL=wss://stream.binance.us:9443 or CRYPTO_PROVIDER=coingecko");
        }
      },
    });
  }

  private buildUrl() {
    const base = this.o.wsUrl.replace(/\/$/, "");
    const syms = [...this.desired].sort();
    this.reverse = binanceReverseMap(syms);
    if (syms.length === 0 || syms.length > (this.o.maxUrlStreams ?? 200)) {
      this.inUrl = new Set();
      return `${base}/stream`;
    }
    this.inUrl = new Set(syms);
    return `${base}/stream?streams=${syms.map(toBinanceStream).join("/")}`;
  }

  start() {
    this.stopped = false;
    this.sock.start();
  }

  async stop() {
    this.stopped = true;
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    await this.sock.stop();
  }

  status(): ProviderStatus {
    if (this.stopped) return "stopped";
    if (this.sock.state === "open") return "open";
    if (this.sock.state === "waiting") return "reconnecting";
    return this.sock.state === "idle" ? "idle" : "connecting";
  }

  protected onSubscribed(symbols: string[]) {
    this.reverse = binanceReverseMap(this.desired);
    this.enqueue("SUBSCRIBE", symbols);
  }

  protected onUnsubscribed(symbols: string[]) {
    for (const s of symbols) this.inUrl.delete(s);
    this.enqueue("UNSUBSCRIBE", symbols);
    this.reverse = binanceReverseMap(this.desired);
  }

  private enqueue(method: "SUBSCRIBE" | "UNSUBSCRIBE", symbols: string[]) {
    if (!symbols.length || !this.sock.isOpen()) return; // on reconnect the URL/onOpen covers desired
    for (const part of chunk(symbols.map(toBinanceStream), 100)) {
      this.queue.push({ method, params: part, id: this.nextId++ });
    }
    this.drain();
  }

  private drain() {
    if (this.queueTimer || !this.queue.length) return;
    const msg = this.queue.shift();
    this.sock.send(msg);
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.drain();
    }, this.o.controlGapMs ?? 250);
    this.queueTimer.unref?.();
  }

  private handle(raw: string) {
    let parsed: { stream?: string; data?: MiniTicker } & MiniTicker & { result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn("malformed frame ignored", { bytes: raw.length });
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if ("error" in parsed && parsed.error) {
      this.log.warn("Binance control error", { error: JSON.stringify(parsed.error) });
      return;
    }
    const d: MiniTicker = parsed.data ?? parsed;
    if (!d.s || (d.e !== "24hrMiniTicker" && d.e !== "miniTicker")) return;
    const symbol = this.reverse.get(d.s.toUpperCase());
    if (!symbol) return;
    const price = Number(d.c);
    if (!Number.isFinite(price) || price <= 0) return;
    const open = Number(d.o);
    this.emit({
      symbol,
      assetType: "crypto",
      price,
      ts: typeof d.E === "number" ? d.E : Date.now(),
      volume: d.q !== undefined && Number.isFinite(Number(d.q)) ? Number(d.q) : null,
      prevClose: Number.isFinite(open) && open > 0 ? open : null,
      changePct: Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : null,
      source: "binance",
    });
  }
}
