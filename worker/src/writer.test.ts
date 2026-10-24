import { describe, expect, it } from "vitest";
import { PriceWriter, type HistoryRow, type PriceRow, type PriceSink } from "./writer.js";
import { silentLogger } from "./log.js";
import type { Tick } from "./types.js";

class MemSink implements PriceSink {
  prices: PriceRow[][] = [];
  history: Array<{ rows: HistoryRow[]; overwrite: boolean }> = [];
  fail = false;
  async upsertPrices(rows: PriceRow[]) {
    if (this.fail) throw new Error("boom");
    this.prices.push(rows);
  }
  async upsertHistory(rows: HistoryRow[], overwrite: boolean) {
    this.history.push({ rows, overwrite });
  }
}

const T0 = Date.parse("2026-03-02T15:00:00Z");
const tick = (symbol: string, price: number, ts: number, extra: Partial<Tick> = {}): Tick => ({
  symbol,
  assetType: "stock",
  price,
  ts,
  source: "alpaca",
  ...extra,
});

function setup(batchSize = 200) {
  const sink = new MemSink();
  let now = T0;
  const w = new PriceWriter(sink, { intervalMs: 2000, batchSize, now: () => now }, silentLogger);
  return { sink, w, advance: (ms: number) => (now += ms), clock: () => now };
}

describe("PriceWriter", () => {
  it("coalesces many ticks into one latest-price row per interval", async () => {
    const { sink, w } = setup();
    for (let i = 0; i < 50; i++) w.ingest(tick("AAPL", 100 + i, T0 + i));
    w.ingest(tick("MSFT", 300, T0 + 5));
    await w.flush();
    expect(sink.prices).toHaveLength(1);
    expect(sink.prices[0].map((r) => [r.symbol, r.price]).sort()).toEqual([["AAPL", 149], ["MSFT", 300]]);
  });

  it("throttles to one write per symbol per interval", async () => {
    const { sink, w, advance } = setup();
    w.ingest(tick("AAPL", 100, T0));
    await w.flush();
    advance(500);
    w.ingest(tick("AAPL", 101, T0 + 500));
    await w.flush();
    expect(sink.prices).toHaveLength(1);
    advance(1600);
    await w.flush();
    expect(sink.prices).toHaveLength(2);
    expect(sink.prices[1][0].price).toBe(101);
  });

  it("skips writes when nothing changed", async () => {
    const { sink, w, advance } = setup();
    w.ingest(tick("AAPL", 100, T0));
    await w.flush();
    advance(3000);
    w.ingest(tick("AAPL", 100, T0 + 3000));
    await w.flush();
    expect(sink.prices).toHaveLength(1);
  });

  it("batches large writes", async () => {
    const { sink, w } = setup(3);
    for (let i = 0; i < 7; i++) w.ingest(tick(`S${i}`, 10 + i, T0));
    await w.flush();
    expect(sink.prices.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  it("computes change vs previous close and keeps baselines across ticks", async () => {
    const { sink, w, advance } = setup();
    w.ingest(tick("AAPL", 110, T0, { prevClose: 100 }));
    await w.flush();
    expect(sink.prices[0][0]).toMatchObject({ prev_close: 100, change_24h_pct: 10 });
    advance(3000);
    w.ingest(tick("AAPL", 105, T0 + 3000)); // no prevClose on this tick
    await w.flush();
    expect(sink.prices[1][0]).toMatchObject({ prev_close: 100, change_24h_pct: 5 });
  });

  it("falls back to provider changePct when no baseline", async () => {
    const { sink, w } = setup();
    w.ingest(tick("BTC", 50000, T0, { assetType: "crypto", changePct: -2.5, source: "coingecko" }));
    await w.flush();
    expect(sink.prices[0][0]).toMatchObject({ asset_type: "crypto", change_24h_pct: -2.5, prev_close: null });
  });

  it("drops invalid and out-of-order ticks", async () => {
    const { sink, w } = setup();
    w.ingest(tick("AAPL", 0, T0));
    w.ingest(tick("AAPL", NaN, T0));
    w.ingest(tick("AAPL", 100, T0 + 1000));
    w.ingest(tick("AAPL", 90, T0)); // older
    await w.flush();
    expect(sink.prices[0][0].price).toBe(100);
  });

  it("retries failed upserts without losing the tick", async () => {
    const { sink, w, advance } = setup();
    sink.fail = true;
    w.ingest(tick("AAPL", 100, T0));
    await w.flush();
    expect(w.stats.writeErrors).toBe(1);
    sink.fail = false;
    advance(2500);
    await w.flush();
    expect(sink.prices).toHaveLength(1);
  });

  it("writes one history row per symbol per UTC day at rollover (no overwrite)", async () => {
    const { sink, w, advance } = setup();
    w.ingest(tick("BTC", 100, T0, { assetType: "crypto", volume: 5 }));
    w.ingest(tick("BTC", 120, T0 + 1000));
    w.ingest(tick("BTC", 90, T0 + 2000));
    w.ingest(tick("BTC", 110, T0 + 3000));
    await w.flush();
    expect(sink.history).toHaveLength(0); // day not finished
    advance(24 * 3600_000);
    w.ingest(tick("BTC", 111, T0 + 24 * 3600_000));
    await w.flush();
    expect(sink.history).toHaveLength(1);
    expect(sink.history[0].overwrite).toBe(false);
    expect(sink.history[0].rows[0]).toMatchObject({ symbol: "BTC", day: "2026-03-02", open: 100, high: 120, low: 90, close: 110 });
    await w.flush();
    expect(sink.history).toHaveLength(1);
  });

  it("writes an authoritative previous-day bar once", async () => {
    const { sink, w } = setup();
    const prevDay = { day: "2026-02-27", open: 1, high: 3, low: 0.5, close: 2, volume: 10 };
    w.ingest(tick("AAPL", 2.1, T0, { prevClose: 2, prevDay }));
    w.ingest(tick("AAPL", 2.2, T0 + 1000, { prevClose: 2, prevDay }));
    await w.flush();
    const h = sink.history.filter((x) => x.overwrite);
    expect(h).toHaveLength(1);
    expect(h[0].rows[0]).toMatchObject({ symbol: "AAPL", day: "2026-02-27", close: 2 });
  });
});
