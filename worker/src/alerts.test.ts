import { describe, expect, it } from "vitest";
import { AlertEngine, detectCrossings, type AlertRule, type AlertStore } from "./alerts.js";
import { silentLogger } from "./log.js";

describe("detectCrossings", () => {
  const r = { above: 100, below: 50 };
  it("detects upward and downward crossings", () => {
    expect(detectCrossings(99, 100, r)).toEqual(["above"]);
    expect(detectCrossings(99, 101, r)).toEqual(["above"]);
    expect(detectCrossings(51, 50, r)).toEqual(["below"]);
    expect(detectCrossings(51, 10, r)).toEqual(["below"]);
  });
  it("does not fire when staying on one side or without history", () => {
    expect(detectCrossings(101, 105, r)).toEqual([]);
    expect(detectCrossings(100, 105, r)).toEqual([]); // already at threshold
    expect(detectCrossings(70, 80, r)).toEqual([]);
    expect(detectCrossings(undefined, 105, r)).toEqual([]);
    expect(detectCrossings(99, 101, { above: null, below: null })).toEqual([]);
  });
});

class MemStore implements AlertStore {
  calls: Array<{ id: string; dir: string; price: number }> = [];
  accept = true;
  async fire(rule: AlertRule, dir: "above" | "below", price: number) {
    this.calls.push({ id: rule.id, dir, price });
    return this.accept;
  }
}
const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "w1", user_id: "u1", symbol: "AAPL", above: 100, below: null, aboveFiredAt: null, belowFiredAt: null, ...over,
});

describe("AlertEngine", () => {
  it("fires once per crossing and respects cooldown", async () => {
    const store = new MemStore();
    let now = 1_000_000;
    const e = new AlertEngine(store, 3600_000, silentLogger, () => now);
    e.setRules([rule()]);
    await e.onTick("AAPL", 95);
    await e.onTick("AAPL", 101); // cross
    await e.onTick("AAPL", 102); // stays above
    expect(store.calls).toHaveLength(1);
    await e.onTick("AAPL", 99); // back below
    now += 60_000;
    await e.onTick("AAPL", 101); // re-cross within cooldown
    expect(store.calls).toHaveLength(1);
    await e.onTick("AAPL", 99);
    now += 3600_000;
    await e.onTick("AAPL", 101); // after cooldown
    expect(store.calls).toHaveLength(2);
  });

  it("does not fire on first observation but can after seeding", async () => {
    const store = new MemStore();
    const e = new AlertEngine(store, 0, silentLogger);
    e.setRules([rule()]);
    await e.onTick("AAPL", 120);
    expect(store.calls).toHaveLength(0);
    const e2 = new AlertEngine(store, 0, silentLogger);
    e2.setRules([rule()]);
    e2.seed(new Map([["AAPL", 90]]));
    await e2.onTick("AAPL", 120);
    expect(store.calls).toHaveLength(1);
  });

  it("honors persisted fired_at from the database and handles concurrent ticks once", async () => {
    const store = new MemStore();
    const now = 10_000_000;
    const e = new AlertEngine(store, 3600_000, silentLogger, () => now);
    e.setRules([rule({ aboveFiredAt: now - 1000 })]);
    e.seed(new Map([["AAPL", 90]]));
    await e.onTick("AAPL", 101);
    expect(store.calls).toHaveLength(0);
    const e2 = new AlertEngine(store, 0, silentLogger, () => now);
    e2.setRules([rule()]);
    e2.seed(new Map([["AAPL", 90]]));
    await Promise.all([e2.onTick("AAPL", 101), e2.onTick("AAPL", 102)]);
    expect(store.calls).toHaveLength(1);
  });

  it("fires below alerts and ignores other symbols", async () => {
    const store = new MemStore();
    const e = new AlertEngine(store, 0, silentLogger);
    e.setRules([rule({ above: null, below: 50 })]);
    await e.onTick("MSFT", 10);
    await e.onTick("AAPL", 60);
    await e.onTick("AAPL", 49);
    expect(store.calls).toEqual([{ id: "w1", dir: "below", price: 49 }]);
  });
});
