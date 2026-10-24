// Shared (server + client) price row shape and helpers. No server-only imports here.

export type PriceRow = {
  symbol: string;
  asset_type: string;
  price: number;
  change_24h_pct: number | null;
  prev_close: number | null;
  volume_24h: number | null;
  source: string | null;
  updated_at: string;
};

export const PRICE_COLUMNS = "symbol,asset_type,price,change_24h_pct,prev_close,volume_24h,source,updated_at";

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Coerce a raw PostgREST / Realtime row (numerics may arrive as strings). Returns null if unusable. */
export function toPriceRow(raw: Record<string, unknown> | null | undefined): PriceRow | null {
  if (!raw || typeof raw.symbol !== "string") return null;
  const price = n(raw.price);
  if (price === null) return null;
  return {
    symbol: raw.symbol,
    asset_type: typeof raw.asset_type === "string" ? raw.asset_type : "stock",
    price,
    change_24h_pct: n(raw.change_24h_pct),
    prev_close: n(raw.prev_close),
    volume_24h: n(raw.volume_24h),
    source: typeof raw.source === "string" ? raw.source : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date(0).toISOString(),
  };
}

/** Prefer whichever row has the newer updated_at (ties go to `b`, the live one). */
export function newer(a: PriceRow | undefined, b: PriceRow | undefined): PriceRow | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.updated_at) >= Date.parse(a.updated_at) ? b : a;
}

export function agoLabel(updatedAt: string | null | undefined, nowMs: number): string {
  if (!updatedAt) return "never";
  const s = Math.max(0, Math.round((nowMs - Date.parse(updatedAt)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * A price is "stale" when it should be ticking but is not. Crypto trades 24/7 (2 min grace);
 * stocks only count as stale while the US market is open (IEX can be quiet on thin names, so 5 min).
 */
export function isStale(row: Pick<PriceRow, "asset_type" | "updated_at">, nowMs: number, marketOpen: boolean): boolean {
  const age = nowMs - Date.parse(row.updated_at);
  if (row.asset_type === "crypto") return age > 120_000;
  return marketOpen && age > 300_000;
}
