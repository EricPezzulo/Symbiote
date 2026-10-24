import { describe, expect, it } from "vitest";
import { loadConfig, pickStockProvider } from "./config.js";
import { createLogger } from "./log.js";

const base = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };

describe("config", () => {
  it("applies defaults and treats blank optionals as unset", () => {
    const c = loadConfig({ ...base, ALPACA_KEY_ID: "", FINNHUB_API_KEY: " " });
    expect(c.ALPACA_KEY_ID).toBeUndefined();
    expect(c.BINANCE_WS_URL).toBe("wss://stream.binance.com:9443");
    expect(c.ALPACA_MAX_SYMBOLS).toBe(30);
    expect(c.WRITE_INTERVAL_MS).toBe(2000);
    expect(pickStockProvider(c)).toBe("none");
  });
  it("fails clearly on missing required values", () => {
    expect(() => loadConfig({})).toThrow(/SUPABASE_URL/);
  });
  it("picks providers: alpaca > finnhub in auto, explicit wins", () => {
    expect(pickStockProvider(loadConfig({ ...base, ALPACA_KEY_ID: "a", ALPACA_SECRET_KEY: "b", FINNHUB_API_KEY: "f" }))).toBe("alpaca");
    expect(pickStockProvider(loadConfig({ ...base, FINNHUB_API_KEY: "f" }))).toBe("finnhub");
    expect(pickStockProvider(loadConfig({ ...base, STOCK_PROVIDER: "finnhub", ALPACA_KEY_ID: "a", ALPACA_SECRET_KEY: "b" }))).toBe("none");
  });
});

describe("logger", () => {
  it("never emits secrets", () => {
    const lines: string[] = [];
    const log = createLogger("info", "t", (l) => lines.push(l));
    log.info("connect wss://ws.finnhub.io?token=SUPERSECRET", { apiKey: "SUPERSECRET", url: "https://x?apikey=SUPERSECRET&a=1", n: 1 });
    expect(lines[0]).not.toContain("SUPERSECRET");
    expect(JSON.parse(lines[0]).n).toBe(1);
  });
});
