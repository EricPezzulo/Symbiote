import Link from "next/link";
import { Badge } from "@/components/form-bits";
import { cn } from "@/lib/utils";
import { filtersToQuery, relativeTime, relevanceLevel, safeHttpUrl, SCOPES, SENTIMENT_FILTERS, SENTIMENT_LABELS, type NewsFilters } from "@/lib/news/filters";
import type { Catalyst, NewsAlert } from "@/lib/news/queries";
import { dismiss, markRead } from "./actions";

// All text below comes from external feeds / the model. It is rendered only as React text nodes (escaped);
// there is no dangerouslySetInnerHTML anywhere.

export function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  const label = SENTIMENT_LABELS[sentiment] ?? "Neutral";
  if (sentiment === "positive") return <Badge tone="good">{label}</Badge>;
  if (sentiment === "negative") {
    return <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">{label}</span>;
  }
  if (sentiment === "mixed") return <Badge tone="warn">{label}</Badge>;
  return <Badge tone="muted">{label}</Badge>;
}

export function RelevanceMeter({ score }: { score: number | null }) {
  const { label, bars } = relevanceLevel(score);
  const pct = Math.round((score ?? 0) * 100);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={`Relevance ${pct}/100`}>
      <span aria-hidden className="flex items-end gap-0.5">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("w-1 rounded-sm", i <= bars ? "bg-foreground/70" : "bg-muted")} style={{ height: 4 + i * 3 }} />
        ))}
      </span>
      <span>{label} · {pct}</span>
    </span>
  );
}

function Headline({ title, url }: { title: string; url: string | null }) {
  const href = safeHttpUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-2 hover:underline">{title}</a>
  ) : (
    <span className="font-medium">{title}</span>
  );
}

const SCOPE_LABELS: Record<string, string> = { all: "All", holding: "Holdings", watchlist: "Watchlist", market: "Market-wide" };
const SENT_FILTER_LABELS: Record<string, string> = { all: "Any sentiment", positive: "Positive", negative: "Negative" };

export function FilterBar({ f }: { f: NewsFilters }) {
  const base = { scope: f.scope, sentiment: f.sentiment, catalyst: f.catalyst, symbol: f.symbol };
  const chip = (active: boolean) =>
    cn("rounded-full border px-3 py-1 text-xs font-medium", active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Scope">
        {SCOPES.map((s) => (
          <Link key={s} href={`/news${filtersToQuery({ ...base, scope: s })}`} className={chip(f.scope === s)} aria-current={f.scope === s ? "true" : undefined}>{SCOPE_LABELS[s]}</Link>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sentiment and catalyst">
        {SENTIMENT_FILTERS.map((s) => (
          <Link key={s} href={`/news${filtersToQuery({ ...base, sentiment: s })}`} className={chip(f.sentiment === s)} aria-current={f.sentiment === s ? "true" : undefined}>{SENT_FILTER_LABELS[s]}</Link>
        ))}
        <Link href={`/news${filtersToQuery({ ...base, catalyst: !f.catalyst })}`} className={chip(f.catalyst)} aria-pressed={f.catalyst}>Catalysts only</Link>
        <form action="/news" method="get" className="ml-auto flex items-center gap-2">
          {f.scope !== "all" && <input type="hidden" name="scope" value={f.scope} />}
          {f.sentiment !== "all" && <input type="hidden" name="sentiment" value={f.sentiment} />}
          {f.catalyst && <input type="hidden" name="catalyst" value="1" />}
          <input name="symbol" defaultValue={f.symbol ?? ""} placeholder="Symbol" maxLength={12} aria-label="Filter by symbol" className="h-8 w-28 rounded-lg border border-input bg-background px-2.5 text-sm uppercase outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
          <button className="h-8 rounded-lg border px-3 text-xs font-medium hover:bg-muted">Filter</button>
          {f.symbol && <Link href={`/news${filtersToQuery({ ...base, symbol: null })}`} className="text-xs text-muted-foreground underline">Clear</Link>}
        </form>
      </div>
    </div>
  );
}

export function AlertRow({ a, now }: { a: NewsAlert; now: number }) {
  return (
    <li className={cn("space-y-1.5 px-3 py-3 text-sm", !a.read_at && "bg-muted/30")}>
      <div className="flex flex-wrap items-center gap-2">
        {!a.read_at && <Badge tone="warn">New</Badge>}
        <SentimentBadge sentiment={a.sentiment} />
        {a.is_catalyst && <Badge>Catalyst</Badge>}
        {a.scope && <Badge tone="muted">{SCOPE_LABELS[a.scope]}</Badge>}
        {a.symbols.slice(0, 6).map((s) => (
          <Link key={s} href={`/news?symbol=${encodeURIComponent(s)}`} className="rounded border px-1.5 py-0.5 text-xs font-mono hover:bg-muted">{s}</Link>
        ))}
        <span className="ml-auto"><RelevanceMeter score={a.relevance_score} /></span>
      </div>
      <p><Headline title={a.title} url={a.url} /></p>
      {a.body && <p className="text-muted-foreground">{a.body}</p>}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{a.source ?? "unknown source"}</span>
        <span>{relativeTime(a.published_at ?? a.created_at, now)}</span>
        <span className="ml-auto flex gap-2">
          {!a.read_at && (
            <form action={markRead}><input type="hidden" name="id" value={a.id} /><button className="underline">Mark read</button></form>
          )}
          <form action={dismiss}><input type="hidden" name="id" value={a.id} /><button className="underline">Dismiss</button></form>
        </span>
      </div>
    </li>
  );
}

export function CatalystList({ items, now }: { items: Catalyst[]; now: number }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Market catalysts <span className="font-normal text-muted-foreground">· broad-market items, last 3 days</span></h2>
      <ul className="divide-y rounded-lg border text-sm">
        {items.map((c) => (
          <li key={c.id} className="space-y-1 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <SentimentBadge sentiment={c.sentiment} />
              {c.affected_symbols.slice(0, 4).map((s) => <span key={s} className="rounded border px-1.5 py-0.5 text-xs font-mono">{s}</span>)}
              <span className="ml-auto"><RelevanceMeter score={c.relevance / 100} /></span>
            </div>
            <p><Headline title={c.title} url={c.url} /></p>
            {c.why_it_matters && <p className="text-muted-foreground">{c.why_it_matters}</p>}
            <p className="text-xs text-muted-foreground">{c.source} · {relativeTime(c.published_at, now)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
