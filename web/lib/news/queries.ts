import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cursorFilter, PAGE_SIZE, paginate, type Cursor, type NewsFilters } from "./filters";

export type NewsAlert = {
  id: string;
  created_at: string;
  read_at: string | null;
  title: string;
  body: string | null;
  symbol: string | null;
  symbols: string[];
  scope: "holding" | "watchlist" | "market" | null;
  sentiment: "positive" | "negative" | "neutral" | "mixed" | null;
  is_catalyst: boolean;
  relevance_score: number | null;
  url: string | null;
  source: string | null;
  published_at: string | null;
};

type Row = Omit<NewsAlert, "url" | "source" | "published_at" | "relevance_score"> & {
  relevance_score: number | string | null;
  news_items: { url: string; source: string; published_at: string } | { url: string; source: string; published_at: string }[] | null;
};

const COLS = "id,created_at,read_at,title,body,symbol,symbols,scope,sentiment,is_catalyst,relevance_score,news_items(url,source,published_at)";

export type NewsPage = { items: NewsAlert[]; next: Cursor | null; unread: number };

/** RLS-scoped (anon-key + user session) read of the signed-in user's news alerts. */
export async function loadNewsAlerts(supabase: SupabaseClient, f: NewsFilters): Promise<NewsPage | { error: string }> {
  let q = supabase
    .from("alerts")
    .select(COLS)
    .eq("kind", "news")
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (f.scope !== "all") q = q.eq("scope", f.scope);
  if (f.sentiment !== "all") q = q.eq("sentiment", f.sentiment);
  if (f.catalyst) q = q.eq("is_catalyst", true);
  if (f.symbol) q = q.contains("symbols", [f.symbol]);
  if (f.cursor) q = q.or(cursorFilter(f.cursor));
  const { data, error } = await q;
  if (error) return { error: error.code === "42703" || error.code === "PGRST204" || error.code === "42P01" ? "migration" : "failed" };
  const rows = ((data ?? []) as unknown as Row[]).map((r): NewsAlert => {
    const n = Array.isArray(r.news_items) ? r.news_items[0] : r.news_items;
    return { ...r, relevance_score: r.relevance_score === null ? null : Number(r.relevance_score), symbols: r.symbols ?? [], url: n?.url ?? null, source: n?.source ?? null, published_at: n?.published_at ?? null };
  });
  const { page, next } = paginate(rows);
  const { count } = await supabase.from("alerts").select("id", { count: "exact", head: true }).eq("kind", "news").is("dismissed_at", null).is("read_at", null);
  return { items: page, next, unread: count ?? 0 };
}

export type Catalyst = {
  id: string;
  title: string;
  url: string;
  source: string;
  published_at: string;
  relevance: number;
  sentiment: string;
  why_it_matters: string;
  affected_symbols: string[];
};

type CatRow = {
  relevance: number;
  sentiment: string;
  why_it_matters: string;
  affected_symbols: string[];
  news_items: { id: string; title: string; url: string; source: string; published_at: string } | { id: string; title: string; url: string; source: string; published_at: string }[];
};

/** Global broad-market catalysts (macro/market categories), independent of the user's symbols. */
export async function loadCatalysts(supabase: SupabaseClient, sinceIso: string, limit = 6): Promise<Catalyst[]> {
  const { data, error } = await supabase
    .from("news_scores")
    .select("relevance,sentiment,why_it_matters,affected_symbols,scored_at,news_items!inner(id,title,url,source,published_at,category)")
    .eq("is_catalyst", true)
    .gte("relevance", 70)
    .gte("scored_at", sinceIso)
    .in("news_items.category", ["macro", "market"])
    .order("relevance", { ascending: false })
    .order("scored_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as unknown as CatRow[]).flatMap((r) => {
    const n = Array.isArray(r.news_items) ? r.news_items[0] : r.news_items;
    return n ? [{ id: n.id, title: n.title, url: n.url, source: n.source, published_at: n.published_at, relevance: r.relevance, sentiment: r.sentiment, why_it_matters: r.why_it_matters, affected_symbols: r.affected_symbols ?? [] }] : [];
  });
}

/** Wall clock for server renders (kept out of components: React's purity lint flags Date.now() there). */
export const clock = { now: () => Date.now() };
