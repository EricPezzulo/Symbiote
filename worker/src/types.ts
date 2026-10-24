export type AssetClass = "stock" | "crypto";

/** A normalized price observation from any provider. Symbols are the app's own (AAPL, BTC). */
export type Tick = {
  symbol: string;
  assetType: AssetClass;
  price: number;
  /** Event time, ms since epoch. */
  ts: number;
  volume?: number | null;
  /** Previous close (stocks) or 24h-ago open (crypto), if the provider knows it. */
  prevClose?: number | null;
  /** Provider-computed change percent; used only when prevClose is unavailable. */
  changePct?: number | null;
  /** Full previous-day bar, written to price_history (authoritative). */
  prevDay?: DailyBar | null;
  source: string;
};

export type DailyBar = { day: string; open: number; high: number; low: number; close: number; volume: number | null };

export type ProviderStatus = "idle" | "connecting" | "open" | "reconnecting" | "stopped" | "failed";

export interface PriceProvider {
  readonly name: string;
  readonly assetType: AssetClass;
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  onTick(cb: (t: Tick) => void): void;
  start(): void | Promise<void>;
  stop(): Promise<void>;
  status(): ProviderStatus;
  /** Number of symbols currently desired (including any polled overflow). */
  symbolCount(): number;
}

export type Logger = {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(name: string): Logger;
};
