import type { AssetClass } from "./types.js";

/** Canonical app symbol: trimmed, upper case. */
export function normalizeSymbol(s: string): string {
  return s.trim().toUpperCase();
}

/** Map a holdings/watchlist asset_type to the stream class, or null when it is not priced from a feed. */
export function classOf(assetType: string): AssetClass | null {
  if (assetType === "stock" || assetType === "etf") return "stock";
  if (assetType === "crypto") return "crypto";
  return null;
}

// ---------------------------------------------------------------- crypto
/** Accept "BTC", "btc", "BTC-USD", "BTC/USD", "BTCUSDT" -> base asset "BTC". */
export function cryptoBase(symbol: string): string {
  let s = normalizeSymbol(symbol);
  s = s.replace(/[-/_](USD|USDT)$/, "");
  return s;
}

/** BTC -> BTCUSDT (Binance spot quote asset). */
export function toBinancePair(symbol: string): string {
  const base = cryptoBase(symbol);
  return base.endsWith("USDT") && base.length > 4 ? base : `${base}USDT`;
}

export function toBinanceStream(symbol: string): string {
  return `${toBinancePair(symbol).toLowerCase()}@miniTicker`;
}

/** Reverse of toBinancePair for a given tracked set: BTCUSDT -> BTC (or undefined if untracked). */
export function binanceReverseMap(symbols: Iterable<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of symbols) m.set(toBinancePair(s), normalizeSymbol(s));
  return m;
}

/** Common CoinGecko ids for the CoinGecko fallback; extend via COINGECKO_IDS. */
export const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  LINK: "chainlink",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  TRX: "tron",
  ATOM: "cosmos",
  UNI: "uniswap",
  XLM: "stellar",
  ETC: "ethereum-classic",
  NEAR: "near",
  ARB: "arbitrum",
  OP: "optimism",
  AAVE: "aave",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  SHIB: "shiba-inu",
};

export function parseIdOverrides(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const [k, v] = part.split(":").map((x) => x?.trim());
    if (k && v) out[normalizeSymbol(k)] = v.toLowerCase();
  }
  return out;
}

// ---------------------------------------------------------------- diffing
export type SymbolSets = { stocks: Set<string>; crypto: Set<string> };

export function diffSets(current: ReadonlySet<string>, next: ReadonlySet<string>) {
  const added = [...next].filter((s) => !current.has(s)).sort();
  const removed = [...current].filter((s) => !next.has(s)).sort();
  return { added, removed };
}

/** Build the stock/crypto universe from raw rows (holdings + watchlist). */
export function buildUniverse(rows: Iterable<{ symbol: string; asset_type: string }>): SymbolSets {
  const u: SymbolSets = { stocks: new Set(), crypto: new Set() };
  for (const r of rows) {
    const cls = classOf(r.asset_type);
    if (!cls || !r.symbol) continue;
    if (cls === "stock") {
      const s = normalizeSymbol(r.symbol);
      // Alpaca/Finnhub stock symbols: letters, digits, dot/dash (BRK.B).
      if (/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(s)) u.stocks.add(s);
    } else {
      const s = cryptoBase(r.symbol);
      if (/^[A-Z0-9]{1,15}$/.test(s)) u.crypto.add(s);
    }
  }
  return u;
}
