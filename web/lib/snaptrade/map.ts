import type { NewHolding } from "@/lib/holdings/service";

export const SNAPTRADE_SLOT_CAP = 5;

// Structural subset of the SDK's Position type (kept loose so tests need no SDK).
export type SnaptradePositionLike = {
  symbol?: {
    symbol?: { symbol?: string; raw_symbol?: string; type?: { code?: string } | null } | null;
  } | null;
  units?: number | null;
  fractional_units?: number | null;
  average_purchase_price?: number | null;
  cash_equivalent?: boolean | null;
};

export function mapSnaptradePositions(positions: SnaptradePositionLike[]): NewHolding[] {
  const bySymbol = new Map<string, NewHolding>();
  for (const p of positions) {
    const u = p.symbol?.symbol;
    const symbol = (u?.symbol ?? u?.raw_symbol ?? "").trim().toUpperCase();
    const units = p.units ?? p.fractional_units;
    if (!symbol || units === null || units === undefined || units === 0) continue;
    const code = (u?.type?.code ?? "").toLowerCase();
    const asset_type: NewHolding["asset_type"] = p.cash_equivalent
      ? "cash"
      : code === "crypto"
        ? "crypto"
        : code === "et"
          ? "etf"
          : "stock";
    const cost =
      p.average_purchase_price !== null && p.average_purchase_price !== undefined
        ? p.average_purchase_price * units
        : null;
    const prev = bySymbol.get(symbol);
    if (prev) {
      prev.quantity = Number(prev.quantity) + units;
      prev.cost_basis = prev.cost_basis == null && cost == null ? null : (prev.cost_basis ?? 0) + (cost ?? 0);
    } else bySymbol.set(symbol, { symbol, asset_type, quantity: units, cost_basis: cost });
  }
  return [...bySymbol.values()];
}

export function slotsMessage(used: number): string | null {
  return used >= SNAPTRADE_SLOT_CAP
    ? `All ${SNAPTRADE_SLOT_CAP} free SnapTrade brokerage slots are in use app-wide, so a new brokerage can't be linked right now. Use the Fidelity CSV import below instead.`
    : null;
}
