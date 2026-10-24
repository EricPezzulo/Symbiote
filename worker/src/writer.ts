import type { Logger, Tick, AssetClass, DailyBar } from "./types.js";

export type PriceRow = {
  symbol: string;
  asset_type: AssetClass;
  price: number;
  change_24h_pct: number | null;
  prev_close: number | null;
  volume_24h: number | null;
  source: string;
  updated_at: string;
};

export type HistoryRow = {
  symbol: string;
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string;
};

export interface PriceSink {
  upsertPrices(rows: PriceRow[]): Promise<void>;
  /** overwrite=false keeps an existing row for (symbol, day); true replaces it. */
  upsertHistory(rows: HistoryRow[], overwrite: boolean): Promise<void>;
}

type Pending = {
  tick: Tick;
  prevClose: number | null;
};

type Acc = { day: string; open: number; high: number; low: number; close: number; volume: number | null; source: string };

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type WriterOpts = {
  intervalMs: number;
  batchSize: number;
  now?: () => number;
};

/**
 * Coalesces ticks per symbol: at most one `prices` upsert per symbol per interval, written in
 * batches, plus one `price_history` row per symbol per UTC day.
 */
export class PriceWriter {
  private pending = new Map<string, Pending>();
  private lastWriteAt = new Map<string, number>();
  private lastWritten = new Map<string, { price: number; prev: number | null }>();
  private lastTs = new Map<string, number>();
  private prevClose = new Map<string, number>();
  private acc = new Map<string, Acc>();
  private finishedDays: HistoryRow[] = [];
  private prevDayRows: HistoryRow[] = [];
  private historyDone = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  stats = { ticks: 0, rowsWritten: 0, writeErrors: 0, dropped: 0 };

  constructor(private readonly sink: PriceSink, private readonly o: WriterOpts, private readonly log: Logger) {}

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  start() {
    this.timer = setInterval(() => void this.flush(), this.o.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(true);
  }

  pendingCount() {
    return this.pending.size;
  }

  ingest(t: Tick) {
    if (!(t.price > 0) || !Number.isFinite(t.price) || !t.symbol) {
      this.stats.dropped++;
      return;
    }
    const ts = Math.min(t.ts, this.now() + 60_000); // clamp bogus future timestamps
    const seen = this.lastTs.get(t.symbol) ?? 0;
    if (ts < seen && t.source !== "alpaca-quote") {
      // Out-of-order / stale (e.g. REST snapshot older than a streamed trade): still keep baselines.
      if (t.prevClose && t.prevClose > 0) this.prevClose.set(t.symbol, t.prevClose);
      this.captureHistory(t);
      this.stats.dropped++;
      return;
    }
    this.lastTs.set(t.symbol, ts);
    this.stats.ticks++;
    if (t.prevClose && t.prevClose > 0) this.prevClose.set(t.symbol, t.prevClose);
    this.pending.set(t.symbol, { tick: { ...t, ts }, prevClose: this.prevClose.get(t.symbol) ?? null });
    this.accumulate({ ...t, ts });
    this.captureHistory(t);
  }

  private captureHistory(t: Tick) {
    const bar: DailyBar | null | undefined = t.prevDay;
    if (!bar) return;
    const key = `${t.symbol}|${bar.day}`;
    if (this.historyDone.has(key)) return;
    this.historyDone.add(key);
    this.prevDayRows.push({ symbol: t.symbol, ...bar, source: t.source });
  }

  private accumulate(t: Tick) {
    const day = utcDay(t.ts);
    const a = this.acc.get(t.symbol);
    if (!a || a.day < day) {
      if (a) this.finishDay(t.symbol, a);
      this.acc.set(t.symbol, { day, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.volume ?? null, source: t.source });
      return;
    }
    if (a.day > day) return; // late tick from a finished day
    a.high = Math.max(a.high, t.price);
    a.low = Math.min(a.low, t.price);
    a.close = t.price;
    if (t.volume != null) a.volume = t.volume;
  }

  private finishDay(symbol: string, a: Acc) {
    const key = `${symbol}|${a.day}`;
    if (this.historyDone.has(key)) return; // an authoritative bar already exists
    this.historyDone.add(key);
    this.finishedDays.push({ symbol, day: a.day, open: a.open, high: a.high, low: a.low, close: a.close, volume: a.volume, source: a.source });
  }

  private toRow(p: Pending): PriceRow {
    const { tick: t, prevClose } = p;
    const change = prevClose && prevClose > 0 ? ((t.price - prevClose) / prevClose) * 100 : (t.changePct ?? null);
    return {
      symbol: t.symbol,
      asset_type: t.assetType,
      price: t.price,
      change_24h_pct: change !== null && Number.isFinite(change) ? Math.round(change * 1e6) / 1e6 : null,
      prev_close: prevClose,
      volume_24h: t.volume ?? null,
      source: t.source.replace(/-quote$/, ""),
      updated_at: new Date(t.ts).toISOString(),
    };
  }

  /** Write due rows. `force` ignores the per-symbol throttle (shutdown). */
  async flush(force = false) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = this.now();
      // Roll over days for symbols that have gone quiet past UTC midnight.
      const today = utcDay(now);
      for (const [s, a] of this.acc) {
        if (a.day < today && now - Date.parse(`${a.day}T23:59:59Z`) > 60_000) {
          this.finishDay(s, a);
          this.acc.delete(s);
        }
      }

      const due: Array<[string, Pending]> = [];
      for (const [s, p] of this.pending) {
        const last = this.lastWriteAt.get(s) ?? 0;
        if (!force && now - last < this.o.intervalMs) continue;
        const w = this.lastWritten.get(s);
        if (w && w.price === p.tick.price && w.prev === p.prevClose) {
          this.pending.delete(s); // nothing new to say
          continue;
        }
        due.push([s, p]);
      }
      for (let i = 0; i < due.length; i += this.o.batchSize) {
        const part = due.slice(i, i + this.o.batchSize);
        try {
          await this.sink.upsertPrices(part.map(([, p]) => this.toRow(p)));
          for (const [s, p] of part) {
            this.lastWriteAt.set(s, now);
            this.lastWritten.set(s, { price: p.tick.price, prev: p.prevClose });
            // Only clear if no newer tick arrived during the await.
            if (this.pending.get(s) === p) this.pending.delete(s);
          }
          this.stats.rowsWritten += part.length;
        } catch (err) {
          this.stats.writeErrors++;
          this.log.error("prices upsert failed; will retry", { rows: part.length, error: err instanceof Error ? err.message : String(err) });
        }
      }

      await this.flushHistory(this.prevDayRows, true);
      await this.flushHistory(this.finishedDays, false);
    } finally {
      this.flushing = false;
    }
  }

  private async flushHistory(queue: HistoryRow[], overwrite: boolean) {
    if (!queue.length) return;
    const rows = queue.splice(0, queue.length);
    try {
      for (let i = 0; i < rows.length; i += this.o.batchSize) {
        await this.sink.upsertHistory(rows.slice(i, i + this.o.batchSize), overwrite);
      }
    } catch (err) {
      this.stats.writeErrors++;
      queue.unshift(...rows);
      this.log.error("price_history upsert failed; will retry", { rows: rows.length, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
