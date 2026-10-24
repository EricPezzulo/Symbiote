import { describe, expect, it } from "vitest";
import { cursorFilter, decodeCursor, encodeCursor, filtersToQuery, PAGE_SIZE, paginate, parseFilters, relativeTime, relevanceLevel, safeHttpUrl } from "./filters";

const id = "123e4567-e89b-12d3-a456-426614174000";
const ts = "2026-10-24T12:00:00.123456+00:00";

describe("parseFilters", () => {
  it("defaults and whitelists", () => {
    expect(parseFilters({})).toEqual({ scope: "all", sentiment: "all", catalyst: false, symbol: null, cursor: null });
    expect(parseFilters({ scope: "evil", sentiment: "bullish", catalyst: "yes", symbol: "drop table" })).toEqual({ scope: "all", sentiment: "all", catalyst: false, symbol: null, cursor: null });
  });
  it("accepts valid values, uppercases symbol, takes first array value", () => {
    const f = parseFilters({ scope: ["holding", "market"], sentiment: "negative", catalyst: "1", symbol: " btc " });
    expect(f).toMatchObject({ scope: "holding", sentiment: "negative", catalyst: true, symbol: "BTC" });
  });
  it("rejects symbols that could inject filter syntax", () => {
    for (const s of ["A,B", "A)or(x", "A B", "", "A".repeat(20), "$AAPL"]) expect(parseFilters({ symbol: s }).symbol).toBeNull();
    expect(parseFilters({ symbol: "BRK.B" }).symbol).toBe("BRK.B");
  });
});

describe("cursor", () => {
  it("round-trips", () => {
    expect(decodeCursor(encodeCursor({ createdAt: ts, id }))).toEqual({ createdAt: ts, id });
  });
  it("rejects tampered / injected cursors", () => {
    const enc = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of [undefined, "", "!!!", enc("x|y"), enc(`${ts}|not-a-uuid`), enc(`${ts},id.gt.0|${id}`), enc(`2026-10-24|${id}`), enc(`${ts}|${id}|extra`), "a".repeat(500)]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
  it("builds a keyset predicate", () => {
    expect(cursorFilter({ createdAt: ts, id })).toBe(`created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${id})`);
  });
});

describe("paginate", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, created_at: `t${i}` }));
  it("returns no cursor when the fetch fits in one page", () => {
    expect(paginate(rows(PAGE_SIZE)).next).toBeNull();
    expect(paginate(rows(3)).page).toHaveLength(3);
  });
  it("trims the lookahead row and points the cursor at the last visible row", () => {
    const { page, next } = paginate(rows(PAGE_SIZE + 1));
    expect(page).toHaveLength(PAGE_SIZE);
    expect(next).toEqual({ createdAt: `t${PAGE_SIZE - 1}`, id: `${PAGE_SIZE - 1}` });
  });
});

describe("filtersToQuery", () => {
  it("omits defaults and encodes state", () => {
    expect(filtersToQuery({ scope: "all", sentiment: "all", catalyst: false, symbol: null })).toBe("");
    expect(filtersToQuery({ scope: "holding", sentiment: "positive", catalyst: true, symbol: "AAPL" })).toBe("?scope=holding&sentiment=positive&catalyst=1&symbol=AAPL");
    expect(filtersToQuery({ scope: "all", sentiment: "all", catalyst: false, symbol: null }, { createdAt: ts, id })).toMatch(/^\?cursor=/);
  });
});

describe("safeHttpUrl", () => {
  it("allows only http(s)", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    for (const u of ["javascript:alert(1)", "data:text/html,x", "//evil.com", "/relative", "ftp://x.com", "", null, undefined, 5, "https://x.com/" + "a".repeat(3000)]) expect(safeHttpUrl(u)).toBeNull();
  });
});

describe("relativeTime / relevance", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  it("formats", () => {
    expect(relativeTime("2026-10-24T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-24T11:15:00Z", now)).toBe("45m ago");
    expect(relativeTime("2026-10-24T07:00:00Z", now)).toBe("5h ago");
    expect(relativeTime("2026-10-21T12:00:00Z", now)).toBe("3d ago");
    expect(relativeTime("garbage", now)).toBe("");
    expect(relativeTime("2026-10-24T13:00:00Z", now)).toBe("just now");
  });
  it("levels", () => {
    expect(relevanceLevel(0.9).bars).toBe(4);
    expect(relevanceLevel(0.7).bars).toBe(3);
    expect(relevanceLevel(0.6).bars).toBe(2);
    expect(relevanceLevel(null).bars).toBe(1);
  });
});
