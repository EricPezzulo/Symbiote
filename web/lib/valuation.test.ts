import { describe, expect, it } from "vitest";
import { dayChange, summarise, valueHolding, type QuoteMap, type ValuableHolding } from "./valuation";

const h = (o: Partial<ValuableHolding>): ValuableHolding => ({
  id: "1", account_id: "a1", symbol: "AAPL", asset_type: "stock", quantity: 10, cost_basis: 1500, source: "manual", ...o,
});

describe("valuation", () => {
  it("uses price when available, with gain/loss", () => {
    const v = valueHolding(h({}), new Map([["AAPL", 200]]));
    expect(v).toMatchObject({ value: 2000, basis: "price", gainLoss: 500 });
    expect(v.gainLossPct).toBeCloseTo(33.33, 1);
  });
  it("falls back to cost basis (price pending)", () => {
    expect(valueHolding(h({}), new Map())).toMatchObject({ value: 1500, basis: "cost", gainLoss: null });
  });
  it("unknown when no price or cost", () => {
    expect(valueHolding(h({ cost_basis: null }), new Map())).toMatchObject({ value: 0, basis: "none" });
  });
  it("cash is valued at quantity", () => {
    expect(valueHolding(h({ asset_type: "cash", symbol: "SPAXX", quantity: 12.5, cost_basis: null }), new Map()).value).toBe(12.5);
  });
  it("summarises by account and source and counts pending", () => {
    const s = summarise(
      [h({ id: "1" }), h({ id: "2", account_id: "a2", symbol: "BTC", asset_type: "crypto", quantity: 1, cost_basis: 100, source: "wallet" })],
      new Map([["AAPL", 200]]),
    );
    expect(s.total).toBe(2100);
    expect(s.pendingCount).toBe(1);
    expect(s.byAccount.get("a2")).toMatchObject({ value: 100, pending: 1 });
    expect(s.bySource.get("manual")).toMatchObject({ value: 2000, pending: 0 });
  });
});

describe("dayChange", () => {
  const quotes: QuoteMap = new Map([
    ["AAPL", { price: 110, prevClose: 100, updatedAt: null }],
    ["BTC", { price: 50, prevClose: null, updatedAt: null }],
  ]);
  it("sums qty * (price - prevClose) for holdings with a baseline", () => {
    const d = dayChange([h({}), h({ id: "2", symbol: "BTC", asset_type: "crypto" }), h({ id: "3", symbol: "X", asset_type: "cash" })], quotes);
    expect(d.amount).toBe(100);
    expect(d.pct).toBeCloseTo(10);
    expect(d.covered).toBe(1);
  });
  it("is empty without quotes", () => {
    expect(dayChange([h({})], new Map())).toEqual({ amount: 0, pct: null, covered: 0 });
  });
  it("handles losses", () => {
    const d = dayChange([h({ quantity: 2 })], new Map([["AAPL", { price: 90, prevClose: 100, updatedAt: null }]]));
    expect(d.amount).toBe(-20);
    expect(d.pct).toBeCloseTo(-10);
  });
});
