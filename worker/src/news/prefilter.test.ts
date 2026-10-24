import { describe, expect, it } from "vitest";
import { hasMacroKeyword, prefilter } from "./prefilter.js";

const item = (o: object = {}) => ({ title: "Local bakery opens", summary: null, source: "cnbc", category: "market" as const, symbols: [] as string[], ...o });

describe("prefilter", () => {
  it("rejects unrelated items", () => {
    expect(prefilter(item()).candidate).toBe(false);
  });
  it("accepts symbol matches", () => {
    const r = prefilter(item({ symbols: ["AAPL"] }));
    expect(r.candidate).toBe(true);
    expect(r.reason).toBe("symbol");
  });
  it("accepts macro keyword items in macro/market/crypto categories but not company", () => {
    expect(prefilter(item({ title: "Fed signals rate cut in December" })).candidate).toBe(true);
    expect(prefilter(item({ title: "Exchange hacked for $100M", category: "crypto" })).candidate).toBe(true);
    expect(prefilter(item({ title: "Fed signals rate cut", category: "company" })).candidate).toBe(false);
  });
  it("accepts high-priority sources unconditionally and ranks them above plain symbol hits", () => {
    const fed = prefilter(item({ source: "federalreserve", category: "macro" }));
    expect(fed.candidate).toBe(true);
    expect(fed.priority).toBeGreaterThan(prefilter(item({ symbols: ["AAPL"] })).priority - 1);
    expect(prefilter(item({ source: "sec-edgar", symbols: ["AAPL"], category: "company" })).priority).toBeGreaterThan(prefilter(item({ symbols: ["AAPL"] })).priority);
  });
  it("keyword matching is word-bounded", () => {
    expect(hasMacroKeyword("Confederate monuments")).toBe(false);
    expect(hasMacroKeyword("Feds weigh options")).toBe(false);
    expect(hasMacroKeyword("CPI came in hot")).toBe(true);
  });
});
