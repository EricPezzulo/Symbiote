import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { replaceSourceHoldings, writeSnapshots, type NewHolding } from "@/lib/holdings/service";
import { scanBtcWallet } from "./btc";
import type { EsploraClient } from "./esplora";
import type { EvmBalanceProvider } from "./evm";
import { satsToBtc } from "./server";

export type WalletRow = {
  id: string;
  label: string;
  chain: "btc" | "evm";
  public_key: string;
};

type Deps = { esplora: () => EsploraClient; evm: () => EvmBalanceProvider };

/** Balances -> holdings (source='wallet') in the wallet's backing account. RLS-scoped client. */
export async function syncWallet(client: SupabaseClient, userId: string, wallet: WalletRow, deps: Deps) {
  let holdings: NewHolding[];
  if (wallet.chain === "btc") {
    const scan = await scanBtcWallet(wallet.public_key, deps.esplora());
    holdings = scan.balanceSats > 0n ? [{ symbol: "BTC", asset_type: "crypto", quantity: satsToBtc(scan.balanceSats) }] : [];
  } else {
    const balances = await deps.evm().getBalances(wallet.public_key);
    const merged = new Map<string, number>();
    // Same ticker from different contracts is summed: holdings are unique per (account, symbol).
    for (const b of balances) merged.set(b.symbol, (merged.get(b.symbol) ?? 0) + Number(b.balance));
    holdings = [...merged].map(([symbol, quantity]) => ({ symbol, asset_type: "crypto", quantity }));
  }

  const { data: account, error } = await client
    .from("accounts")
    .select("id")
    .eq("wallet_id", wallet.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  let accountId = account?.id as string | undefined;
  if (!accountId) {
    const { data, error: insErr } = await client
      .from("accounts")
      .insert({ user_id: userId, wallet_id: wallet.id, name: wallet.label, type: "crypto_wallet", institution: "Trezor" })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    accountId = data.id;
  }
  await replaceSourceHoldings(client, userId, accountId!, "wallet", holdings);
  await client.from("wallets").update({ last_synced_at: new Date().toISOString() }).eq("id", wallet.id).eq("user_id", userId);
  return { holdings: holdings.length };
}

export async function syncWalletAndSnapshot(client: SupabaseClient, userId: string, wallet: WalletRow, deps: Deps) {
  const r = await syncWallet(client, userId, wallet, deps);
  await writeSnapshots(client, userId);
  return r;
}
