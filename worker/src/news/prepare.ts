import { canonicalizeUrl, titleHash, urlHash } from "./canonical.js";
import type { Matcher } from "./entities.js";
import { toPlainText } from "./text.js";
import type { NewsUniverse, PreparedNewsItem, RawNewsItem } from "./types.js";

function toDate(v: RawNewsItem["publishedAt"], now: number): Date {
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : v instanceof Date ? v : v ? new Date(v) : new Date(NaN);
  if (Number.isNaN(d.getTime())) return new Date(now);
  // Feeds sometimes carry future timestamps (timezone bugs); never trust more than 1h ahead.
  return d.getTime() > now + 3_600_000 ? new Date(now) : d;
}

/** Normalize, hash, map to symbols, and dedupe a batch (by canonical URL hash and normalized title hash). */
export function prepareItems(raw: RawNewsItem[], universe: NewsUniverse, matcher: Matcher, now = Date.now()): PreparedNewsItem[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: PreparedNewsItem[] = [];
  for (const r of raw) {
    const url = canonicalizeUrl(r.url ?? "");
    const title = toPlainText(r.title, 300);
    if (!url || title.length < 8) continue;
    const uh = urlHash(url);
    const th = titleHash(title);
    if (seenUrl.has(uh) || seenTitle.has(th)) continue;
    seenUrl.add(uh);
    seenTitle.add(th);
    const summary = toPlainText(r.summary ?? "", 600) || null;
    const trusted = (r.symbols ?? []).map((s) => s.trim().toUpperCase()).filter((s) => universe.symbols.has(s));
    const symbols = [...new Set([...trusted, ...matcher.match(`${title}. ${summary ?? ""}`)])].sort();
    out.push({
      source: r.source,
      external_id: r.externalId ? String(r.externalId).slice(0, 200) : null,
      url,
      url_hash: uh,
      title_hash: th,
      title,
      summary,
      symbols,
      category: r.category,
      published_at: toDate(r.publishedAt, now).toISOString(),
    });
  }
  return out;
}
