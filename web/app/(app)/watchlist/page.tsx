import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";
import { loadPriceRows } from "@/lib/prices/queries";
import { WatchlistView, type WatchItem } from "./watchlist-view";

export default function Page() {
  return (
    <>
      <PageHeader title="Watchlist" description="Tickers and coins you are tracking, with live prices." />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading watchlist...</p>}>
        <WatchlistData />
      </Suspense>
    </>
  );
}

async function WatchlistData() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("watchlist")
    .select("id,symbol,asset_type,notes,alert_above,alert_below,created_at")
    .order("created_at", { ascending: true });
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the watchlist ({error.code === "42703" ? "run `npx supabase db push` to apply the latest migration" : "try again"}).
      </p>
    );
  }
  const items: WatchItem[] = (data ?? []).map((w) => ({
    id: w.id,
    symbol: w.symbol,
    asset_type: w.asset_type,
    notes: w.notes,
    alert_above: w.alert_above === null ? null : Number(w.alert_above),
    alert_below: w.alert_below === null ? null : Number(w.alert_below),
  }));
  const prices = await loadPriceRows(supabase, items.map((i) => i.symbol));
  return <WatchlistView items={items} initialPrices={prices} />;
}
