import { z } from "zod";

const num = (def: number, min = 0) => z.coerce.number().min(min).default(def);
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = z.preprocess(blank, z.string().optional());

const schema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ALPACA_KEY_ID: optStr,
  ALPACA_SECRET_KEY: optStr,
  ALPACA_WS_URL: z.preprocess(blank, z.string().default("wss://stream.data.alpaca.markets/v2/iex")),
  ALPACA_DATA_URL: z.preprocess(blank, z.string().default("https://data.alpaca.markets")),
  /** Free Basic plan allows 30 websocket symbols; overflow is polled via REST snapshots. */
  ALPACA_MAX_SYMBOLS: num(30, 1),
  FINNHUB_API_KEY: optStr,
  STOCK_PROVIDER: z.preprocess(blank, z.enum(["auto", "alpaca", "finnhub"]).default("auto")),
  CRYPTO_PROVIDER: z.preprocess(blank, z.enum(["binance", "coingecko"]).default("binance")),
  BINANCE_WS_URL: z.preprocess(blank, z.string().default("wss://stream.binance.com:9443")),
  COINGECKO_API_URL: z.preprocess(blank, z.string().default("https://api.coingecko.com/api/v3")),
  COINGECKO_API_KEY: optStr,
  /** Extra "SYM:coingecko-id" pairs, comma separated. */
  COINGECKO_IDS: optStr,
  COINGECKO_POLL_MS: num(300_000, 5_000),
  UNIVERSE_REFRESH_MS: num(60_000, 5_000),
  WRITE_INTERVAL_MS: num(2_000, 250),
  WRITE_BATCH_SIZE: num(200, 1),
  OVERFLOW_POLL_MS: num(60_000, 10_000),
  ALERT_COOLDOWN_MS: num(6 * 3_600_000, 0),
  HEARTBEAT_MS: num(20_000, 1_000),
  HEALTH_LOG_MS: num(60_000, 5_000),
  BACKOFF_BASE_MS: num(1_000, 100),
  BACKOFF_MAX_MS: num(60_000, 1_000),
  // ---- Phase 4: news + scoring + alerts
  NEWS_ENABLED: z.preprocess(blank, z.stringbool().default(true)),
  NEWS_CONTACT_EMAIL: optStr,
  NEWS_RSS_INTERVAL_MS: num(300_000, 30_000),
  NEWS_MAX_AGE_HOURS: num(48, 1),
  CRYPTOPANIC_API_KEY: optStr,
  CRYPTOPANIC_API_URL: z.preprocess(blank, z.string().default("https://cryptopanic.com/api/growth/v2/posts/")),
  FINNHUB_MIN_GAP_MS: num(1100, 0),
  ANTHROPIC_API_KEY: optStr,
  NEWS_SCORING_MODEL: z.preprocess(blank, z.string().default("claude-haiku-5-5")),
  NEWS_DAILY_TOKEN_BUDGET: num(500_000, 0),
  NEWS_MAX_BATCH: num(20, 1),
  NEWS_SCORE_INTERVAL_MS: num(120_000, 10_000),
  NEWS_ALERT_THRESHOLD: num(60, 0),
  NEWS_MACRO_ALERT_THRESHOLD: num(80, 0),
  NEWS_MAX_ALERTS_PER_USER_PER_DAY: num(20, 0),
  LOG_LEVEL: z.preprocess(blank, z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid worker configuration: ${issues}`);
  }
  return parsed.data;
}

export function loadDotenv() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: rely on the process environment
  }
}

export type StockProviderChoice = "alpaca" | "finnhub" | "none";
export function pickStockProvider(c: Config): StockProviderChoice {
  const hasAlpaca = Boolean(c.ALPACA_KEY_ID && c.ALPACA_SECRET_KEY);
  const hasFinnhub = Boolean(c.FINNHUB_API_KEY);
  if (c.STOCK_PROVIDER === "alpaca") return hasAlpaca ? "alpaca" : "none";
  if (c.STOCK_PROVIDER === "finnhub") return hasFinnhub ? "finnhub" : "none";
  if (hasAlpaca) return "alpaca";
  if (hasFinnhub) return "finnhub";
  return "none";
}
