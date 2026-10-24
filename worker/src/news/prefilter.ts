import type { NewsCategory } from "./types.js";

export type FilterInput = {
  title: string;
  summary: string | null;
  source: string;
  category: NewsCategory;
  symbols: string[];
};

export type FilterResult = { candidate: boolean; priority: number; reason: string };

/** Sources whose every item is worth a score even without a symbol match. */
export const HIGH_PRIORITY_SOURCES = new Set(["federalreserve", "sec-edgar"]);

const MACRO_KEYWORDS = new RegExp(
  "\\b(" +
    [
      "fed", "fomc", "federal reserve", "powell", "rate cut", "rate hike", "interest rates?", "inflation", "cpi", "ppi", "pce",
      "jobs report", "payrolls?", "unemployment", "gdp", "recession", "tariffs?", "treasury yields?", "debt ceiling",
      "government shutdown", "bank (?:failure|run|collapse)", "sanctions?", "ecb", "bank of japan", "boj", "opec", "oil prices?",
      "market (?:crash|selloff|rout|rally)", "circuit breaker", "downgrade[sd]?", "default",
      "etf approval", "spot etf", "stablecoin", "hack(?:ed)?", "exploit", "crypto regulation", "sec (?:sues|charges|approves)",
      "bankruptcy", "halted", "trading halt",
    ].join("|") +
    ")\\b",
  "i",
);

export function hasMacroKeyword(text: string): boolean {
  return MACRO_KEYWORDS.test(text);
}

/**
 * Stage (a) of scoring: free, local, deterministic. Decides which items are worth a (cheap but not free)
 * model call and in what order. Higher priority is scored first.
 */
export function prefilter(i: FilterInput): FilterResult {
  const text = `${i.title} ${i.summary ?? ""}`;
  const highSource = HIGH_PRIORITY_SOURCES.has(i.source);
  if (i.symbols.length > 0) {
    return { candidate: true, priority: 50 + (highSource ? 30 : 0) + (hasMacroKeyword(text) ? 10 : 0) + Math.min(i.symbols.length, 3), reason: "symbol" };
  }
  if (highSource) return { candidate: true, priority: 60, reason: "source" };
  if ((i.category === "macro" || i.category === "market" || i.category === "crypto") && hasMacroKeyword(text)) {
    return { candidate: true, priority: i.category === "macro" ? 40 : 30, reason: "keyword" };
  }
  return { candidate: false, priority: 0, reason: "no-match" };
}
