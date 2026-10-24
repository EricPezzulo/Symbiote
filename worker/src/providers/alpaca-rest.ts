import type { DailyBar, Tick } from "../types.js";
import { chunk } from "./base.js";

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type Bar = { t?: string; o?: number; h?: number; l?: number; c?: number; v?: number };
type Snapshot = {
  latestTrade?: { p?: number; t?: string };
  latestQuote?: { bp?: number; ap?: number; t?: string };
  dailyBar?: Bar;
  prevDailyBar?: Bar;
};

function toBar(b: Bar | undefined): DailyBar | null {
  if (!b || b.t === undefined || [b.o, b.h, b.l, b.c].some((x) => typeof x !== "number")) return null;
  return { day: b.t.slice(0, 10), open: b.o!, high: b.h!, low: b.l!, close: b.c!, volume: b.v ?? null };
}

/** Pure: Alpaca snapshots response -> ticks. Exported for tests. */
export function snapshotsToTicks(body: unknown, source = "alpaca"): Tick[] {
  if (!body || typeof body !== "object") return [];
  const map = ((body as { snapshots?: unknown }).snapshots ?? body) as Record<string, Snapshot>;
  const out: Tick[] = [];
  for (const [symbol, s] of Object.entries(map)) {
    if (!s || typeof s !== "object") continue;
    const price = s.latestTrade?.p ?? s.dailyBar?.c ?? s.prevDailyBar?.c;
    if (typeof price !== "number" || !(price > 0)) continue;
    const tsRaw = s.latestTrade?.t ?? s.dailyBar?.t;
    const ts = tsRaw ? Date.parse(tsRaw) : Date.now();
    out.push({
      symbol,
      assetType: "stock",
      price,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      volume: s.dailyBar?.v ?? null,
      prevClose: typeof s.prevDailyBar?.c === "number" ? s.prevDailyBar.c : null,
      prevDay: toBar(s.prevDailyBar),
      source,
    });
  }
  return out;
}

export async function fetchAlpacaSnapshots(
  symbols: string[],
  o: { dataUrl: string; keyId: string; secret: string; fetch?: FetchLike; feed?: string },
): Promise<Tick[]> {
  const f = o.fetch ?? (fetch as unknown as FetchLike);
  const out: Tick[] = [];
  for (const part of chunk(symbols, 100)) {
    const url = `${o.dataUrl.replace(/\/$/, "")}/v2/stocks/snapshots?symbols=${encodeURIComponent(part.join(","))}&feed=${o.feed ?? "iex"}`;
    const res = await f(url, {
      headers: { "APCA-API-KEY-ID": o.keyId, "APCA-API-SECRET-KEY": o.secret },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Alpaca snapshots HTTP ${res.status}`);
    out.push(...snapshotsToTicks(await res.json()));
  }
  return out;
}
