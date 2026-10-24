import { describe, expect, it } from "vitest";
import { binanceReverseMap, buildUniverse, classOf, cryptoBase, diffSets, normalizeSymbol, parseIdOverrides, toBinancePair, toBinanceStream } from "./symbols.js";

describe("symbol mapping", () => {
  it("normalizes", () => expect(normalizeSymbol(" aapl ")).toBe("AAPL"));
  it("maps crypto to Binance pairs", () => {
    expect(toBinancePair("btc")).toBe("BTCUSDT");
    expect(toBinancePair("ETH-USD")).toBe("ETHUSDT");
    expect(toBinancePair("SOL/USDT")).toBe("SOLUSDT");
    expect(toBinancePair("BTCUSDT")).toBe("BTCUSDT");
    expect(toBinanceStream("BTC")).toBe("btcusdt@miniTicker");
  });
  it("reverse-maps pairs to app symbols", () => {
    const m = binanceReverseMap(["BTC", "eth"]);
    expect(m.get("BTCUSDT")).toBe("BTC");
    expect(m.get("ETHUSDT")).toBe("ETH");
  });
  it("strips quote suffixes", () => expect(cryptoBase("btc-usd")).toBe("BTC"));
  it("classifies asset types", () => {
    expect(classOf("etf")).toBe("stock");
    expect(classOf("stock")).toBe("stock");
    expect(classOf("crypto")).toBe("crypto");
    expect(classOf("cash")).toBeNull();
    expect(classOf("other")).toBeNull();
  });
  it("parses CoinGecko id overrides", () => {
    expect(parseIdOverrides("pepe:pepe, ABC : abc-coin ,bad")).toEqual({ PEPE: "pepe", ABC: "abc-coin" });
  });
});

describe("universe building and diffing", () => {
  it("unions and splits by class, dedupes, ignores cash/other and junk", () => {
    const u = buildUniverse([
      { symbol: "aapl", asset_type: "stock" },
      { symbol: "AAPL", asset_type: "etf" },
      { symbol: "BRK.B", asset_type: "stock" },
      { symbol: "btc", asset_type: "crypto" },
      { symbol: "BTC-USD", asset_type: "crypto" },
      { symbol: "USD", asset_type: "cash" },
      { symbol: "weird sym!", asset_type: "stock" },
      { symbol: "", asset_type: "stock" },
    ]);
    expect([...u.stocks].sort()).toEqual(["AAPL", "BRK.B"]);
    expect([...u.crypto]).toEqual(["BTC"]);
  });
  it("diffs sets", () => {
    expect(diffSets(new Set(["A", "B"]), new Set(["B", "C", "D"]))).toEqual({ added: ["C", "D"], removed: ["A"] });
    expect(diffSets(new Set(), new Set())).toEqual({ added: [], removed: [] });
  });
});
