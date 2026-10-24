import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";
import { buildUniverse, normalizeSymbol, type SymbolSets } from "./symbols.js";
import { alertText, type AlertRule, type AlertStore, type Direction } from "./alerts.js";
import type { HistoryRow, PriceRow, PriceSink } from "./writer.js";

export function createAdmin(c: Pick<Config, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">): SupabaseClient {
  return createClient(c.SUPABASE_URL, c.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const PAGE = 1000;

/** Page through a table (PostgREST caps responses at 1000 rows). */
export async function fetchAll<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  filter?: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = client.from(table).select(columns);
    if (filter) q = filter(q);
    const { data, error } = await q.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

type WatchRow = {
  id: string;
  user_id: string;
  symbol: string;
  asset_type: string;
  alert_above: number | string | null;
  alert_below: number | string | null;
  alert_above_fired_at: string | null;
  alert_below_fired_at: string | null;
};

const numOrNull = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));
const msOrNull = (v: string | null) => (v ? Date.parse(v) : null);

export async function loadUniverse(client: SupabaseClient): Promise<{ sets: SymbolSets; rules: AlertRule[] }> {
  const [holdings, watch] = await Promise.all([
    fetchAll<{ symbol: string; asset_type: string }>(client, "holdings", "id,symbol,asset_type"),
    fetchAll<WatchRow>(
      client,
      "watchlist",
      "id,user_id,symbol,asset_type,alert_above,alert_below,alert_above_fired_at,alert_below_fired_at",
    ),
  ]);
  const sets = buildUniverse([...holdings, ...watch]);
  const rules: AlertRule[] = watch
    .filter((w) => w.alert_above !== null || w.alert_below !== null)
    .map((w) => ({
      id: w.id,
      user_id: w.user_id,
      symbol: w.asset_type === "crypto" ? normalizeSymbol(w.symbol).replace(/[-/_](USD|USDT)$/, "") : normalizeSymbol(w.symbol),
      above: numOrNull(w.alert_above),
      below: numOrNull(w.alert_below),
      aboveFiredAt: msOrNull(w.alert_above_fired_at),
      belowFiredAt: msOrNull(w.alert_below_fired_at),
    }));
  return { sets, rules };
}

export async function loadLastPrices(client: SupabaseClient): Promise<Map<string, number>> {
  const { data } = await client.from("prices").select("symbol,price");
  return new Map((data ?? []).map((r: { symbol: string; price: number | string }) => [r.symbol, Number(r.price)]));
}

export class SupabaseSink implements PriceSink {
  constructor(private readonly client: SupabaseClient) {}

  async upsertPrices(rows: PriceRow[]) {
    if (!rows.length) return;
    const { error } = await this.client.from("prices").upsert(rows, { onConflict: "symbol" });
    if (error) throw new Error(error.message);
  }

  async upsertHistory(rows: HistoryRow[], overwrite: boolean) {
    if (!rows.length) return;
    const { error } = await this.client
      .from("price_history")
      .upsert(rows, { onConflict: "symbol,day", ignoreDuplicates: !overwrite });
    if (error) throw new Error(error.message);
  }
}

export class SupabaseAlertStore implements AlertStore {
  constructor(private readonly client: SupabaseClient) {}

  async fire(rule: AlertRule, dir: Direction, price: number, cutoffMs: number, nowMs: number): Promise<boolean> {
    const col = dir === "above" ? "alert_above" : "alert_below";
    const firedCol = `${col}_fired_at`;
    const threshold = dir === "above" ? rule.above : rule.below;
    if (threshold === null) return false;
    // Atomic claim: only one worker/process wins per cooldown window, and only while the
    // threshold the user set is the one we evaluated.
    const { data, error } = await this.client
      .from("watchlist")
      .update({ [firedCol]: new Date(nowMs).toISOString() })
      .eq("id", rule.id)
      .eq(col, threshold)
      .or(`${firedCol}.is.null,${firedCol}.lt.${new Date(cutoffMs).toISOString()}`)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) return false;
    const { title, body } = alertText(rule.symbol, dir, threshold, price);
    const { error: insErr } = await this.client.from("alerts").insert({
      user_id: rule.user_id,
      symbol: rule.symbol,
      kind: "price",
      severity: 2,
      title,
      body,
    });
    if (insErr) {
      // Release the claim so the next crossing can retry.
      await this.client.from("watchlist").update({ [firedCol]: null }).eq("id", rule.id);
      throw new Error(insErr.message);
    }
    return true;
  }
}
