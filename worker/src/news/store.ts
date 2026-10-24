import type { SupabaseClient } from "@supabase/supabase-js";
import { cryptoBase, normalizeSymbol } from "../symbols.js";
import { fetchAll } from "../supabase.js";
import type { NewsAlertRow, ScoredItem } from "./alerts.js";
import type { BudgetLedger, PendingItem, ScoreRow, ScoreStore, Usage } from "./score.js";
import type { AssetClass, CalendarEventRow, NewsCategory, NewsUniverse, PreparedNewsItem } from "./types.js";

export const MAX_SCORE_ATTEMPTS = 3;
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

/** Service-role read of every user's symbols. Quantities, balances and cost basis are deliberately NOT selected. */
export async function loadNewsUniverse(client: SupabaseClient): Promise<NewsUniverse> {
  const [holdings, watch] = await Promise.all([
    fetchAll<{ user_id: string; symbol: string; asset_type: string }>(client, "holdings", "id,user_id,symbol,asset_type"),
    fetchAll<{ user_id: string; symbol: string; asset_type: string }>(client, "watchlist", "id,user_id,symbol,asset_type"),
  ]);
  const symbols = new Map<string, AssetClass>();
  const users: NewsUniverse["users"] = new Map();
  const add = (row: { user_id: string; symbol: string; asset_type: string }, kind: "holdings" | "watchlist") => {
    let cls: AssetClass | null = null;
    if (row.asset_type === "stock" || row.asset_type === "etf") cls = "stock";
    else if (row.asset_type === "crypto") cls = "crypto";
    if (!cls) return;
    const sym = cls === "crypto" ? cryptoBase(row.symbol) : normalizeSymbol(row.symbol);
    if (!sym) return;
    symbols.set(sym, cls);
    const u = users.get(row.user_id) ?? { holdings: new Set<string>(), watchlist: new Set<string>() };
    u[kind].add(sym);
    users.set(row.user_id, u);
  };
  holdings.forEach((r) => add(r, "holdings"));
  watch.forEach((r) => add(r, "watchlist"));
  return { symbols, users };
}

export class NewsStore {
  constructor(private readonly client: SupabaseClient) {}

