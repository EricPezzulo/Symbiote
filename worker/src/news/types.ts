import type { Logger } from "../types.js";

export type NewsCategory = "company" | "market" | "crypto" | "macro";
export const NEWS_CATEGORIES: NewsCategory[] = ["company", "market", "crypto", "macro"];

/** What a source returns: untrusted, unnormalized. */
export type RawNewsItem = {
  source: string;
  externalId?: string | null;
  url: string;
  title: string;
  summary?: string | null;
  publishedAt: Date | string | number | null | undefined;
  category: NewsCategory;
  /** Tickers the source itself asserts (e.g. the Finnhub symbol that was queried). Trusted but filtered to the universe. */
  symbols?: string[];
};

/** Normalized, deduped-ready item ready for insert. */
export type PreparedNewsItem = {
  source: string;
  external_id: string | null;
  url: string; // canonical
  url_hash: string;
  title_hash: string;
  title: string;
  summary: string | null;
  symbols: string[];
  category: NewsCategory;
  published_at: string; // ISO
};

export type AssetClass = "stock" | "crypto";

/** Global symbol universe (union over all users) plus per-user sets (worker/service-role only). */
export type NewsUniverse = {
  /** canonical symbol -> class */
  symbols: Map<string, AssetClass>;
  users: Map<string, { holdings: Set<string>; watchlist: Set<string> }>;
};

export type PollContext = { universe: NewsUniverse; now: number; log: Logger };

export interface NewsSource {
  readonly name: string;
  readonly category: NewsCategory;
  /** Minimum time between polls. */
  readonly intervalMs: number;
  /** Per-request timeout used by the source's HTTP calls. */
  readonly timeoutMs: number;
  /** False when a required key/config is missing: the runner skips it. */
  enabled(): boolean;
  poll(ctx: PollContext): Promise<RawNewsItem[]>;
}

export type CalendarEventRow = {
  unique_key: string;
  kind: "earnings" | "economic";
  symbol: string | null;
  title: string;
  event_at: string; // ISO
  country: string | null;
  importance: number | null;
  details: Record<string, unknown>;
  source: string;
};

export interface CalendarSource {
  readonly name: string;
  readonly intervalMs: number;
  enabled(): boolean;
  poll(ctx: PollContext): Promise<CalendarEventRow[]>;
}
