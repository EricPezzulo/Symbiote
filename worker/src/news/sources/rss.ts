import { parseFeed } from "../feed.js";
import type { Http } from "../http.js";
import type { NewsCategory, NewsSource, PollContext, RawNewsItem } from "../types.js";

export type RssSourceConfig = {
  name: string;
  url: string;
  category: NewsCategory;
  intervalMs: number;
  timeoutMs?: number;
};

/** Generic RSS/Atom headline feed. Uses ETag / If-Modified-Since; only feed-provided title + summary are kept. */
export class RssSource implements NewsSource {
  readonly name: string;
  readonly category: NewsCategory;
  readonly intervalMs: number;
  readonly timeoutMs: number;

  constructor(private readonly cfg: RssSourceConfig, private readonly http: Http) {
    this.name = cfg.name;
    this.category = cfg.category;
    this.intervalMs = cfg.intervalMs;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  enabled() {
    return true;
  }

  async poll(_ctx: PollContext): Promise<RawNewsItem[]> {
    const res = await this.http.get(this.cfg.url, { conditional: true, timeoutMs: this.timeoutMs, maxBytes: 5_000_000 });
    if (res.notModified) return [];
    return parseFeed(res.body).map((e) => ({
      source: this.name,
      externalId: e.id,
      url: e.link ?? "",
      title: e.title,
      summary: e.summary,
      publishedAt: e.published,
      category: this.category,
    }));
  }
}

/**
 * Feeds verified reachable on 2026-10-24 (HTTP 200, RSS 2.0). See README for terms-of-use caveats.
 * Reuters has no public RSS any more (skipped). MarketWatch redirects to the Dow Jones feed host.
 */
export function defaultRssSources(http: Http, intervalMs = 5 * 60_000): RssSource[] {
  const s = (name: string, url: string, category: NewsCategory, interval = intervalMs) => new RssSource({ name, url, category, intervalMs: interval }, http);
  return [
    s("federalreserve", "https://www.federalreserve.gov/feeds/press_all.xml", "macro", 10 * 60_000),
    s("cnbc", "https://www.cnbc.com/id/100003114/device/rss/rss.html", "market"),
    s("marketwatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories", "market"),
    s("coindesk", "https://www.coindesk.com/arc/outboundfeeds/rss", "crypto"),
    s("cointelegraph", "https://cointelegraph.com/rss", "crypto"),
    s("theblock", "https://www.theblock.co/rss.xml", "crypto"),
  ];
}
