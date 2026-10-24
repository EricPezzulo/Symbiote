import { describe, expect, it, vi } from "vitest";
import { UniverseSync } from "./universe.js";
import { silentLogger } from "./log.js";
import type { PriceProvider } from "./types.js";
import { fetchAll, loadUniverse } from "./supabase.js";

function fakeProvider() {
  return { subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as PriceProvider & { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
}
const sets = (stocks: string[], crypto: string[]) => ({ stocks: new Set(stocks), crypto: new Set(crypto) });

describe("UniverseSync", () => {
  it("subscribes the initial set then only diffs", () => {
    const s = fakeProvider();
    const c = fakeProvider();
    const u = new UniverseSync(s, c, silentLogger);
    u.apply(sets(["AAPL", "MSFT"], ["BTC"]));
    expect(s.subscribe).toHaveBeenCalledWith(["AAPL", "MSFT"]);
    expect(c.subscribe).toHaveBeenCalledWith(["BTC"]);
    u.apply(sets(["AAPL", "TSLA"], ["BTC"]));
    expect(s.unsubscribe).toHaveBeenCalledWith(["MSFT"]);
    expect(s.subscribe).toHaveBeenLastCalledWith(["TSLA"]);
    expect(c.subscribe).toHaveBeenCalledTimes(1);
    expect(c.unsubscribe).not.toHaveBeenCalled();
    u.apply(sets(["AAPL", "TSLA"], ["BTC"]));
    expect(s.subscribe).toHaveBeenCalledTimes(2); // no-op
  });
  it("tolerates a missing provider", () => {
    const c = fakeProvider();
    const u = new UniverseSync(null, c, silentLogger);
    expect(() => u.apply(sets(["AAPL"], ["ETH"]))).not.toThrow();
    expect(c.subscribe).toHaveBeenCalledWith(["ETH"]);
  });
});

function fakeClient(tables: Record<string, any[]>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    from(t: string) {
      const rows = tables[t] ?? [];
      const q: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
        select: () => q,
        order: () => q,
        range: (a: number, b: number) => Promise.resolve({ data: rows.slice(a, b + 1), error: null }),
      };
      return q;
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("loadUniverse", () => {
  it("pages beyond 1000 rows and unions holdings + watchlist", async () => {
    const holdings = Array.from({ length: 2300 }, (_, i) => ({ id: String(i), symbol: `S${i % 1500}`, asset_type: "stock" }));
    const watchlist = [
      { id: "w1", user_id: "u1", symbol: "btc", asset_type: "crypto", alert_above: "70000", alert_below: null, alert_above_fired_at: null, alert_below_fired_at: null },
    ];
    const client = fakeClient({ holdings, watchlist });
    expect((await fetchAll(client, "holdings", "id")).length).toBe(2300);
    const { sets: s, rules } = await loadUniverse(client);
    expect(s.stocks.size).toBe(1500);
    expect([...s.crypto]).toEqual(["BTC"]);
    expect(rules).toEqual([{ id: "w1", user_id: "u1", symbol: "BTC", above: 70000, below: null, aboveFiredAt: null, belowFiredAt: null }]);
  });
});
