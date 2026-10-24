import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRICE_COLUMNS, toPriceRow, type PriceRow } from "./types";

/** Latest prices for the given symbols (RLS: authenticated read). */
export async function loadPriceRows(client: SupabaseClient, symbols: string[]): Promise<PriceRow[]> {
  const unique = [...new Set(symbols)];
  if (!unique.length) return [];
  const first = await client.from("prices").select(PRICE_COLUMNS).in("symbol", unique);
  let data = first.data as Record<string, unknown>[] | null;
  if (first.error) {
    // Phase 3 migration (prev_close) not applied yet: degrade gracefully.
    const retry = await client
      .from("prices")
      .select("symbol,asset_type,price,change_24h_pct,volume_24h,source,updated_at")
      .in("symbol", unique);
    data = retry.data as Record<string, unknown>[] | null;
  }
  return (data ?? []).map(toPriceRow).filter((r): r is PriceRow => r !== null);
}
