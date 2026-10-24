import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../log.js";
import { Http, HttpError } from "./http.js";
import { RateLimiter } from "./sources/ratelimit.js";
import { mapFinnhubNews, mapEarnings } from "./sources/finnhub.js";
import { mapCryptoPanic } from "./sources/cryptopanic.js";

const res = (status: number, body = "", headers: Record<string, string> = {}) => new Response(status === 304 ? null : body, { status, headers });
const mk = (fetchImpl: typeof fetch) => new Http({ fetch: fetchImpl, sleep: async () => {}, userAgent: "ua", log: silentLogger });

describe("Http", () => {
  it("retries 5xx/429 with backoff and then succeeds; sends user-agent", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(429, "", { "retry-after": "1" })).mockResolvedValueOnce(res(200, "ok"));
    const sleeps: number[] = [];
    const h = new Http({ fetch: f, sleep: async (ms) => void sleeps.push(ms), userAgent: "ua", log: silentLogger });
    const r = await h.get("https://a.test/x", { retries: 2 });
    expect(r).toMatchObject({ notModified: false, body: "ok" });
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect((f.mock.calls[0][1]!.headers as Record<string, string>)["user-agent"]).toBe("ua");
  });
  it("does not retry 4xx and gives up after retries", async () => {
    const f404 = vi.fn<typeof fetch>().mockResolvedValue(res(404));
    await expect(mk(f404).get("https://a.test/x")).rejects.toBeInstanceOf(HttpError);
    expect(f404).toHaveBeenCalledTimes(1);
    const f500 = vi.fn<typeof fetch>().mockImplementation(async () => res(500));
    await expect(mk(f500).get("https://a.test/x", { retries: 1 })).rejects.toThrow(/500/);
    expect(f500).toHaveBeenCalledTimes(2);
  });
  it("retries network errors without leaking the url query into the message", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(mk(f).get("https://a.test/x?auth_token=SECRET", { retries: 1 })).rejects.toThrow(/a\.test/);
    await expect(mk(f).get("https://a.test/x?auth_token=SECRET", { retries: 0 })).rejects.not.toThrow(/SECRET/);
  });
  it("uses ETag / Last-Modified and returns notModified on 304", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(res(200, "body", { etag: '"v1"', "last-modified": "Sat, 24 Oct 2026 00:00:00 GMT" })).mockResolvedValueOnce(res(304));
    const h = mk(f);
    await h.get("https://a.test/feed", { conditional: true });
    const r = await h.get("https://a.test/feed", { conditional: true });
    expect(r).toEqual({ notModified: true });
    const hdr = f.mock.calls[1][1]!.headers as Record<string, string>;
    expect(hdr["if-none-match"]).toBe('"v1"');
    expect(hdr["if-modified-since"]).toBe("Sat, 24 Oct 2026 00:00:00 GMT");
  });
  it("enforces maxBytes", async () => {
    await expect(mk(async () => res(200, "x".repeat(100))).get("https://a.test/x", { maxBytes: 10 })).rejects.toThrow(/too large/);
  });
});

describe("RateLimiter", () => {
  it("spaces calls by the minimum gap", async () => {
    let t = 0;
    const waits: number[] = [];
    const rl = new RateLimiter(1000, () => t, async (ms) => { waits.push(ms); t += ms; });
    await rl.wait(); await rl.wait(); await rl.wait();
    expect(waits).toEqual([1000, 1000]);
  });
});

describe("source mappers", () => {
  it("maps Finnhub news incl. related tickers, publisher, unix seconds", () => {
    const out = mapFinnhubNews([{ headline: "H", url: "https://x.com/1", datetime: 1_792_800_000, related: "AAPL, msft", source: "Reuters", summary: "S", id: 5 }, { nope: 1 }], "company", ["AAPL"], 0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "finnhub:Reuters", symbols: ["AAPL", "AAPL", "MSFT"], publishedAt: 1_792_800_000_000, externalId: "finnhub:5" });
    expect(mapFinnhubNews({ error: "x" }, "market", [], 0)).toEqual([]);
  });
  it("maps earnings calendar for universe symbols only", () => {
    const rows = mapEarnings({ earningsCalendar: [{ symbol: "AAPL", date: "2026-10-29", hour: "amc", epsEstimate: 1.2 }, { symbol: "ZZZ", date: "2026-10-29" }, { symbol: "AAPL", date: "bad" }] }, new Map([["AAPL", 1]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unique_key: "earnings:AAPL:2026-10-29", kind: "earnings", symbol: "AAPL" });
  });
  it("maps CryptoPanic defensively", () => {
    const out = mapCryptoPanic({ results: [{ title: "T", original_url: "https://x.com/a", published_at: "2026-10-24T00:00:00Z", instruments: [{ code: "btc" }] }, { title: "no url" }] });
    expect(out).toHaveLength(1);
    expect(out[0].symbols).toEqual(["BTC"]);
    expect(mapCryptoPanic(null)).toEqual([]);
  });
});
