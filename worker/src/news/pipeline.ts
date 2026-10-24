import type { Logger } from "../types.js";
import { planNewsAlerts, type AlertPolicy, type NewsAlertRow, type ScoredItem, type UserSymbols } from "./alerts.js";
import { buildMatcher, type Matcher } from "./entities.js";
import { prepareItems } from "./prepare.js";
import type { NewsScorer } from "./score.js";
import type { CalendarEventRow, CalendarSource, NewsSource, NewsUniverse, PreparedNewsItem, RawNewsItem } from "./types.js";

// ------------------------------------------------------------------ alert generation
export interface AlertDataStore {
  scoredSince(sinceIso: string, minRelevance: number): Promise<ScoredItem[]>;
  existingAlertPairs(itemIds: string[]): Promise<Set<string>>;
  newsAlertCountsToday(nowMs: number): Promise<Map<string, number>>;
  insertAlerts(rows: NewsAlertRow[]): Promise<number>;
}

/** Everything user-specific stays inside the worker; scores are global and symbol-agnostic. */
export async function generateAlerts(store: AlertDataStore, users: Map<string, UserSymbols>, policy: AlertPolicy, sinceIso: string, nowMs: number): Promise<number> {
  if (!users.size) return 0;
  const items = await store.scoredSince(sinceIso, Math.min(policy.threshold, policy.macroThreshold));
  if (!items.length) return 0;
  const [existing, counts] = await Promise.all([store.existingAlertPairs(items.map((i) => i.news_item_id)), store.newsAlertCountsToday(nowMs)]);
  const rows = planNewsAlerts({ items, users, policy, existing, countsToday: counts });
  return rows.length ? store.insertAlerts(rows) : 0;
}

// ------------------------------------------------------------------ pipeline
export interface NewsSink {
  insertNew(items: PreparedNewsItem[]): Promise<number>;
  upsertCalendar(rows: CalendarEventRow[]): Promise<void>;
}

export type PipelineOptions = {
  sources: NewsSource[];
  calendars: CalendarSource[];
  sink: NewsSink;
  alertStore: AlertDataStore;
  loadUniverse: () => Promise<NewsUniverse>;
  scorer: NewsScorer | null;
  policy: AlertPolicy;
  log: Logger;
  scoreIntervalMs: number;
  universeRefreshMs?: number;
  /** Items older than this at ingest are dropped (keeps the table small; feeds can return months of history). */
  maxIngestAgeMs?: number;
  now?: () => number;
};

const MAX_BACKOFF_MS = 3_600_000;

export class NewsPipeline {
  private universe: NewsUniverse = { symbols: new Map(), users: new Map() };
  private matcher: Matcher = buildMatcher(new Map());
  private timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private lastAlertScan: number;
  private readonly now: () => number;
  stats = { polls: 0, pollErrors: 0, ingested: 0, alerts: 0, scored: 0 };

  constructor(private readonly o: PipelineOptions) {
    this.now = o.now ?? Date.now;
    this.lastAlertScan = this.now() - 24 * 3_600_000; // overlap on restart; inserts are idempotent
  }

  async start() {
    await this.refreshUniverse();
    const active = this.o.sources.filter((s) => s.enabled());
    const calendars = this.o.calendars.filter((c) => c.enabled());
    this.o.log.info("news pipeline starting", {
      sources: active.map((s) => `${s.name}:${s.category}`),
      disabledSources: this.o.sources.filter((s) => !s.enabled()).map((s) => `${s.name}:${s.category}`),
      calendars: calendars.map((c) => c.name),
      scoring: this.o.scorer ? "on" : "off (no ANTHROPIC_API_KEY)",
    });
    active.forEach((s, i) => this.loop(`${s.name}:${s.category}`, s.intervalMs, 1000 + i * 1500, async () => void (await this.pollSource(s))));
    calendars.forEach((c, i) => this.loop(`calendar:${c.name}`, c.intervalMs, 20_000 + i * 2000, () => this.pollCalendar(c)));
    this.loop("universe", this.o.universeRefreshMs ?? 60_000, this.o.universeRefreshMs ?? 60_000, () => this.refreshUniverse(), false);
    this.loop("score+alerts", this.o.scoreIntervalMs, 15_000, () => this.scoreAndAlert());
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private loop(name: string, intervalMs: number, firstDelayMs: number, fn: () => Promise<void>, backoff = true) {
    let failures = 0;
    const schedule = (delay: number) => {
      if (this.stopped) return;
      const t = setTimeout(async () => {
        this.timers.delete(t);
        try {
          await fn();
          failures = 0;
        } catch (err) {
          failures++;
          this.o.log.warn("news task failed", { task: name, failures, error: err instanceof Error ? err.message : String(err) });
        }
        schedule(backoff ? Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(failures, 6)) : intervalMs);
      }, delay);
      t.unref?.();
      this.timers.add(t);
    };
    schedule(firstDelayMs);
  }

  async refreshUniverse() {
    this.universe = await this.o.loadUniverse();
    this.matcher = buildMatcher(this.universe.symbols);
  }

  /** Poll one source and write new items. Exposed for tests. */
  async pollSource(s: NewsSource): Promise<number> {
    this.stats.polls++;
    let raw: RawNewsItem[];
    try {
      raw = await s.poll({ universe: this.universe, now: this.now(), log: this.o.log });
    } catch (err) {
      this.stats.pollErrors++;
      throw err;
    }
    const cutoff = this.now() - (this.o.maxIngestAgeMs ?? 7 * 86_400_000);
    const fresh = raw.filter((r) => {
      const t = r.publishedAt ? new Date(typeof r.publishedAt === "number" && r.publishedAt < 1e12 ? r.publishedAt * 1000 : r.publishedAt).getTime() : NaN;
      return Number.isNaN(t) || t >= cutoff;
    });
    const prepared = prepareItems(fresh, this.universe, this.matcher, this.now());
    const n = await this.o.sink.insertNew(prepared);
    this.stats.ingested += n;
    this.o.log.info("news polled", { source: s.name, category: s.category, fetched: raw.length, kept: prepared.length, inserted: n });
    return n;
  }

  async pollCalendar(c: CalendarSource) {
    const rows = await c.poll({ universe: this.universe, now: this.now(), log: this.o.log });
    if (rows.length) await this.o.sink.upsertCalendar(rows);
    this.o.log.info("calendar polled", { source: c.name, events: rows.length });
  }

  async scoreAndAlert() {
    if (this.o.scorer) {
      const r = await this.o.scorer.run();
      this.stats.scored += r.scored;
      if (r.examined) this.o.log.info("news scoring run", { ...r });
    }
    const runStart = this.now();
    const n = await generateAlerts(this.o.alertStore, this.universe.users, this.o.policy, new Date(this.lastAlertScan).toISOString(), runStart);
    this.lastAlertScan = runStart - 5 * 60_000; // small overlap; idempotent
    this.stats.alerts += n;
    if (n) this.o.log.info("news alerts created", { count: n });
  }
}
