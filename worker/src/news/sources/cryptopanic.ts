import type { Http } from "../http.js";
import type { NewsSource, PollContext, RawNewsItem } from "../types.js";

type CpPost = { title?: string; description?: string; published_at?: string; created_at?: string; url?: string; original_url?: string; slug?: string; id?: number | string; instruments?: { code?: string }[]; currencies?: { code?: string }[]; source?: { title?: string } };

/**
 * CryptoPanic posts. Optional (needs CRYPTOPANIC_API_KEY). UNVERIFIED: the public docs could not be fetched in this build;
 * an unauthenticated probe showed valid paths are /api/{growth|growth_weekly|enterprise}/v2/posts/, so whether a free key
 * works there is unknown. The URL is configurable (CRYPTOPANIC_API_URL) and the parser is defensive. Their API terms
 * generally require attribution and forbid redistribution; we store only headline + link.
 */
export class CryptoPanicSource implements NewsSource {
  readonly name = "cryptopanic";
  readonly category = "crypto" as const;
  readonly timeoutMs = 15_000;

  constructor(private readonly http: Http, private readonly apiKey: string | undefined, private readonly baseUrl: string, readonly intervalMs = 10 * 60_000) {}

  enabled() {
    return Boolean(this.apiKey);
  }

  async poll(_ctx: PollContext): Promise<RawNewsItem[]> {
    const u = new URL(this.baseUrl);
    u.searchParams.set("auth_token", this.apiKey!);
    u.searchParams.set("public", "true");
    const res = await this.http.get(u.toString(), { timeoutMs: this.timeoutMs, maxBytes: 3_000_000, key: this.baseUrl });
    if (res.notModified) return [];
    return mapCryptoPanic(JSON.parse(res.body));
  }
}

export function mapCryptoPanic(json: unknown): RawNewsItem[] {
  const results = (json as { results?: CpPost[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: RawNewsItem[] = [];
  for (const p of results) {
    const url = p.original_url ?? p.url;
    if (typeof p.title !== "string" || typeof url !== "string") continue;
    const codes = [...(p.instruments ?? []), ...(p.currencies ?? [])].map((c) => c.code?.toUpperCase()).filter((c): c is string => Boolean(c));
    out.push({
      source: "cryptopanic",
      externalId: p.id !== undefined ? `cp:${p.id}` : null,
      url,
      title: p.title,
      summary: p.description ?? null,
      publishedAt: p.published_at ?? p.created_at ?? null,
      category: "crypto",
      symbols: codes,
    });
  }
  return out;
}
