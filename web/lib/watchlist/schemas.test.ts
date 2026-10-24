import { describe, expect, it } from "vitest";
import { watchAddSchema, watchUpdateSchema } from "./schemas";

describe("watchAddSchema", () => {
  it("accepts a stock and uppercases", () => {
    const r = watchAddSchema.safeParse({ symbol: " aapl ", asset_type: "stock", notes: "", alert_above: "250", alert_below: "" });
    expect(r.success && r.data).toMatchObject({ symbol: "AAPL", notes: null, alert_above: 250, alert_below: null });
  });
  it("normalizes crypto pairs", () => {
    const r = watchAddSchema.safeParse({ symbol: "btc-usd", asset_type: "crypto", notes: "x", alert_above: "", alert_below: "$40,000" });
    expect(r.success && r.data).toMatchObject({ symbol: "BTC", alert_below: 40000 });
  });
  it("rejects bad symbols, bad asset types and crossed targets", () => {
    expect(watchAddSchema.safeParse({ symbol: "A B", asset_type: "stock", notes: "", alert_above: "", alert_below: "" }).success).toBe(false);
    expect(watchAddSchema.safeParse({ symbol: "BRK.B", asset_type: "crypto", notes: "", alert_above: "", alert_below: "" }).success).toBe(false);
    expect(watchAddSchema.safeParse({ symbol: "AAPL", asset_type: "forex", notes: "", alert_above: "", alert_below: "" }).success).toBe(false);
    expect(watchAddSchema.safeParse({ symbol: "AAPL", asset_type: "stock", notes: "", alert_above: "100", alert_below: "100" }).success).toBe(false);
    expect(watchAddSchema.safeParse({ symbol: "AAPL", asset_type: "stock", notes: "", alert_above: "-5", alert_below: "" }).success).toBe(false);
    expect(watchAddSchema.safeParse({ symbol: "AAPL", asset_type: "stock", notes: "x".repeat(281), alert_above: "", alert_below: "" }).success).toBe(false);
  });
  it("validates updates", () => {
    expect(watchUpdateSchema.safeParse({ id: crypto.randomUUID(), notes: "n", alert_above: "10", alert_below: "5" }).success).toBe(true);
    expect(watchUpdateSchema.safeParse({ id: "nope", notes: "", alert_above: "", alert_below: "" }).success).toBe(false);
  });
});
