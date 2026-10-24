import type { Logger } from "./types.js";

export type AlertRule = {
  id: string; // watchlist row id
  user_id: string;
  symbol: string;
  above: number | null;
  below: number | null;
  aboveFiredAt: number | null; // ms
  belowFiredAt: number | null;
};

export type Direction = "above" | "below";

/**
 * A crossing happens only when we observed the previous price on the other side of the
 * threshold. With no previous observation nothing fires (avoids alerting on every restart).
 */
export function detectCrossings(prev: number | undefined, price: number, rule: Pick<AlertRule, "above" | "below">): Direction[] {
  if (prev === undefined || !Number.isFinite(prev)) return [];
  const out: Direction[] = [];
  if (rule.above !== null && prev < rule.above && price >= rule.above) out.push("above");
  if (rule.below !== null && prev > rule.below && price <= rule.below) out.push("below");
  return out;
}

export interface AlertStore {
  /**
   * Atomically claim the right to fire (sets fired_at where it is null or older than cutoff and the
   * threshold is unchanged), then insert the alert. Returns true if an alert was created.
   */
  fire(rule: AlertRule, dir: Direction, price: number, cutoffMs: number, nowMs: number): Promise<boolean>;
}

export function alertText(symbol: string, dir: Direction, threshold: number, price: number) {
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 });
  return {
    title: `${symbol} crossed ${dir} $${fmt(threshold)}`,
    body: `${symbol} traded at $${fmt(price)}, ${dir === "above" ? "above" : "below"} your target of $${fmt(threshold)}.`,
  };
}

export class AlertEngine {
  private rules = new Map<string, AlertRule[]>();
  private last = new Map<string, number>();
  private inFlight = new Set<string>();
  fired = 0;

  constructor(
    private readonly store: AlertStore,
    private readonly cooldownMs: number,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  setRules(rules: AlertRule[]) {
    const by = new Map<string, AlertRule[]>();
    for (const r of rules) {
      if (r.above === null && r.below === null) continue;
      (by.get(r.symbol) ?? by.set(r.symbol, []).get(r.symbol)!).push(r);
    }
    this.rules = by;
  }

  seed(prices: Map<string, number>) {
    for (const [s, p] of prices) if (!this.last.has(s)) this.last.set(s, p);
  }

  /** Call for every tick (before write throttling). */
  async onTick(symbol: string, price: number): Promise<void> {
    const prev = this.last.get(symbol);
    this.last.set(symbol, price);
    const rules = this.rules.get(symbol);
    if (!rules) return;
    const now = this.now();
    const cutoff = now - this.cooldownMs;
    await Promise.all(
      rules.flatMap((rule) =>
        detectCrossings(prev, price, rule).map(async (dir) => {
          const firedAt = dir === "above" ? rule.aboveFiredAt : rule.belowFiredAt;
          if (firedAt !== null && firedAt > cutoff) return; // cooling down
          const key = `${rule.id}|${dir}`;
          if (this.inFlight.has(key)) return;
          this.inFlight.add(key);
          try {
            if (await this.store.fire(rule, dir, price, cutoff, now)) {
              this.fired++;
              if (dir === "above") rule.aboveFiredAt = now;
              else rule.belowFiredAt = now;
              this.log.info("price alert fired", { symbol, dir });
            } else {
              // Someone else claimed it or cooldown applies server-side.
              if (dir === "above") rule.aboveFiredAt = now;
              else rule.belowFiredAt = now;
            }
          } catch (err) {
            this.log.error("alert fire failed", { symbol, error: err instanceof Error ? err.message : String(err) });
          } finally {
            this.inFlight.delete(key);
          }
        }),
      ),
    );
  }
}
