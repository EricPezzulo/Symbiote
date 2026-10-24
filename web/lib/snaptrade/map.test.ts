import { describe, expect, it } from "vitest";
import { mapSnaptradePositions, slotsMessage } from "./map";

const pos = (symbol: string, units: number | null, price: number | null, code = "cs", cash = false) => ({
  symbol: { symbol: { symbol, type: { code } } },
  units,
  average_purchase_price: price,
  cash_equivalent: cash,
});

describe("mapSnaptradePositions", () => {
  it("maps types, cost basis = avg price * units, skips empty rows", () => {
    const r = mapSnaptradePositions([
      pos("aapl", 10, 150),
      pos("VTI", 2.5, 200, "et"),
      pos("BTC", 0.5, 20000, "crypto"),
      pos("SPAXX", 100, 1, "oth", true),
      pos("ZERO", 0, 1),
      pos("NOUNITS", null, 1),
      { symbol: null, units: 3 },
    ]);
    expect(r).toEqual([
      { symbol: "AAPL", asset_type: "stock", quantity: 10, cost_basis: 1500 },
      { symbol: "VTI", asset_type: "etf", quantity: 2.5, cost_basis: 500 },
      { symbol: "BTC", asset_type: "crypto", quantity: 0.5, cost_basis: 10000 },
      { symbol: "SPAXX", asset_type: "cash", quantity: 100, cost_basis: 100 },
    ]);
  });
  it("null cost basis when no average price; merges duplicates", () => {
    const r = mapSnaptradePositions([pos("X", 1, null), pos("X", 2, null)]);
    expect(r).toEqual([{ symbol: "X", asset_type: "stock", quantity: 3, cost_basis: null }]);
  });
});

describe("slotsMessage", () => {
  it("blocks at 5 and points to CSV", () => {
    expect(slotsMessage(4)).toBeNull();
    expect(slotsMessage(5)).toMatch(/CSV/);
    expect(slotsMessage(9)).toMatch(/CSV/);
  });
});
