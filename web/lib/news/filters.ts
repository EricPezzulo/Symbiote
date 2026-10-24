// Pure helpers for the /news page: filter parsing, cursor pagination, URL safety, relative time.

export const PAGE_SIZE = 20;
export const SCOPES = ["all", "holding", "watchlist", "market"] as const;
export const SENTIMENT_FILTERS = ["all", "positive", "negative"] as const;
export type Scope = (typeof SCOPES)[number];
export type SentimentFilter = (typeof SENTIMENT_FILTERS)[number];

export type NewsFilters = {
  scope: Scope;
  sentiment: SentimentFilter;
  catalyst: boolean;
  symbol: string | null;
  cursor: Cursor | null;
};

export type Cursor = { createdAt: string; id: string };

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Raw PostgREST timestamptz strings keep microseconds; JS Dates would truncate and break keyset ties.
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function parseSymbol(v: string | undefined): string | null {
  const s = v?.trim().toUpperCase();
  return s && SYMBOL_RE.test(s) ? s : null;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}

/** Strictly validated: the decoded parts are interpolated into a PostgREST filter, so anything unexpected is rejected. */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw || raw.length > 200) return null;
  try {
    const [createdAt, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (extra !== undefined || !createdAt || !id || !TS_RE.test(createdAt) || !UUID_RE.test(id)) return null;
    return { createdAt, id: id.toLowerCase() };
  } catch {
    return null;
  }
}

export function parseFilters(sp: Params): NewsFilters {
  const scope = first(sp.scope);
  const sentiment = first(sp.sentiment);
  return {
    scope: (SCOPES as readonly string[]).includes(scope ?? "") ? (scope as Scope) : "all",
    sentiment: (SENTIMENT_FILTERS as readonly string[]).includes(sentiment ?? "") ? (sentiment as SentimentFilter) : "all",
    catalyst: first(sp.catalyst) === "1",
    symbol: parseSymbol(first(sp.symbol)),
    cursor: decodeCursor(first(sp.cursor)),
  };
}

/** Query string for a filter state (defaults omitted). Pass `cursor` to link to the next page. */
export function filtersToQuery(f: Omit<NewsFilters, "cursor">, cursor?: Cursor | null): string {
  const q = new URLSearchParams();
  if (f.scope !== "all") q.set("scope", f.scope);
  if (f.sentiment !== "all") q.set("sentiment", f.sentiment);
  if (f.catalyst) q.set("catalyst", "1");
  if (f.symbol) q.set("symbol", f.symbol);
  if (cursor) q.set("cursor", encodeCursor(cursor));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Keyset predicate for ORDER BY created_at desc, id desc. Safe only with a decoded (validated) cursor. */
export function cursorFilter(c: Cursor): string {
  return `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`;
}

/** Split a PAGE_SIZE+1 fetch into the page and the next cursor. */
export function paginate<T extends { id: string; created_at: string }>(rows: T[], pageSize = PAGE_SIZE): { page: T[]; next: Cursor | null } {
  if (rows.length <= pageSize) return { page: rows, next: null };
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return { page, next: { createdAt: last.created_at, id: last.id } };
}

/** Only absolute http(s) URLs are ever rendered as links. */
export function safeHttpUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 2048) return null;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : null;
  } catch {
    return null;
  }
}

export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export type RelevanceLevel = { label: string; bars: 1 | 2 | 3 | 4 };
export function relevanceLevel(score01: number | null | undefined): RelevanceLevel {
  const pct = Math.round((score01 ?? 0) * 100);
  if (pct >= 80) return { label: "Critical", bars: 4 };
  if (pct >= 70) return { label: "High", bars: 3 };
  if (pct >= 60) return { label: "Relevant", bars: 2 };
  return { label: "Low", bars: 1 };
}

export const SENTIMENT_LABELS: Record<string, string> = { positive: "Positive", negative: "Negative", neutral: "Neutral", mixed: "Mixed" };
