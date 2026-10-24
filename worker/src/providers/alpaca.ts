import type { Logger, ProviderStatus, Tick } from "../types.js";
import { BaseProvider } from "./base.js";
import { ManagedSocket, errMsg, type BackoffOpts, type SocketFactory } from "./managed-socket.js";
import { fetchAlpacaSnapshots, type FetchLike } from "./alpaca-rest.js";

export type AlpacaOpts = {
  wsUrl: string;
  dataUrl: string;
  keyId: string;
  secret: string;
  /** Free plan: 30 websocket symbols. Extra symbols are polled via REST snapshots. */
  maxSymbols: number;
  overflowPollMs: number;
  heartbeatMs: number;
  backoff: BackoffOpts;
  factory?: SocketFactory;
  fetch?: FetchLike;
  random?: () => number;
};

type Msg = {
  T: string;
  S?: string;
  p?: number;
  s?: number;
  t?: string;
  bp?: number;
  ap?: number;
  code?: number;
  msg?: string;
  trades?: string[];
};

/** Alpaca market data v2 websocket (IEX feed on the free plan) + REST snapshots. */
export class AlpacaProvider extends BaseProvider {
  readonly name = "alpaca";
  readonly assetType = "stock" as const;
  private sock: ManagedSocket;
  private authed = false;
  private limit: number;
  /** Symbols we have asked the server to stream (a subset of desired). */
  private active = new Set<string>();
  /** Symbols the server last confirmed (from "subscription" frames). */
  private confirmed = new Set<string>();
  private seenPrice = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private failed = false;
  private stopped = false;

  constructor(private readonly o: AlpacaOpts, log: Logger) {
    super(log);
    this.limit = o.maxSymbols;
    this.sock = new ManagedSocket({
      name: "alpaca",
      url: () => o.wsUrl,
      log,
      backoff: o.backoff,
      heartbeatMs: o.heartbeatMs,
      factory: o.factory,
      random: o.random,
      onOpen: () => {
        this.authed = false; // wait for the "connected" greeting, then auth
      },
      onClose: () => {
        this.authed = false;
        this.confirmed.clear();
      },
      onMessage: (raw) => this.handle(raw),
    });
  }

  start() {
    this.stopped = false;
    this.sock.start();
    this.pollTimer = setInterval(() => void this.pollOverflow(), this.o.overflowPollMs);
    this.pollTimer.unref?.();
  }

