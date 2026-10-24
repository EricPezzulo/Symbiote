// Pure valuation. Prices come from the `prices` table (written by the worker, Phase 3).

export type ValuableHolding = {
  id: string;
  account_id: string;
  symbol: string;
  asset_type: string;
  quantity: number;
  cost_basis: number | null;
  source: string;
};

export type PriceMap = Map<string, number>;

export type ValueBasis = "price" | "cost" | "none";

export type ValuedHolding = {
  value: number;
  basis: ValueBasis; // "price" = live, "cost" = fallback (price pending), "none" = unknown
  price: number | null;
  gainLoss: number | null; // only when priced and cost basis known
  gainLossPct: number | null;
};

export function valueHolding(h: ValuableHolding, prices: PriceMap): ValuedHolding {
  const qty = Number(h.quantity);
  const cost = h.cost_basis === null ? null : Number(h.cost_basis);
  const price = h.asset_type === "cash" ? 1 : (prices.get(h.symbol) ?? null);
  if (price !== null) {
    const value = qty * price;
    const gl = cost !== null && h.asset_type !== "cash" ? value - cost : null;
    return {
      value,
      basis: "price",
      price,
      gainLoss: gl,
      gainLossPct: gl !== null && cost ? (gl / Math.abs(cost)) * 100 : null,
    };
  }
  if (cost !== null) return { value: cost, basis: "cost", price: null, gainLoss: null, gainLossPct: null };
  return { value: 0, basis: "none", price: null, gainLoss: null, gainLossPct: null };
}

export type Bucket = { value: number; pending: number; count: number };

export type PortfolioSummary = {
  total: number;
  pendingCount: number; // holdings valued at cost basis or unknown
  byAccount: Map<string, Bucket>;
  bySource: Map<string, Bucket>;
};

export function summarise(holdings: ValuableHolding[], prices: PriceMap): PortfolioSummary {
  const s: PortfolioSummary = { total: 0, pendingCount: 0, byAccount: new Map(), bySource: new Map() };
  const add = (m: Map<string, Bucket>, k: string, v: number, pending: boolean) => {
    const b = m.get(k) ?? { value: 0, pending: 0, count: 0 };
    b.value += v;
    b.count += 1;
    if (pending) b.pending += 1;
    m.set(k, b);
  };
  for (const h of holdings) {
    const v = valueHolding(h, prices);
    const pending = v.basis !== "price";
    s.total += v.value;
    if (pending) s.pendingCount++;
    add(s.byAccount, h.account_id, v.value, pending);
    add(s.bySource, h.source, v.value, pending);
  }
  return s;
}

// ---------------------------------------------------------------- day change (Phase 3)
export type Quote = {
  price: number;
  prevClose: number | null; // stocks: previous close; crypto: 24h-ago open
  updatedAt: string | null;
};
export type QuoteMap = Map<string, Quote>;

export type DayChange = {
  amount: number; // sum of qty * (price - prevClose) over holdings that have both
  pct: number | null; // amount / previous value
  covered: number; // holdings included
};

/** Portfolio change since previous close (stocks) / 24h (crypto). Cash and unquoted holdings are skipped. */
export function dayChange(holdings: ValuableHolding[], quotes: QuoteMap): DayChange {
  let amount = 0;
  let prevValue = 0;
  let covered = 0;
  for (const h of holdings) {
    if (h.asset_type === "cash") continue;
    const q = quotes.get(h.symbol);
    if (!q || q.prevClose === null || !(q.prevClose > 0)) continue;
    const qty = Number(h.quantity);
    amount += qty * (q.price - q.prevClose);
    prevValue += qty * q.prevClose;
    covered++;
  }
  return { amount, pct: prevValue > 0 ? (amount / prevValue) * 100 : null, covered };
}