  /** Insert items not seen before (by URL hash, or by title hash in the last 3 days). Returns the number inserted. */
  async insertNew(items: PreparedNewsItem[]): Promise<number> {
    if (!items.length) return 0;
    const fresh: PreparedNewsItem[] = [];
    const urlSeen = new Set<string>();
    const titleSeen = new Set<string>();
    for (const part of chunk(items, 100)) {
      const [u, t] = await Promise.all([
        this.client.from("news_items").select("url_hash").in("url_hash", part.map((i) => i.url_hash)),
        this.client
          .from("news_items")
          .select("title_hash")
          .in("title_hash", part.map((i) => i.title_hash))
          .gte("created_at", new Date(Date.now() - 3 * 86_400_000).toISOString()),
      ]);
      if (u.error) throw new Error(`news_items: ${u.error.message}`);
      if (t.error) throw new Error(`news_items: ${t.error.message}`);
      u.data?.forEach((r: { url_hash: string }) => urlSeen.add(r.url_hash));
      t.data?.forEach((r: { title_hash: string }) => titleSeen.add(r.title_hash));
    }
    for (const i of items) if (!urlSeen.has(i.url_hash) && !titleSeen.has(i.title_hash)) fresh.push(i);
    let inserted = 0;
    for (const part of chunk(fresh, 100)) {
      const rows = part.map((i) => ({ ...i, fetched_at: new Date().toISOString() }));
      const { data, error } = await this.client.from("news_items").upsert(rows, { onConflict: "url_hash", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(`news_items: ${error.message}`);
      inserted += data?.length ?? 0;
    }
    return inserted;
  }

  async upsertCalendar(rows: CalendarEventRow[]): Promise<void> {
    for (const part of chunk(rows, 200)) {
      const { error } = await this.client.from("calendar_events").upsert(part.map((r) => ({ ...r, fetched_at: new Date().toISOString() })), { onConflict: "unique_key" });
      if (error) throw new Error(`calendar_events: ${error.message}`);
    }
  }

  /** Scored items since `sinceIso` with relevance >= minRelevance, for alert generation. */
  async scoredSince(sinceIso: string, minRelevance: number): Promise<ScoredItem[]> {
    const { data, error } = await this.client
      .from("news_scores")
      .select("news_item_id,relevance,sentiment,is_catalyst,affected_symbols,why_it_matters,news_items!inner(title,category,symbols)")
      .gte("scored_at", sinceIso)
      .gte("relevance", minRelevance)
      .limit(1000);
    if (error) throw new Error(`news_scores: ${error.message}`);
    return (data ?? []).map((r: any) => {
      const n = Array.isArray(r.news_items) ? r.news_items[0] : r.news_items; // eslint-disable-line @typescript-eslint/no-explicit-any
      return {
        news_item_id: r.news_item_id,
        title: n?.title ?? "",
        category: (n?.category ?? "market") as NewsCategory,
        item_symbols: n?.symbols ?? [],
        relevance: r.relevance,
        sentiment: r.sentiment,
        is_catalyst: r.is_catalyst,
        affected_symbols: r.affected_symbols ?? [],
        why_it_matters: r.why_it_matters ?? "",
      } satisfies ScoredItem;
    });
  }

  async existingAlertPairs(itemIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunk(itemIds, 100)) {
      const { data, error } = await this.client.from("alerts").select("user_id,news_item_id").in("news_item_id", part);
      if (error) throw new Error(`alerts: ${error.message}`);
      data?.forEach((r: { user_id: string; news_item_id: string }) => out.add(`${r.user_id}|${r.news_item_id}`));
    }
    return out;
  }

  async newsAlertCountsToday(nowMs: number): Promise<Map<string, number>> {
    const start = new Date(nowMs);
    start.setUTCHours(0, 0, 0, 0);
    const { data, error } = await this.client.from("alerts").select("user_id").eq("kind", "news").gte("created_at", start.toISOString()).limit(50_000);
    if (error) throw new Error(`alerts: ${error.message}`);
    const m = new Map<string, number>();
    data?.forEach((r: { user_id: string }) => m.set(r.user_id, (m.get(r.user_id) ?? 0) + 1));
    return m;
  }

  /** Idempotent: unique (user_id, news_item_id) + ignoreDuplicates. Returns rows actually created. */
  async insertAlerts(rows: NewsAlertRow[]): Promise<number> {
    let n = 0;
    for (const part of chunk(rows, 200)) {
      const { data, error } = await this.client.from("alerts").upsert(part, { onConflict: "user_id,news_item_id", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(`alerts: ${error.message}`);
      n += data?.length ?? 0;
    }
    return n;
  }
}

export class SupabaseScoreStore implements ScoreStore {
  constructor(private readonly client: SupabaseClient) {}

  async fetchPending(limit: number, sinceIso: string): Promise<PendingItem[]> {
    const { data, error } = await this.client
      .from("news_items")
      .select("id,title,summary,source,category,symbols,published_at,score_attempts")
      .eq("score_status", "pending")
      .gte("published_at", sinceIso)
      .order("published_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`news_items: ${error.message}`);
    return (data ?? []) as PendingItem[];
  }

  async saveScores(rows: ScoreRow[], per: Usage): Promise<void> {
    const { error } = await this.client
      .from("news_scores")
      .upsert(rows.map((r) => ({ ...r, input_tokens: per.input + per.cacheRead + per.cacheWrite, output_tokens: per.output })), { onConflict: "news_item_id", ignoreDuplicates: true });
    if (error) throw new Error(`news_scores: ${error.message}`);
    const { error: e2 } = await this.client.from("news_items").update({ score_status: "scored" }).in("id", rows.map((r) => r.news_item_id));
    if (e2) throw new Error(`news_items: ${e2.message}`);
  }

  async markSkipped(ids: string[]): Promise<void> {
    for (const part of chunk(ids, 100)) {
      const { error } = await this.client.from("news_items").update({ score_status: "skipped" }).in("id", part).eq("score_status", "pending");
      if (error) throw new Error(`news_items: ${error.message}`);
    }
  }

  async recordFailure(items: Pick<PendingItem, "id" | "score_attempts">[]): Promise<void> {
    for (const it of items) {
      const attempts = it.score_attempts + 1;
      const { error } = await this.client
        .from("news_items")
        .update({ score_attempts: attempts, score_status: attempts >= MAX_SCORE_ATTEMPTS ? "failed" : "pending" })
        .eq("id", it.id);
      if (error) throw new Error(`news_items: ${error.message}`);
    }
  }
}

export class SupabaseLedger implements BudgetLedger {
  constructor(private readonly client: SupabaseClient, private readonly now: () => number = Date.now) {}
  private day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
  async today() {
    const { data, error } = await this.client.from("news_usage").select("input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,requests").eq("day", this.day()).maybeSingle();
    if (error) throw new Error(`news_usage: ${error.message}`);
    if (!data) return { tokens: 0, requests: 0 };
    return { tokens: Number(data.input_tokens) + Number(data.output_tokens) + Number(data.cache_read_tokens) + Number(data.cache_write_tokens), requests: Number(data.requests) };
  }
  async record(u: Usage, requests: number, itemsScored: number) {
    const { error } = await this.client.rpc("news_usage_add", {
      p_day: this.day(), p_input: u.input, p_output: u.output, p_cache_read: u.cacheRead, p_cache_write: u.cacheWrite, p_requests: requests, p_items: itemsScored,
    });
    if (error) throw new Error(`news_usage_add: ${error.message}`);
  }
}
