import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { IntervalRefresh } from "@/components/interval-refresh";
import { createClient } from "@/lib/supabase/server";
import { filtersToQuery, parseFilters } from "@/lib/news/filters";
import { clock, loadCatalysts, loadNewsAlerts } from "@/lib/news/queries";
import { markAllRead } from "./actions";
import { AlertRow, CatalystList, FilterBar } from "./news-parts";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="News" description="Scored headlines and catalysts that touch your holdings and watchlist." />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading news...</p>}>
        <NewsData searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function NewsData({ searchParams }: { searchParams: SP }) {
  const f = parseFilters(await searchParams);
  const supabase = await createClient();
  const [page, catalysts] = await Promise.all([
    loadNewsAlerts(supabase, f),
    f.cursor ? Promise.resolve([]) : loadCatalysts(supabase, new Date(clock.now() - 3 * 86_400_000).toISOString()),
  ]);
  const now = clock.now();

  if ("error" in page) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {page.error === "migration" ? "News needs the latest database migration (run `npx supabase db push`)." : "Could not load news. Try again."}
      </p>
    );
  }
  const base = { scope: f.scope, sentiment: f.sentiment, catalyst: f.catalyst, symbol: f.symbol };
  const filtered = f.scope !== "all" || f.sentiment !== "all" || f.catalyst || f.symbol;
  return (
    <div className="space-y-6">
      <IntervalRefresh everyMs={60_000} />
      <CatalystList items={catalysts} now={now} />
      <FilterBar f={f} />
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Your alerts {page.unread > 0 && <span className="font-normal text-muted-foreground">· {page.unread} unread</span>}</h2>
          {page.unread > 0 && (
            <form action={markAllRead}><button className="text-xs text-muted-foreground underline">Mark all read</button></form>
          )}
        </div>
        {page.items.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
            {filtered ? "No alerts match these filters." : "No news alerts yet. The worker scores incoming headlines and raises an alert when one is relevant to your holdings or watchlist."}
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {page.items.map((a) => <AlertRow key={a.id} a={a} now={now} />)}
          </ul>
        )}
        <div className="flex justify-between text-sm">
          {f.cursor ? <Link className="underline" href={`/news${filtersToQuery(base)}`}>Back to newest</Link> : <span />}
          {page.next && <Link className="underline" href={`/news${filtersToQuery(base, page.next)}`}>Older</Link>}
        </div>
      </section>
    </div>
  );
}
