import { describe, expect, it } from "vitest";
import { canonicalizeUrl, normalizeTitle, titleHash, urlHash } from "./canonical.js";
import { prepareItems } from "./prepare.js";
import { buildMatcher } from "./entities.js";
import type { NewsUniverse, RawNewsItem } from "./types.js";

describe("canonicalizeUrl", () => {
  it("strips tracking params, fragments, default ports, trailing slash, and forces https", () => {
    expect(canonicalizeUrl("http://WWW.Example.com:80/a/b/?utm_source=x&b=2&a=1&fbclid=z#frag")).toBe("https://www.example.com/a/b?a=1&b=2");
  });
  it("rejects non-http(s), credentials and garbage", () => {
    for (const u of ["javascript:alert(1)", "ftp://x.com/a", "data:text/html,hi", "not a url", "https://user:pw@x.com/"]) expect(canonicalizeUrl(u)).toBeNull();
  });
  it("hash ignores www and tracking params", () => {
    const a = urlHash(canonicalizeUrl("https://www.x.com/a?utm_medium=1")!);
    const b = urlHash(canonicalizeUrl("http://x.com/a/")!);
    expect(a).toBe(b);
    expect(urlHash(canonicalizeUrl("https://x.com/b")!)).not.toBe(a);
  });
});

describe("title hashing", () => {
  it("normalizes case, punctuation, accents and whitespace", () => {
    expect(normalizeTitle("  Fed HOLDS rates — Steady!  ")).toBe("fed holds rates steady");
    expect(titleHash("Café  opens, Stocks Rise")).toBe(titleHash("cafe opens stocks rise"));
    expect(titleHash("a headline here")).not.toBe(titleHash("another headline"));
  });
});

describe("prepareItems", () => {
  const universe: NewsUniverse = { symbols: new Map([["AAPL", "stock"], ["BTC", "crypto"]]), users: new Map() };
  const matcher = buildMatcher(universe.symbols);
  const base = (o: Partial<RawNewsItem>): RawNewsItem => ({ source: "t", url: "https://x.com/1", title: "Apple announces big new thing", publishedAt: "2026-10-23T00:00:00Z", category: "company", ...o });
  const now = Date.parse("2026-10-24T00:00:00Z");

  it("dedupes by canonical url and by normalized title within a batch", () => {
    const out = prepareItems([base({}), base({ url: "http://www.x.com/1/?utm_source=a" }), base({ url: "https://y.com/2", title: "APPLE announces big new thing!" }), base({ url: "https://z.com/3", title: "Different story entirely" })], universe, matcher, now);
    expect(out.map((o) => o.url)).toEqual(["https://x.com/1", "https://z.com/3"]);
  });
  it("maps symbols from trusted source tickers (filtered to universe) and text", () => {
    const [o] = prepareItems([base({ symbols: ["aapl", "ZZZZ"], title: "Bitcoin surges past record", summary: "x" })], universe, matcher, now);
    expect(o.symbols).toEqual(["AAPL", "BTC"]);
  });
  it("drops bad urls and tiny titles, clamps future dates, strips html", () => {
    const out = prepareItems([base({ url: "javascript:x" }), base({ title: "hi", url: "https://q.com/q" }), base({ url: "https://f.com/f", title: "<b>Future dated story</b> here", publishedAt: "2030-01-01T00:00:00Z" })], universe, matcher, now);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Future dated story here");
    expect(out[0].published_at).toBe(new Date(now).toISOString());
  });
  it("accepts unix seconds", () => {
    const [o] = prepareItems([base({ publishedAt: 1_792_800_000 })], universe, matcher, now);
    expect(o.published_at).toBe(new Date(1_792_800_000_000).toISOString());
  });
});
