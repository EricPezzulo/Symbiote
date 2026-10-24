import type { NewsCategory } from "./types.js";

export type ScoredItem = {
  news_item_id: string;
  title: string;
  category: NewsCategory;
  item_symbols: string[];
  relevance: number;
  sentiment: string;
  is_catalyst: boolean;
  affected_symbols: string[];
  why_it_matters: string;
};

export type UserSymbols = { holdings: Set<string>; watchlist: Set<string> };

export type NewsAlertRow = {
  user_id: string;
  news_item_id: string;
  kind: "news";
  scope: "holding" | "watchlist" | "market";
  symbol: string | null;
  symbols: string[];
  severity: number;
  relevance_score: number; // 0..1
  sentiment: string;
  is_catalyst: boolean;
  title: string;
  body: string;
};

export type AlertPolicy = {
  threshold: number;
  macroThreshold: number;
  maxPerUserPerDay: number;
};

export const severityFor = (relevance: number, catalyst: boolean) =>
  Math.min(5, (relevance >= 90 ? 5 : relevance >= 80 ? 4 : relevance >= 70 ? 3 : relevance >= 60 ? 2 : 1) + (catalyst && relevance >= 60 ? 1 : 0));

/**
 * Decide which alerts to create. Pure: callers pass what already exists (idempotency) and today's counts (caps).
 * A user gets an alert when a scored item affects one of their holdings/watchlist symbols at relevance >= threshold,
 * or it is a high-relevance macro/market catalyst. Highest relevance first; capped per user per UTC day.
 */
export function planNewsAlerts(args: {
  items: ScoredItem[];
  users: Map<string, UserSymbols>;
  policy: AlertPolicy;
  existing: Set<string>; // `${user_id}|${news_item_id}`
  countsToday: Map<string, number>;
}): NewsAlertRow[] {
  const { items, users, policy, existing, countsToday } = args;
  const sorted = [...items].sort((a, b) => b.relevance - a.relevance || (a.news_item_id < b.news_item_id ? -1 : 1));
  const used = new Map(countsToday);
  const out: NewsAlertRow[] = [];
  for (const it of sorted) {
    const affected = it.affected_symbols.length ? it.affected_symbols : it.item_symbols;
    for (const [userId, sets] of users) {
      if (existing.has(`${userId}|${it.news_item_id}`)) continue;
      if ((used.get(userId) ?? 0) >= policy.maxPerUserPerDay) continue;
      const matched = affected.filter((s) => sets.holdings.has(s) || sets.watchlist.has(s));
      let scope: NewsAlertRow["scope"] | null = null;
      if (matched.length && it.relevance >= policy.threshold) scope = matched.some((s) => sets.holdings.has(s)) ? "holding" : "watchlist";
      else if (it.is_catalyst && (it.category === "macro" || it.category === "market") && it.relevance >= policy.macroThreshold) scope = "market";
      if (!scope) continue;
      used.set(userId, (used.get(userId) ?? 0) + 1);
      out.push({
        user_id: userId,
        news_item_id: it.news_item_id,
        kind: "news",
        scope,
        symbol: scope === "market" ? null : matched[0],
        symbols: scope === "market" ? [] : matched,
        severity: severityFor(it.relevance, it.is_catalyst),
        relevance_score: Math.round(it.relevance) / 100,
        sentiment: it.sentiment,
        is_catalyst: it.is_catalyst,
        title: it.title.slice(0, 300),
        body: it.why_it_matters,
      });
    }
  }
  return out;
}
