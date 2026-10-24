import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";
import { pickStockProvider } from "./config.js";
import type { Logger, PriceProvider } from "./types.js";
import { PriceWriter } from "./writer.js";
import { AlertEngine } from "./alerts.js";
import { UniverseSync } from "./universe.js";
import { createAdmin, loadLastPrices, loadUniverse, SupabaseAlertStore, SupabaseSink } from "./supabase.js";
import { AlpacaProvider } from "./providers/alpaca.js";
import { BinanceProvider } from "./providers/binance.js";
import { FinnhubProvider } from "./providers/finnhub.js";
import { CoinGeckoProvider } from "./providers/coingecko.js";
import { parseIdOverrides } from "./symbols.js";
import { createNewsPipeline } from "./news/index.js";
import type { NewsPipeline } from "./news/pipeline.js";

export function buildProviders(c: Config, log: Logger): { stock: PriceProvider | null; crypto: PriceProvider } {
  const backoff = { baseMs: c.BACKOFF_BASE_MS, maxMs: c.BACKOFF_MAX_MS };
  let stock: PriceProvider | null = null;
  const choice = pickStockProvider(c);
  if (choice === "alpaca") {
    stock = new AlpacaProvider(
      {
        wsUrl: c.ALPACA_WS_URL,
        dataUrl: c.ALPACA_DATA_URL,
        keyId: c.ALPACA_KEY_ID!,
        secret: c.ALPACA_SECRET_KEY!,
        maxSymbols: c.ALPACA_MAX_SYMBOLS,
        overflowPollMs: c.OVERFLOW_POLL_MS,
        heartbeatMs: c.HEARTBEAT_MS,
        backoff,
      },
      log.child("alpaca"),
    );
  } else if (choice === "finnhub") {
    stock = new FinnhubProvider({ apiKey: c.FINNHUB_API_KEY!, heartbeatMs: c.HEARTBEAT_MS, backoff }, log.child("finnhub"));
  } else {
    log.warn("no stock provider configured (set ALPACA_KEY_ID/ALPACA_SECRET_KEY or FINNHUB_API_KEY); stocks will not be priced");
  }
  const crypto: PriceProvider =
    c.CRYPTO_PROVIDER === "coingecko"
      ? new CoinGeckoProvider(
          { baseUrl: c.COINGECKO_API_URL, apiKey: c.COINGECKO_API_KEY, pollMs: c.COINGECKO_POLL_MS, idOverrides: parseIdOverrides(c.COINGECKO_IDS) },
          log.child("coingecko"),
        )
      : new BinanceProvider({ wsUrl: c.BINANCE_WS_URL, heartbeatMs: c.HEARTBEAT_MS, backoff }, log.child("binance"));
  return { stock, crypto };
}

export class App {
  private client: SupabaseClient;
  private writer: PriceWriter;
  private alerts: AlertEngine;
  private sync: UniverseSync;
  private providers: PriceProvider[] = [];
  private timers: NodeJS.Timeout[] = [];
  private news: NewsPipeline | null = null;
  private refreshing = false;
  private startedAt = Date.now();

  constructor(private readonly c: Config, private readonly log: Logger) {
    this.client = createAdmin(c);
    this.writer = new PriceWriter(new SupabaseSink(this.client), { intervalMs: c.WRITE_INTERVAL_MS, batchSize: c.WRITE_BATCH_SIZE }, log.child("writer"));
    this.alerts = new AlertEngine(new SupabaseAlertStore(this.client), c.ALERT_COOLDOWN_MS, log.child("alerts"));
    const { stock, crypto } = buildProviders(c, log);
    this.sync = new UniverseSync(stock, crypto, log.child("universe"));
    this.providers = [stock, crypto].filter((p): p is PriceProvider => p !== null);
    for (const p of this.providers) {
      p.onTick((t) => {
        this.writer.ingest(t);
        void this.alerts.onTick(t.symbol, t.price);
      });
    }
  }

  async start() {
    this.log.info("worker starting", {
      stockProvider: this.providers.find((p) => p.assetType === "stock")?.name ?? "none",
      cryptoProvider: this.providers.find((p) => p.assetType === "crypto")?.name,
    });
    try {
      this.alerts.seed(await loadLastPrices(this.client));
    } catch (err) {
      this.log.warn("could not seed last prices", { error: String(err instanceof Error ? err.message : err) });
    }
    await this.refreshUniverse();
    this.writer.start();
    for (const p of this.providers) await p.start();
    this.timers.push(setInterval(() => void this.refreshUniverse(), this.c.UNIVERSE_REFRESH_MS));
    // News must never take down price ingest: isolate its startup.
    try {
      this.news = createNewsPipeline(this.c, this.client, this.log);
      await this.news?.start();
    } catch (err) {
      this.log.error("news pipeline failed to start", { error: err instanceof Error ? err.message : String(err) });
    }
    this.timers.push(setInterval(() => this.health(), this.c.HEALTH_LOG_MS));
  }

  async refreshUniverse() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { sets, rules } = await loadUniverse(this.client);
      this.alerts.setRules(rules);
      this.sync.apply(sets);
    } catch (err) {
      this.log.error("universe refresh failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.refreshing = false;
    }
  }

  health() {
    const w = this.writer.stats;
    this.log.info("health", {
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      ...this.sync.counts(),
      providers: Object.fromEntries(this.providers.map((p) => [p.name, `${p.status()}:${p.symbolCount()}`])),
      ticks: w.ticks,
      rowsWritten: w.rowsWritten,
      writeErrors: w.writeErrors,
      pending: this.writer.pendingCount(),
      alertsFired: this.alerts.fired,
    });
  }

  async stop() {
    this.log.info("worker stopping");
    for (const t of this.timers) clearInterval(t);
    await this.news?.stop();
    await Promise.allSettled(this.providers.map((p) => p.stop()));
    await this.writer.stop();
    this.log.info("worker stopped");
  }
}
