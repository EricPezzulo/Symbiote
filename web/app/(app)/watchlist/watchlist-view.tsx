"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Field, FormStatus, inputClass } from "@/components/form-bits";
import { cn } from "@/lib/utils";
import { usd } from "@/lib/format";
import { agoLabel, isStale, type PriceRow } from "@/lib/prices/types";
import { marketHint, usMarketOpen } from "@/lib/prices/market";
import { useLivePrices, useNow } from "@/lib/prices/use-live-prices";
import { addWatch, removeWatch, updateWatch } from "./actions";

export type WatchItem = {
  id: string;
  symbol: string;
  asset_type: string;
  notes: string | null;
  alert_above: number | null;
  alert_below: number | null;
};

const price = (n: number) => (n < 1 ? `$${n.toPrecision(4)}` : usd(n));

export function WatchlistView({ items, initialPrices }: { items: WatchItem[]; initialPrices: PriceRow[] }) {
  const symbols = items.map((i) => i.symbol);
  const { rows, flash, status } = useLivePrices(initialPrices, symbols);
  const now = useNow(1000);
  const open = now === null ? false : usMarketOpen(new Date(now));
  const hasStocks = items.some((i) => i.asset_type !== "crypto");

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Add symbol</h2>
        <AddForm />
      </section>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge tone={status === "live" ? "good" : status === "reconnecting" ? "warn" : "muted"}>
          {status === "live" ? "Live" : status === "reconnecting" ? "Reconnecting..." : "Connecting..."}
        </Badge>
        {hasStocks && now !== null && <Badge tone={open ? "good" : "muted"}>{open ? "Market open" : "Market closed"}</Badge>}
        {hasStocks && now !== null && <span>{marketHint(new Date(now))}</span>}
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">Nothing on your watchlist yet. Add a ticker or coin above.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Change</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2">Targets</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <Row key={it.id} item={it} row={rows.get(it.symbol)} flash={flash[it.symbol]} now={now} marketOpen={open} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Stock prices come from the free IEX feed (a fraction of total market volume, so last-trade prices can lag on thinly traded names).
        Change is vs previous close for stocks and rolling 24h for crypto. Exchange holidays are not reflected in the market hint.
      </p>
    </div>
  );
}

function Row({ item, row, flash, now, marketOpen }: { item: WatchItem; row: PriceRow | undefined; flash: "up" | "down" | undefined; now: number | null; marketOpen: boolean }) {
  const stale = row && now !== null ? isStale(row, now, marketOpen) : false;
  const chg = row?.change_24h_pct ?? null;
  return (
    <>
      <tr className="border-t align-top">
        <td className="px-3 py-2 font-medium">
          {item.symbol}
          <span className="ml-1 text-xs text-muted-foreground">{item.asset_type}</span>
          {item.notes && <p className="max-w-xs truncate text-xs font-normal text-muted-foreground" title={item.notes}>{item.notes}</p>}
        </td>
        <td
          className={cn(
            "px-3 py-2 text-right tabular-nums transition-colors duration-500",
            flash === "up" && "bg-emerald-500/20",
            flash === "down" && "bg-red-500/20",
          )}
        >
          {row ? price(row.price) : <span className="text-muted-foreground">Waiting for price</span>}
        </td>
        <td className={cn("px-3 py-2 text-right tabular-nums", chg !== null && chg > 0 && "text-emerald-600 dark:text-emerald-400", chg !== null && chg < 0 && "text-red-600 dark:text-red-400")}>
          {chg === null ? "—" : `${chg > 0 ? "+" : ""}${chg.toFixed(2)}%`}
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {row ? (
            <span suppressHydrationWarning className={cn(stale && "text-amber-600 dark:text-amber-400")}>
              {now === null ? "—" : agoLabel(row.updated_at, now)}
              {stale && " (stale)"}
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
          {item.alert_above === null && item.alert_below === null ? "—" : (
            <>
              {item.alert_above !== null && <div>above {price(item.alert_above)}</div>}
              {item.alert_below !== null && <div>below {price(item.alert_below)}</div>}
            </>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-start justify-end gap-1">
            <EditItem item={item} />
            <form action={removeWatch}>
              <input type="hidden" name="id" value={item.id} />
              <Button type="submit" variant="ghost" size="xs">Remove</Button>
            </form>
          </div>
        </td>
      </tr>
    </>
  );
}

function AddForm() {
  const [state, action, pending] = useActionState(addWatch, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-6 sm:items-end">
      <Field label="Symbol">
        <input name="symbol" required maxLength={16} className={inputClass} placeholder="AAPL" autoCapitalize="characters" />
      </Field>
      <Field label="Type">
        <select name="asset_type" className={inputClass} defaultValue="stock">
          <option value="stock">Stock</option>
          <option value="crypto">Crypto</option>
        </select>
      </Field>
      <Field label="Alert above (USD)">
        <input name="alert_above" inputMode="decimal" className={inputClass} placeholder="optional" />
      </Field>
      <Field label="Alert below (USD)">
        <input name="alert_below" inputMode="decimal" className={inputClass} placeholder="optional" />
      </Field>
      <Field label="Note">
        <input name="notes" maxLength={280} className={inputClass} placeholder="optional" />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add"}</Button>
      <div className="sm:col-span-6"><FormStatus state={state} /></div>
    </form>
  );
}

function EditItem({ item }: { item: WatchItem }) {
  const [state, action, pending] = useActionState(updateWatch, null);
  return (
    <details className="relative">
      <summary className="inline-flex h-6 cursor-pointer list-none items-center rounded-lg px-2 text-xs font-medium hover:bg-muted">Edit</summary>
      <form action={action} className="absolute right-0 z-10 mt-1 grid w-64 gap-2 rounded-lg border bg-background p-3 shadow-md">
        <input type="hidden" name="id" value={item.id} />
        <Field label="Alert above (USD)">
          <input name="alert_above" inputMode="decimal" defaultValue={item.alert_above ?? ""} className={inputClass} />
        </Field>
        <Field label="Alert below (USD)">
          <input name="alert_below" inputMode="decimal" defaultValue={item.alert_below ?? ""} className={inputClass} />
        </Field>
        <Field label="Note">
          <input name="notes" maxLength={280} defaultValue={item.notes ?? ""} className={inputClass} />
        </Field>
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving..." : "Save"}</Button>
        <FormStatus state={state} />
      </form>
    </details>
  );
}