  async stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.sock.stop();
  }

  status(): ProviderStatus {
    if (this.failed) return "failed";
    if (this.stopped) return "stopped";
    if (this.sock.state === "open") return this.authed ? "open" : "connecting";
    if (this.sock.state === "waiting") return "reconnecting";
    return this.sock.state === "idle" ? "idle" : "connecting";
  }

  /** Symbols streamed live vs polled (for health logging and tests). */
  split() {
    return { active: [...this.active].sort(), overflow: [...this.desired].filter((s) => !this.active.has(s)).sort() };
  }

  protected onSubscribed(symbols: string[]) {
    this.reconcile();
    void this.snapshot(symbols);
  }

  protected onUnsubscribed() {
    this.reconcile();
    for (const s of [...this.seenPrice]) if (!this.desired.has(s)) this.seenPrice.delete(s);
  }

  /** Make `active` = first `limit` desired symbols (stable for those already active), send diffs. */
  private reconcile() {
    const next = new Set<string>();
    for (const s of this.active) if (this.desired.has(s) && next.size < this.limit) next.add(s);
    for (const s of [...this.desired].sort()) {
      if (next.size >= this.limit) break;
      next.add(s);
    }
    const add = [...next].filter((s) => !this.active.has(s));
    const del = [...this.active].filter((s) => !next.has(s));
    this.active = next;
    if (!this.authed) return; // full subscribe happens after auth
    if (add.length) this.sock.send({ action: "subscribe", trades: add, quotes: add });
    if (del.length) this.sock.send({ action: "unsubscribe", trades: del, quotes: del });
  }

  private handle(raw: string) {
    let frames: Msg[];
    try {
      const parsed: unknown = JSON.parse(raw);
      frames = Array.isArray(parsed) ? (parsed as Msg[]) : [parsed as Msg];
    } catch {
      this.log.warn("malformed frame ignored", { bytes: raw.length });
      return;
    }
    for (const m of frames) {
      if (!m || typeof m !== "object") continue;
      try {
        this.handleOne(m);
      } catch (err) {
        this.log.warn("frame handler error", { error: errMsg(err) });
      }
    }
  }

  private handleOne(m: Msg) {
    switch (m.T) {
      case "success":
        if (m.msg === "connected") {
          this.sock.send({ action: "auth", key: this.o.keyId, secret: this.o.secret });
        } else if (m.msg === "authenticated") {
          this.authed = true;
          this.log.info("authenticated", { symbols: this.active.size });
          this.reconcile();
          if (this.active.size) this.sock.send({ action: "subscribe", trades: [...this.active], quotes: [...this.active] });
        }
        return;
      case "error":
        this.handleError(m);
        return;
      case "subscription":
        this.confirmed = new Set(m.trades ?? []);
        this.log.debug("subscription", { trades: this.confirmed.size });
        return;
      case "t": {
        if (!m.S || typeof m.p !== "number" || !(m.p > 0)) return;
        this.seenPrice.add(m.S);
        this.emit({ symbol: m.S, assetType: "stock", price: m.p, ts: m.t ? Date.parse(m.t) || Date.now() : Date.now(), source: "alpaca" });
        return;
      }
      case "q": {
        // Quotes only seed symbols that have no trade/snapshot price yet (thin IEX volume).
        if (!m.S || this.seenPrice.has(m.S) || typeof m.bp !== "number" || typeof m.ap !== "number") return;
        if (!(m.bp > 0 && m.ap > 0)) return;
        this.emit({ symbol: m.S, assetType: "stock", price: (m.bp + m.ap) / 2, ts: m.t ? Date.parse(m.t) || Date.now() : Date.now(), source: "alpaca-quote" });
        return;
      }
      default:
        return;
    }
  }

  private handleError(m: Msg) {
    switch (m.code) {
      case 402: // auth failed: retrying with the same credentials cannot work
        this.failed = true;
        this.log.error("Alpaca auth failed; check ALPACA_KEY_ID/ALPACA_SECRET_KEY (provider halted)", { code: m.code });
        this.sock.halt();
        return;
      case 406: // connection limit exceeded (free plan = 1 connection)
        this.log.warn("Alpaca connection limit exceeded (another session is using the stream); retrying in 30s");
        this.sock.reconnect(30_000);
        return;
      case 405: {
        // Symbol limit exceeded: the server keeps the previous subscriptions. Adopt them as our limit.
        const before = this.limit;
        this.limit = Math.max(1, Math.min(this.limit, this.confirmed.size));
        this.log.warn("Alpaca symbol limit exceeded; moving extras to REST polling", { limitWas: before, limitNow: this.limit });
        this.active = new Set([...this.confirmed].filter((s) => this.desired.has(s)).slice(0, this.limit));
        void this.snapshot([...this.desired].filter((s) => !this.active.has(s)));
        return;
      }
      case 403:
        return; // already authenticated
      case 401:
      case 404:
        this.log.warn("Alpaca protocol error; reconnecting", { code: m.code, msg: m.msg });
        this.sock.reconnect(1_000);
        return;
      default:
        this.log.warn("Alpaca error", { code: m.code, msg: m.msg });
    }
  }

  private async snapshot(symbols: string[]) {
    if (!symbols.length) return;
    try {
      const ticks = await fetchAlpacaSnapshots(symbols, this.o);
      for (const t of ticks) {
        if (!this.desired.has(t.symbol)) continue;
        this.seenPrice.add(t.symbol);
        this.emit(t);
      }
    } catch (err) {
      this.log.warn("snapshot fetch failed", { error: errMsg(err) });
    }
  }

  private async pollOverflow() {
    const overflow = [...this.desired].filter((s) => !this.active.has(s));
    if (overflow.length) await this.snapshot(overflow);
  }
}

export type { Tick };
