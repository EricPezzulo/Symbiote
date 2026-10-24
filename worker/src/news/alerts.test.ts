import { describe, expect, it } from "vitest";
import { planNewsAlerts, severityFor, type ScoredItem, type UserSymbols } from "./alerts.js";
import { generateAlerts, type AlertDataStore } from "./pipeline.js";

const policy = { threshold: 60, macroThreshold: 80, maxPerUserPerDay: 3 };
const sc = (id: string, o: Partial<ScoredItem> = {}): ScoredItem => ({ news_item_id: id, title: `t-${id}`, category: "company", item_symbols: ["AAPL"], relevance: 75, sentiment: "positive", is_catalyst: false, affected_symbols: ["AAPL"], why_it_matters: "why", ...o });
const sets = (h: string[], w: string[] = []): UserSymbols => ({ holdings: new Set(h), watchlist: new Set(w) });
const plan = (items: ScoredItem[], users: Map<string, UserSymbols>, existing = new Set<string>(), counts = new Map<string, number>(), p = policy) => planNewsAlerts({ items, users, policy: p, existing, countsToday: counts });

describe("planNewsAlerts", () => {
  const users = new Map([["u1", sets(["AAPL"])], ["u2", sets([], ["AAPL"])], ["u3", sets(["MSFT"])]]);
  it("alerts holders (scope holding) and watchers (scope watchlist) but not unrelated users", () => {
    const rows = plan([sc("n1")], users);
    expect(rows.map((r) => [r.user_id, r.scope])).toEqual([["u1", "holding"], ["u2", "watchlist"]]);
    expect(rows[0]).toMatchObject({ kind: "news", symbol: "AAPL", symbols: ["AAPL"], relevance_score: 0.75, sentiment: "positive", body: "why", news_item_id: "n1" });
  });
  it("respects the relevance threshold", () => {
    expect(plan([sc("n1", { relevance: 59 })], users)).toHaveLength(0);
    expect(plan([sc("n1", { relevance: 60 })], users)).toHaveLength(2);
  });
  it("falls back to item symbols when the model listed none", () => {
    expect(plan([sc("n1", { affected_symbols: [] })], users)).toHaveLength(2);
  });
  it("macro catalysts alert everyone at the macro threshold, with scope market", () => {
    const m = sc("m1", { category: "macro", item_symbols: [], affected_symbols: [], is_catalyst: true, relevance: 85 });
    const rows = plan([m], users);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.scope === "market" && r.symbol === null && r.is_catalyst)).toBe(true);
    expect(plan([{ ...m, relevance: 79 }], users)).toHaveLength(0);
    expect(plan([{ ...m, is_catalyst: false }], users)).toHaveLength(0);
    expect(plan([{ ...m, category: "company" }], users)).toHaveLength(0);
  });
  it("is idempotent against existing (user,item) pairs", () => {
    const rows = plan([sc("n1")], users, new Set(["u1|n1"]));
    expect(rows.map((r) => r.user_id)).toEqual(["u2"]);
  });
  it("caps per user per day, keeping the highest relevance, counting alerts already sent today", () => {
    const items = ["a", "b", "c", "d", "e"].map((id, i) => sc(id, { relevance: 60 + i * 5 }));
    const rows = plan(items, new Map([["u1", sets(["AAPL"])]]));
    expect(rows.map((r) => r.news_item_id)).toEqual(["e", "d", "c"]);
    const rows2 = plan(items, new Map([["u1", sets(["AAPL"])]]), new Set(), new Map([["u1", 2]]));
    expect(rows2.map((r) => r.news_item_id)).toEqual(["e"]);
  });
  it("severity mapping", () => {
    expect(severityFor(95, false)).toBe(5);
    expect(severityFor(65, true)).toBe(3);
    expect(severityFor(30, true)).toBe(1);
  });
});

describe("generateAlerts (idempotency end to end with an in-memory store)", () => {
  function mem(items: ScoredItem[]) {
    const alerts = new Map<string, unknown>();
    const store: AlertDataStore = {
      scoredSince: async () => items,
      existingAlertPairs: async () => new Set(alerts.keys()),
      newsAlertCountsToday: async () => { const m = new Map<string, number>(); for (const k of alerts.keys()) m.set(k.split("|")[0], (m.get(k.split("|")[0]) ?? 0) + 1); return m; },
      insertAlerts: async (rows) => { let n = 0; for (const r of rows) { const k = `${r.user_id}|${r.news_item_id}`; if (!alerts.has(k)) { alerts.set(k, r); n++; } } return n; },
    };
    return { store, alerts };
  }
  it("running twice creates each alert once", async () => {
    const { store, alerts } = mem([sc("n1"), sc("n2", { relevance: 90 })]);
    const users = new Map([["u1", sets(["AAPL"])]]);
    expect(await generateAlerts(store, users, policy, "x", 0)).toBe(2);
    expect(await generateAlerts(store, users, policy, "x", 0)).toBe(0);
    expect(alerts.size).toBe(2);
  });
  it("no users, no work", async () => {
    const { store } = mem([sc("n1")]);
    expect(await generateAlerts(store, new Map(), policy, "x", 0)).toBe(0);
  });
});
