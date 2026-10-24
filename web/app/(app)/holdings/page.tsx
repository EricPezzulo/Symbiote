import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/form-bits";
import { createClient } from "@/lib/supabase/server";
import { loadPortfolio } from "@/lib/holdings/service";
import { valueHolding } from "@/lib/valuation";
import { ACCOUNT_TYPE_LABELS } from "@/lib/holdings/schemas";
import { qty, SOURCE_LABELS, usd } from "@/lib/format";
import { LiveRefresh } from "@/components/live-refresh";
import { AddAccountForm, AddHoldingForm, EditHolding } from "./forms";
import { deleteAccount, deleteHolding } from "./actions";

export default function Page() {
  return (
    <>
      <PageHeader title="Holdings" description="All accounts and wallets in one view." />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading holdings...</p>}>
        <HoldingsView />
      </Suspense>
    </>
  );
}

async function HoldingsView() {
  const supabase = await createClient();
  const { accounts, holdings, prices } = await loadPortfolio(supabase);

  return (
    <div className="space-y-8">
      <LiveRefresh symbols={holdings.filter((h) => h.asset_type !== "cash").map((h) => h.symbol)} />
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Add account</h2>
        <AddAccountForm />
      </section>
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Add holding</h2>
        <AddHoldingForm accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
      </section>

      {accounts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No accounts yet. Add one above, import a Fidelity CSV, or connect a wallet under Connections.
        </p>
      )}

      {accounts.map((a) => {
        const rows = holdings.filter((h) => h.account_id === a.id);
        return (
          <section key={a.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{a.name}</h2>
              <Badge tone="muted">{ACCOUNT_TYPE_LABELS[a.type] ?? a.type}</Badge>
              {a.institution && <span className="text-xs text-muted-foreground">{a.institution}</span>}
              {!a.wallet_id && (
                <form action={deleteAccount} className="ml-auto">
                  <input type="hidden" name="id" value={a.id} />
                  <Button type="submit" variant="ghost" size="xs">Delete account</Button>
                </form>
              )}
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2 text-right">Quantity</th>
                    <th className="px-3 py-2 text-right">Cost basis</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Value</th>
                    <th className="px-3 py-2 text-right">Gain/loss</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={8} className="px-3 py-4 text-muted-foreground">No holdings.</td></tr>
                  )}
                  {rows.map((h) => {
                    const v = valueHolding(h, prices);
                    return (
                      <tr key={h.id} className="border-t align-top">
                        <td className="px-3 py-2 font-medium">{h.symbol}<span className="ml-1 text-xs text-muted-foreground">{h.asset_type}</span></td>
                        <td className="px-3 py-2"><Badge tone={h.source === "manual" ? "default" : "good"}>{SOURCE_LABELS[h.source] ?? h.source}</Badge></td>
                        <td className="px-3 py-2 text-right tabular-nums">{qty(h.quantity)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.cost_basis === null ? "—" : usd(h.cost_basis)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{v.price === null ? "—" : usd(v.price)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{v.basis === "price" ? usd(v.value) : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {v.gainLoss === null ? "—" : `${usd(v.gainLoss)}${v.gainLossPct === null ? "" : ` (${v.gainLossPct.toFixed(1)}%)`}`}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-start justify-end gap-1">
                            {h.source === "manual" && <EditHolding holding={h} />}
                            <form action={deleteHolding}>
                              <input type="hidden" name="id" value={h.id} />
                              <Button type="submit" variant="ghost" size="xs">Delete</Button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
