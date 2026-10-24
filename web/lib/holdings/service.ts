import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { summarise, type PriceMap, type QuoteMap, type ValuableHolding } from "@/lib/valuation";

export type AccountRow = {
  id: string;
  name: string;
  type: string;
  institution: string | null;
  connection_id: string | null;
  wallet_id: string | null;
  external_id: string | null;
  currency: string;
};

export type HoldingRow = ValuableHolding & {
  as_of: string;
};

export type NewHolding = {
  symbol: string;
  asset_type: "stock" | "etf" | "crypto" | "cash" | "other";
  quantity: number | string;
  cost_basis?: number | null; // omit to leave an existing value untouched
};

/**
 * Make `source`'s holdings in an account exactly match `rows`: upsert by
 * (account, symbol) and delete this source's holdings that disappeared.
 * `client` must be RLS-scoped to `userId` (or the admin client with userId checked).
 */
export async function replaceSourceHoldings(
  client: SupabaseClient,
  userId: string,
  accountId: string,
  source: "csv" | "snaptrade" | "wallet",
  rows: NewHolding[],
) {
  const now = new Date().toISOString();
  if (rows.length > 0) {
    const withCost = rows.filter((r) => r.cost_basis !== undefined);
    const withoutCost = rows.filter((r) => r.cost_basis === undefined);
    for (const group of [withCost, withoutCost]) {
      if (group.length === 0) continue;
      const { error } = await client.from("holdings").upsert(
        group.map((r) => ({
          user_id: userId,
          account_id: accountId,
          symbol: r.symbol,
          asset_type: r.asset_type,
          quantity: r.quantity,
          ...(r.cost_basis !== undefined ? { cost_basis: r.cost_basis } : {}),
          source,
          as_of: now,
        })),
        { onConflict: "account_id,symbol" },
      );
      if (error) throw new Error(`Saving holdings failed: ${error.message}`);
    }
  }
  const { data: existing, error: selErr } = await client
    .from("holdings")
    .select("id,symbol")
    .eq("account_id", accountId)
    .eq("source", source);
  if (selErr) throw new Error(`Reading holdings failed: ${selErr.message}`);
  const keep = new Set(rows.map((r) => r.symbol));
  const stale = (existing ?? []).filter((e) => !keep.has(e.symbol)).map((e) => e.id);
  if (stale.length > 0) {
    const { error } = await client.from("holdings").delete().in("id", stale);
    if (error) throw new Error(`Removing stale holdings failed: ${error.message}`);
  }
}

export async function loadQuotes(client: SupabaseClient, symbols: string[]): Promise<QuoteMap> {
  const quotes: QuoteMap = new Map();
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return quotes;
  // Global `prices` table, written by the worker. prev_close needs the Phase 3 migration; fall back
  // to price-only if it has not been applied yet so valuation keeps working.
  type Raw = { symbol: string; price: number | string; prev_close?: number | string | null; updated_at?: string };
  const first = await client.from("prices").select("symbol,price,prev_close,updated_at").in("symbol", unique);
  let data = first.data as Raw[] | null;
  if (first.error) {
    data = (await client.from("prices").select("symbol,price").in("symbol", unique)).data as Raw[] | null;
  }
  for (const p of data ?? []) {
    quotes.set(p.symbol, {
      price: Number(p.price),
      prevClose: p.prev_close === null || p.prev_close === undefined ? null : Number(p.prev_close),
      updatedAt: p.updated_at ?? null,
    });
  }
  return quotes;
}

export async function loadPrices(client: SupabaseClient, symbols: string[]): Promise<PriceMap> {
  const quotes = await loadQuotes(client, symbols);
  return new Map([...quotes].map(([symbol, q]) => [symbol, q.price]));
}

export async function loadPortfolio(client: SupabaseClient) {
  const [accRes, holdRes] = await Promise.all([
    client.from("accounts").select("id,name,type,institution,connection_id,wallet_id,external_id,currency").order("created_at"),
    client.from("holdings").select("id,account_id,symbol,asset_type,quantity,cost_basis,source,as_of").order("symbol"),
  ]);
  if (accRes.error) throw new Error(accRes.error.message);
  if (holdRes.error) throw new Error(holdRes.error.message);
  const accounts = (accRes.data ?? []) as AccountRow[];
  const holdings: HoldingRow[] = (holdRes.data ?? []).map((h) => ({
    ...h,
    quantity: Number(h.quantity),
    cost_basis: h.cost_basis === null ? null : Number(h.cost_basis),
  }));
  const quotes = await loadQuotes(client, holdings.map((h) => h.symbol));
  const prices: PriceMap = new Map([...quotes].map(([symbol, q]) => [symbol, q.price]));
  return { accounts, holdings, prices, quotes, summary: summarise(holdings, prices) };
}

/** Record a balance_snapshots row per account plus a null-account total. Call after each sync. */
export async function writeSnapshots(client: SupabaseClient, userId: string) {
  const { accounts, summary } = await loadPortfolio(client);
  const rows = [
    ...accounts.map((a) => ({
      user_id: userId,
      account_id: a.id,
      total_value: summary.byAccount.get(a.id)?.value ?? 0,
      currency: a.currency,
    })),
    { user_id: userId, account_id: null, total_value: summary.total, currency: "USD" },
  ];
  const { error } = await client.from("balance_snapshots").insert(rows);
  if (error) throw new Error(`Writing balance snapshot failed: ${error.message}`);
}

/** Find-or-create an account matched by (connection, external id). */
export async function ensureAccount(
  client: SupabaseClient,
  userId: string,
  spec: {
    connection_id: string;
    external_id: string;
    name: string;
    type: "brokerage" | "exchange" | "crypto_wallet" | "manual";
    institution: string | null;
    currency?: string;
  },
): Promise<string> {
  const { data: found, error } = await client
    .from("accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("connection_id", spec.connection_id)
    .eq("external_id", spec.external_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (found) {
    await client.from("accounts").update({ name: spec.name, institution: spec.institution }).eq("id", found.id);
    return found.id;
  }
  const { data, error: insErr } = await client
    .from("accounts")
    .insert({ user_id: userId, ...spec, currency: spec.currency ?? "USD" })
    .select("id")
    .single();
  if (insErr) throw new Error(insErr.message);
  return data.id;
}
