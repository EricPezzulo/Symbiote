import { describe, expect, it } from "vitest";
import { usMarketOpen } from "./market";
import { agoLabel, isStale, newer, toPriceRow } from "./types";

describe("usMarketOpen", () => {
  it("is open during the regular session (EST)", () => expect(usMarketOpen(new Date("2026-03-02T15:00:00Z"))).toBe(true)); // Mon 10:00 EST
  it("handles DST (EDT): 9:00 closed, 9:30 open, 16:00 closed", () => {
    expect(usMarketOpen(new Date("2026-07-01T13:00:00Z"))).toBe(false);
    expect(usMarketOpen(new Date("2026-07-01T13:30:00Z"))).toBe(true);
    expect(usMarketOpen(new Date("2026-07-01T20:00:00Z"))).toBe(false);
  });
  it("is closed on weekends", () => expect(usMarketOpen(new Date("2026-03-07T15:00:00Z"))).toBe(false));
});

describe("price helpers", () => {
  it("coerces numeric strings and rejects junk", () => {
    expect(toPriceRow({ symbol: "A", price: "12.5", change_24h_pct: "1.5", prev_close: null, updated_at: "2026-01-01T00:00:00Z" })).toMatchObject({ price: 12.5, change_24h_pct: 1.5, prev_close: null });
    expect(toPriceRow({ symbol: "A", price: "x" })).toBeNull();
    expect(toPriceRow(null)).toBeNull();
  });
  it("prefers the newer row", () => {
    const a = toPriceRow({ symbol: "A", price: 1, updated_at: "2026-01-01T00:00:01Z" })!;
    const b = toPriceRow({ symbol: "A", price: 2, updated_at: "2026-01-01T00:00:00Z" })!;
    expect(newer(a, b)).toBe(a);
    expect(newer(undefined, b)).toBe(b);
  });
  it("formats ago labels", () => {
    const now = Date.parse("2026-01-01T01:00:00Z");
    expect(agoLabel("2026-01-01T00:59:58Z", now)).toBe("just now");
    expect(agoLabel("2026-01-01T00:59:30Z", now)).toBe("30s ago");
    expect(agoLabel("2026-01-01T00:50:00Z", now)).toBe("10m ago");
    expect(agoLabel(null, now)).toBe("never");
  });
  it("flags staleness by asset class and market state", () => {
    const now = Date.parse("2026-01-01T01:00:00Z");
    const old = "2026-01-01T00:50:00Z";
    expect(isStale({ asset_type: "crypto", updated_at: old }, now, false)).toBe(true);
    expect(isStale({ asset_type: "stock", updated_at: old }, now, false)).toBe(false);
    expect(isStale({ asset_type: "stock", updated_at: old }, now, true)).toBe(true);
  });
});
