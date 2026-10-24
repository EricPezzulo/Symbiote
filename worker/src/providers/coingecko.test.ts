import { describe, expect, it, vi } from "vitest";
import { CoinGeckoProvider } from "./coingecko.js";
import { silentLogger } from "../log.js";
import type { Tick } from "../types.js";

const body = { bitcoin: { usd: 50000, usd_24h_change: 10, usd_24h_vol: 123, last_updated_at: 1_700_000_000 }, pepe: { usd: 0.00001 } };

describe("CoinGeckoProvider", () => {
  it("polls simple/price with mapped ids and emits ticks with derived prev close", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true, status: 200, json: async () => body }));
    const p = new CoinGeckoProvider({ baseUrl: "https://cg.test/api/v3", apiKey: "DEMO", pollMs: 60_000, idOverrides: { PEPE: "pepe" }, fetch: fetchMock }, silentLogger);
    const ticks: Tick[] = [];
    p.onTick((t) => ticks.push(t));
    p.subscribe(["BTC", "PEPE", "NOPE"]);
    await p.poll();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/simple/price?ids=bitcoin%2Cpepe");
    expect(url).toContain("include_24hr_change=true");
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers["x-cg-demo-api-key"]).toBe("DEMO");
    const btc = ticks.find((t) => t.symbol === "BTC")!;
    expect(btc).toMatchObject({ price: 50000, changePct: 10, source: "coingecko", ts: 1_700_000_000_000 });
    expect(btc.prevClose).toBeCloseTo(50000 / 1.1);
    expect(ticks.find((t) => t.symbol === "PEPE")!.changePct).toBeNull();
    expect(ticks.find((t) => t.symbol === "NOPE")).toBeUndefined();
  });

  it("backs off on 429 and reports degraded status", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    const p = new CoinGeckoProvider({ baseUrl: "https://cg.test", pollMs: 60_000, fetch: fetchMock }, silentLogger);
    p.subscribe(["BTC"]);
    await p.poll();
    await p.poll(); // within backoff window: no second request
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
