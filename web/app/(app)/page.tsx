import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/form-bits";
import { createClient } from "@/lib/supabase/server";
import { loadPortfolio } from "@/lib/holdings/service";
import { ACCOUNT_TYPE_LABELS } from "@/lib/holdings/schemas";
import { SOURCE_LABELS, usd } from "@/lib/format";
import { dayChange } from "@/lib/valuation";
import { LiveRefresh } from "@/components/live-refresh";

export default function Page() {
  return (
    <>
      <PageHeader title="Dashboard" description="Balances, your daily briefing, and top alerts." />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading balances...</p>}>
        <Balances />
      </Suspense>
      <Suspense fallback={null}>
        <TopAlerts />
      </Suspense>
    </>
  );
}

async function Balances() {
  const supabase = await createClient();
  const { accounts, holdings, summary, quotes } = await loadPortfolio(supabase);
  const day = dayChange(holdings, quotes);

  if (holdings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
        No holdings yet. <Link className="underline" href="/holdings">Add some manually</Link> or{" "}
        <Link className="underline" href="/settings/connections">connect a brokerage or wallet</Link>.
      </div>
    );
  }

  const pending = summary.pendingCount > 0;
  return (
    <div className="space-y-8">
      <LiveRefresh symbols={holdings.filter((h) => h.asset_type !== "cash").map((h) => h.symbol)} />
      <section className="rounded-lg border p-5">
        <p className="text-xs font-medium text-muted-foreground">Total value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{usd(summary.total)}</p>
        {day.covered > 0 && (
          <p className={`mt-1 text-sm tabular-nums ${day.amount >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {day.amount >= 0 ? "+" : ""}{usd(day.amount)}{day.pct !== null && ` (${day.pct >= 0 ? "+" : ""}${day.pct.toFixed(2)}%)`}
            <span className="ml-2 text-xs text-muted-foreground">today / 24h, {day.covered} priced holding{day.covered === 1 ? "" : "s"}</span>
          </p>
        )}
        {pending && (
          <p className="mt-2 text-sm text-muted-foreground">
            <Badge tone="warn">Price pending</Badge>{" "}
            {summary.pendingCount} of {holdings.length} holdings are valued at cost basis (or $0 if unknown) until live prices are available.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">By source</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[...summary.bySource].map(([source, b]) => (
            <div key={source} className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{SOURCE_LABELS[source] ?? source}</p>
              <p className="text-lg font-semibold tabular-nums">{usd(b.value)}</p>
              <p className="text-xs text-muted-foreground">
                {b.count} holding{b.count === 1 ? "" : "s"}{b.pending > 0 && " · price pending"}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">By account</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2 text-right">Holdings</th>
                <th className="px-3 py-2 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const b = summary.byAccount.get(a.id);
                return (
                  <tr key={a.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{a.name}{a.institution && <span className="ml-2 text-xs text-muted-foreground">{a.institution}</span>}</td>
                    <td className="px-3 py-2"><Badge tone="muted">{ACCOUNT_TYPE_LABELS[a.type] ?? a.type}</Badge></td>
                    <td className="px-3 py-2 text-right tabular-nums">{b?.count ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {usd(b?.value ?? 0)}
                      {b && b.pending > 0 && <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">price pending</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

async function TopAlerts() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("alerts")
    .select("id,kind,symbol,title,body,created_at,read_at")
    .order("created_at", { ascending: false })
    .limit(5);
  if (!data?.length) return null;
  return (
    <section className="mt-8 space-y-2">
      <h2 className="text-sm font-semibold">Recent alerts <Link className="ml-2 text-xs font-normal text-muted-foreground underline" href="/news">All news</Link></h2>
      <ul className="divide-y rounded-lg border text-sm">
        {data.map((a) => (
          <li key={a.id} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
            {!a.read_at && <Badge tone="warn">New</Badge>}
            {a.kind === "news" ? (
              <Link className="font-medium hover:underline" href="/news">{a.title}</Link>
            ) : (
              <span className="font-medium">{a.title}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString("en-US")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
