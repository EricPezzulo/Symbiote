import { describe, expect, it } from "vitest";
import { silentLogger } from "../log.js";
import { NewsPipeline } from "./pipeline.js";
import type { NewsSource, NewsUniverse, PreparedNewsItem } from "./types.js";

const universe: NewsUniverse = { symbols: new Map([["AAPL", "stock"]]), users: new Map([["u1", { holdings: new Set(["AAPL"]), watchlist: new Set<string>() }]]) };
const now = Date.parse("2026-10-24T00:00:00Z");

describe("NewsPipeline.pollSource", () => {
  it("normalizes, drops stale items and inserts new ones with mapped symbols", async () => {
    const inserted: PreparedNewsItem[] = [];
    const p = new NewsPipeline({
      sources: [], calendars: [], scorer: null, log: silentLogger, scoreIntervalMs: 1000, now: () => now,
      policy: { threshold: 60, macroThreshold: 80, maxPerUserPerDay: 5 },
      sink: { insertNew: async (i) => { inserted.push(...i); return i.length; }, upsertCalendar: async () => {} },
      alertStore: { scoredSince: async () => [], existingAlertPairs: async () => new Set(), newsAlertCountsToday: async () => new Map(), insertAlerts: async () => 0 },
      loadUniverse: async () => universe,
    });
    await p.refreshUniverse();
    const src: NewsSource = {
      name: "t", category: "market", intervalMs: 1, timeoutMs: 1, enabled: () => true,
      poll: async () => [
        { source: "t", url: "https://x.com/a", title: "Apple shares rise on iPhone demand", publishedAt: "2026-10-23T00:00:00Z", category: "market" },
        { source: "t", url: "https://x.com/old", title: "Ancient story from long ago", publishedAt: "2026-01-01T00:00:00Z", category: "market" },
      ],
    };
    expect(await p.pollSource(src)).toBe(1);
    expect(inserted[0].symbols).toEqual(["AAPL"]);
  });
});
