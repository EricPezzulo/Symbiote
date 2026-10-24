import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config.js";
import type { Logger } from "../types.js";
import { NewsPipeline } from "./pipeline.js";
import { NewsScorer } from "./score.js";
import { Http } from "./http.js";
import { CryptoPanicSource } from "./sources/cryptopanic.js";
import { EdgarSource } from "./sources/edgar.js";
import { EconomicCalendarStub, FinnhubCompanyNews, FinnhubEarningsCalendar, FinnhubMarketNews } from "./sources/finnhub.js";
import { RateLimiter } from "./sources/ratelimit.js";
import { defaultRssSources } from "./sources/rss.js";
import { loadNewsUniverse, NewsStore, SupabaseLedger, SupabaseScoreStore } from "./store.js";

export function createNewsPipeline(c: Config, client: SupabaseClient, log: Logger): NewsPipeline | null {
  if (!c.NEWS_ENABLED) {
    log.info("news pipeline disabled (NEWS_ENABLED=false)");
    return null;
  }
  const nlog = log.child("news");
  // SEC asks for a User-Agent that identifies the requester with contact info.
  const contact = c.NEWS_CONTACT_EMAIL ?? "contact-not-set@example.invalid";
  if (!c.NEWS_CONTACT_EMAIL) nlog.warn("NEWS_CONTACT_EMAIL is not set; SEC EDGAR may reject requests without a real contact in the User-Agent");
  const http = new Http({ userAgent: `Symbiote/0.1 (personal portfolio tracker; ${contact})`, log: nlog, backoffBaseMs: c.BACKOFF_BASE_MS, backoffMaxMs: c.BACKOFF_MAX_MS });
  const finnhubLimiter = new RateLimiter(c.FINNHUB_MIN_GAP_MS);
  const edgarLimiter = new RateLimiter(250);
  const sources = [
    ...defaultRssSources(http, c.NEWS_RSS_INTERVAL_MS),
    new EdgarSource(http, edgarLimiter),
    new FinnhubCompanyNews(http, finnhubLimiter, c.FINNHUB_API_KEY),
    new FinnhubMarketNews(http, finnhubLimiter, c.FINNHUB_API_KEY),
    new CryptoPanicSource(http, c.CRYPTOPANIC_API_KEY, c.CRYPTOPANIC_API_URL),
  ];
  const calendars = [new FinnhubEarningsCalendar(http, finnhubLimiter, c.FINNHUB_API_KEY), new EconomicCalendarStub()];
  const store = new NewsStore(client);

  let scorer: NewsScorer | null = null;
  if (c.ANTHROPIC_API_KEY) {
    scorer = new NewsScorer({
      client: new Anthropic({ apiKey: c.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 }),
      store: new SupabaseScoreStore(client),
      ledger: new SupabaseLedger(client),
      log: nlog.child("score"),
      model: c.NEWS_SCORING_MODEL,
      maxBatch: c.NEWS_MAX_BATCH,
      dailyTokenBudget: c.NEWS_DAILY_TOKEN_BUDGET,
      maxAgeHours: c.NEWS_MAX_AGE_HOURS,
    });
  } else {
    nlog.warn("ANTHROPIC_API_KEY not set: news is stored but not scored, so no news alerts are generated");
  }

  return new NewsPipeline({
    sources,
    calendars,
    sink: store,
    alertStore: store,
    loadUniverse: () => loadNewsUniverse(client),
    scorer,
    policy: { threshold: c.NEWS_ALERT_THRESHOLD, macroThreshold: c.NEWS_MACRO_ALERT_THRESHOLD, maxPerUserPerDay: c.NEWS_MAX_ALERTS_PER_USER_PER_DAY },
    log: nlog,
    scoreIntervalMs: c.NEWS_SCORE_INTERVAL_MS,
  });
}
