# Symbiote

Personal finance and market-intelligence app. See [PLAN.md](PLAN.md) for the roadmap.

- `web/` Next.js (App Router, TypeScript, Tailwind, shadcn/ui)
- `supabase/` migrations and tests (applied to the hosted project with `supabase db push`)
- `worker/` Node/TS service: price ingest (Phase 3), news + Claude scoring + alerts (Phase 4); briefings and wallet sync later

## Setup (hosted Supabase)

Symbiote runs against a **hosted Supabase project**; the local `supabase start` stack (Docker) is not used.

Prerequisites: Node 20+, a free [Supabase](https://supabase.com) account.

### 1. Create the Supabase project

1. In the Supabase dashboard click **New project**, pick a region and a database password (save it).
2. Open **Project Settings > API** and copy:
   - **Project URL** -> `NEXT_PUBLIC_SUPABASE_URL`
   - **anon / public key** -> `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role key** -> `SUPABASE_SERVICE_ROLE_KEY` (secret; server-only, bypasses RLS)
3. Your project ref is the `xxxx` in `https://xxxx.supabase.co`.

### 2. Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an OAuth client ID of type "Web application" (configure the consent screen first).
2. Add this Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. In the Supabase dashboard go to **Authentication > Providers > Google**, enable it and paste the client ID and secret.
4. Go to **Authentication > URL Configuration**: set **Site URL** to `http://127.0.0.1:3000` for development (your Vercel URL in production) and add these **Redirect URLs**: `http://127.0.0.1:3000/auth/callback`, `http://localhost:3000/auth/callback` and `https://<your-domain>/auth/callback`.

### 3. Apply the database migrations

```sh
npx supabase login                          # one-time, opens a browser
npx supabase link --project-ref <project-ref>   # asks for the database password
npx supabase db push                        # applies supabase/migrations/*.sql
```

`db push` only applies migrations; auth provider settings live in the dashboard (step 2), not in `supabase/config.toml`. Re-run `db push` whenever new migrations are added.

### 4. Environment

```sh
cp .env.example web/.env.local
openssl rand -base64 32     # paste as ENCRYPTION_KEY
```

Fill in the Supabase values from step 1. SnapTrade, Alchemy and the other optional keys can stay blank; the related UI shows a friendly "not configured" state.

### 5. Web app

```sh
cd web
npm install
npm run dev              # http://127.0.0.1:3000
```

Open http://127.0.0.1:3000 (use `127.0.0.1`, matching the Site URL above) and sign in with Google.

## Connections (Phase 2)

All under **Connections** in the app.

- **Manual**: `/holdings` lets you create accounts and add/edit/delete holdings.
- **Fidelity CSV** (works with no extra keys): in Fidelity, Positions > download (CSV), then upload on Connections. You get a preview before anything is saved. Re-importing replaces previously imported (CSV) holdings in the same accounts.
- **SnapTrade** (live brokerage sync): create a SnapTrade account at https://snaptrade.com, then set `SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY`, plus `ENCRYPTION_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. The free tier allows 5 brokerage connections across the whole app; the UI shows "N of 5 slots used" and blocks new links at 5 (use the CSV import instead). The SnapTrade user secret is stored AES-256-GCM encrypted in `connections.secret_encrypted` and is only ever read by server code using the service-role client. The portal redirects back to `<site>/snaptrade/callback`; set `NEXT_PUBLIC_SITE_URL` if the app sits behind a proxy.
- **Trezor / wallets (watch-only)**: add a Bitcoin xpub/ypub/zpub (BIP44/49/84, gap limit 20, balances from mempool.space) or an EVM address (ETH + ERC-20 balances via Alchemy, `ALCHEMY_API_KEY`). **Never enter a seed phrase or private key**; the app rejects them. A wallet stays "watch-only, unverified" until you either confirm the first address matches Trezor Suite, or (EVM) sign a one-time challenge with `personal_sign`. Use **Refresh balances** to sync; the worker will automate this in a later phase.
  - TODO: signed-message proof for Bitcoin (BIP137/322) is not implemented; BTC wallets use the address-match check only.

## Prices + watchlist (Phase 3)

Live prices flow: **worker** (websocket/REST providers) -> `prices` table (service role) -> **Supabase Realtime** -> `/watchlist`, `/holdings` and the dashboard. `lib/valuation.ts` values holdings from `prices`; until a symbol has a row the UI keeps showing "Price pending".

### 1. Apply the new migration

```sh
npx supabase db push     # adds 20260201000000_phase3_prices.sql
```

It adds `prices.prev_close`, the `price_history` daily table (authenticated read), the watchlist alert columns (`alert_above`, `alert_below`, `*_fired_at`), and adds `prices` to the `supabase_realtime` publication. Without it the web app still works (it degrades to price-only queries) but the watchlist alert fields and live updates will not.

### 2. Run the worker

```sh
cd worker
cp .env.example .env     # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and provider keys
npm install
npm run dev              # tsx watch; or: npm run build && npm start
npm test
```

Deploy options in `worker/deploy/`: a `Dockerfile` (`docker build -t symbiote-worker worker/`, run with `--env-file worker/.env --restart unless-stopped`) and an example systemd unit `symbiote-worker.service`. The worker logs one JSON line per event (never secrets) and a `health` line every 60s (providers, symbol counts, ticks, rows written). It shuts down cleanly on SIGINT/SIGTERM and flushes pending writes.

What it does: every 60s it reads the union of symbols across all users' `holdings` and `watchlist` (service role), splits them into stocks (`stock`/`etf`) and crypto, and subscribes/unsubscribes providers by diff. Ticks are coalesced to at most one `prices` upsert per symbol per ~2s (batched), `price_history` gets one OHLC row per symbol per UTC day, and watchlist targets raise a row in `alerts` (`kind='price'`) once per crossing with a cooldown (default 6h; re-armed when you edit the target).

Environment variables (see `worker/.env.example` for all tunables):

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | yes | Same project as the web app. The service-role key bypasses RLS: keep it on the worker/server only. |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | for stocks | Alpaca market-data keys (free account). |
| `FINNHUB_API_KEY` | optional | Stock fallback used only when Alpaca keys are absent (or `STOCK_PROVIDER=finnhub`). |
| `CRYPTO_PROVIDER` | optional | `binance` (default) or `coingecko`. |
| `BINANCE_WS_URL` | optional | Default `wss://stream.binance.com:9443`; use `wss://stream.binance.us:9443` from the US if binance.com is blocked. |
| `COINGECKO_API_KEY`, `COINGECKO_IDS` | optional | Demo key; extra `SYMBOL:coin-id` mappings for coins not in the built-in list. |

### Provider notes (checked against the vendors' docs on 2026-10-24)

- **Alpaca** ([streaming docs](https://docs.alpaca.markets/docs/real-time-stock-pricing-data), [plans](https://docs.alpaca.markets/docs/about-market-data-api)): free Basic plan uses the **IEX** feed only (`wss://stream.data.alpaca.markets/v2/iex`), **30 websocket symbols**, and one connection (extra sessions get error 406; the worker backs off 30s). Beyond 30 symbols (or on a 405 "symbol limit exceeded") the worker streams the first 30 and polls the rest from the REST snapshots endpoint every `OVERFLOW_POLL_MS` (200 REST calls/min on the free plan). Snapshots also provide the previous close and previous daily bar. IEX is a small share of market volume, so last-trade prices can differ slightly from consolidated quotes and be quiet on thin names. Auth is `{"action":"auth","key","secret"}`; a 402 stops the provider instead of retrying.
- **Binance** ([ws streams docs](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)): combined stream `wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/...`; miniTicker updates every 1000ms with a rolling 24h window (so "change" for crypto is rolling 24h, not since UTC midnight). Spot limits: 1024 streams and 5 control messages/second per connection (the worker batches and paces SUBSCRIBE). binance.com can return HTTP 451 to US IPs; the worker logs a hint. **Not verified:** the `stream.binance.us:9443` endpoint and its limits were not confirmed from Binance.US docs; check them before relying on it, or use `CRYPTO_PROVIDER=coingecko`.
- **CoinGecko** ([simple/price](https://docs.coingecko.com/reference/simple-price)): REST polling fallback. The Demo plan is about 30 calls/min and 10k calls/month per CoinGecko's pricing/limits pages (varies with traffic); one request per poll every `COINGECKO_POLL_MS` (default 300000 = 5 min, about 8.6k calls/month; polling every 60s would be about 43k/month and exceed the 10k monthly Demo credits). The Demo key header is `x-cg-demo-api-key`; the base URL is `https://api.coingecko.com/api/v3`. The worker backs off on HTTP 429.
- **Finnhub**: stock websocket `wss://ws.finnhub.io?token=...` with `{"type":"subscribe","symbol":"AAPL"}` and `{"type":"trade","data":[{s,p,t,v}]}` frames, plus `/quote` for the previous close. **Not verified** against current docs in this build (the docs page did not render for the fetch tool): the free-tier symbol cap (commonly cited as 50) and REST limit (about 60 calls/min per third-party summaries). Treat the fallback as best effort and confirm limits at https://finnhub.io/docs/api/websocket-trades.

Known limits: `prices` is keyed by symbol only, so a stock and a crypto sharing a ticker would collide. Stablecoin holdings (USDC, USDT) are priced only if the crypto provider lists them. Exchange holidays are not reflected in the "market open" hint.

## News + alerts (Phase 4)

Flow: **worker sources** (RSS/Atom, Finnhub, EDGAR, optional CryptoPanic) -> normalize + dedupe -> `news_items` (global) -> local **pre-filter** -> **Claude Haiku** structured scoring -> `news_scores` (global, symbol-agnostic) -> per-user **alerts** (`alerts.kind='news'`) -> `/news` and the dashboard's Recent alerts.

### 1. Apply the migration and run the worker

```sh
npx supabase db push     # adds 20260301000000_phase4_news.sql (additive, idempotent)
cd worker && npm install && npm run dev
```

The migration adds to `news_items` (`url_hash` unique, `title_hash`, `category`, `fetched_at`, `score_status`, `score_attempts`; the existing `symbols text[]` with its GIN index is the ticker array), and creates `news_scores`, `news_usage` (daily spend ledger, no client access), `calendar_events` (Phase 5 will read it), plus `alerts` columns (`sentiment`, `is_catalyst`, `symbols`, `scope`, `dismissed_at`) and a unique `(user_id, news_item_id)` index for idempotent alerts. RLS: global tables are authenticated read-only with client writes revoked; alerts stay owner-only. pgTAP tests: `supabase/tests/news.test.sql` (run it in the SQL editor if you have no local Docker).

The news pipeline starts with the worker and is isolated from price ingest (a failure there never stops prices). Disable with `NEWS_ENABLED=false`. Without the migration the web app shows a "run db push" message on `/news`.

### 2. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | for scoring/alerts | Without it items are stored but never scored, so no news alerts. |
| `NEWS_CONTACT_EMAIL` | recommended | Goes into the User-Agent; SEC EDGAR requires contact info. |
| `FINNHUB_API_KEY` | optional | Enables Finnhub company news (per held/watched stock), general market news and the earnings calendar. |
| `CRYPTOPANIC_API_KEY`, `CRYPTOPANIC_API_URL` | optional | See caveat below. |
| `NEWS_SCORING_MODEL` | no | Default `claude-haiku-5-5`. |
| `NEWS_DAILY_TOKEN_BUDGET` | no | Default 500000 tokens/UTC day (input+output+cache). Scoring stops when the next batch would exceed it; items stay stored and unscored. |
| `NEWS_MAX_BATCH` | no | Default 20 items per request. |
| `NEWS_ALERT_THRESHOLD` / `NEWS_MACRO_ALERT_THRESHOLD` | no | Default 60 / 80. |
| `NEWS_MAX_ALERTS_PER_USER_PER_DAY` | no | Default 20 (UTC day). |

Other tunables are listed in `worker/.env.example`.

### 3. How it works

- **Sources** (`worker/src/news/sources/`), each with its own interval, timeout, retry/backoff (honours `Retry-After`) and ETag/If-Modified-Since where the server provides them. A failing source backs off exponentially (max 1h) without affecting others. Dedupe is by canonical URL hash (tracking params, fragments, `www`, scheme normalized) and by normalized-title hash (3-day window), both in-batch and against the DB.
- **Entity mapping** (`entities.ts`): source-provided tickers, `$cashtags`, `NASDAQ: ARM` style prefixes, bare uppercase tickers and a symbol/name alias table, matched on word boundaries. Ambiguous tickers (`ARM`, `ALL`, `V`, `LINK`, ...) and short ones never match as bare words; they need a cashtag, an exchange prefix or a company-name alias. ALL-CAPS headlines are not bare-matched. Holdings carry no company-name column, so extra aliases come only from the built-in table (extend `DEFAULT_ALIASES`).
- **Scoring** (`score.ts`): the pre-filter (symbol match, high-priority source such as the Fed or EDGAR, or macro/crypto keyword) decides candidates; rejected items are marked `skipped`. Candidates are sent in batches of <= 20 with a strict JSON schema (`output_config.format`) and low effort. Article text is passed as JSON data inside `<articles>` with `<` escaped, the system prompt tells the model it is untrusted, outputs are validated and clipped with zod (relevance clamped, enums enforced, symbols pattern-checked, `why_it_matters` stripped of markup/URLs and cut to 280 chars) and, for company/crypto items, `affected_symbols` is intersected with the symbols the deterministic matcher found in the text. Only headline, clipped summary, source, category and matched symbols reach Claude: no user ids, holdings, quantities or balances. An item is scored once (`score_status`); unparseable results retry up to 3 times, then are marked `failed`.
- **Alerts** (`alerts.ts`): per user, an alert is created when a scored item affects one of their holdings/watchlist symbols at relevance >= threshold (scope `holding` or `watchlist`), or is a macro/market catalyst at relevance >= macro threshold (scope `market`, everyone with holdings or a watchlist). Inserts are idempotent via the unique `(user_id, news_item_id)` index; a daily cap per user keeps the highest relevance first. Per-user symbol sets are read only by the worker with the service-role key and never leave it.
- **Web**: `/news` shows the user's news alerts (filters: scope, sentiment, catalyst-only, symbol; cursor pagination; mark read / mark all read / dismiss) and a "Market catalysts" section from global scores. All feed/model text is rendered as escaped text, links are only emitted for http(s) URLs with `rel="noopener noreferrer"`, and server actions authenticate and filter by `user_id` through RLS. The page refreshes itself every 60s (no Realtime).

### 4. Cost estimate (Claude Haiku 5.5)

Haiku 5.5 is $0.10 / $0.50 per million input / output tokens (prompts up to 100K; from the claude-api skill's pricing table dated 2026-10-06, so re-check the Anthropic pricing page). A batch of 20 items is roughly 3.7K input tokens (about 600 of them the static system prompt) and 1.2-1.5K output tokens: about $0.0011 per batch, or $0.00006 per item. At ~300 candidate items/day that is ~15 requests, about $0.02/day, **roughly $0.50/month**. The default `NEWS_DAILY_TOKEN_BUDGET=500000` caps the worst case at about **$3.30/month** (assuming a 70/30 input/output mix). The system prompt is marked for prompt caching but is likely below the model's minimum cacheable prefix, so expect no cache hits; this is harmless. Every call logs input/output/cache tokens, and `news_usage` holds the daily totals (`select * from news_usage order by day desc`). These are estimates, not measurements: no API key was available when this was built.

### 5. Sources and terms-of-use caveats (reachable 2026-10-24 unless noted)

| Source | Status | Caveat |
| --- | --- | --- |
| Federal Reserve press releases `federalreserve.gov/feeds/press_all.xml` | live (RSS 2.0) | US government content; only titles/summaries stored. |
| SEC EDGAR 8-K Atom (per held ticker) | live | SEC fair-access policy: <= 10 requests/s and a User-Agent with contact info (set `NEWS_CONTACT_EMAIL`). The worker paces ~4/s. |
| CNBC top news RSS | live | CNBC's terms restrict its RSS to personal, non-commercial use and forbid republishing (not re-verified here). Symbiote stores a headline, a short summary and a link, shown only to signed-in users. Do not redistribute. |
| MarketWatch top stories (Dow Jones feed host) | live (old URL redirects) | Same personal-use caveat. Remove it from `defaultRssSources` if you prefer. |
| CoinDesk, Cointelegraph, The Block RSS | live | Headline syndication; no full text fetched. Check each site's terms before any commercial use. |
| Reuters | skipped | No public RSS any more. |
| Finnhub (company news, general news, earnings calendar) | needs key | Free tier is ~60 calls/min (per third-party summaries; Finnhub's rate-limit page did not render for the fetch tool) and for personal use. The worker spaces calls 1.1s apart and rotates at most 40 tickers per 15 min. Free availability of the earnings-calendar endpoint is **unverified**; the **economic calendar is reported as premium-only**, so `EconomicCalendarStub` returns nothing (Phase 5 should plug in another provider). |
| CryptoPanic | optional, **unverified** | Docs could not be fetched. An unauthenticated probe showed the API paths are now `/api/{growth,growth_weekly,enterprise}/v2/posts/`, so a free key may not work at all. URL is configurable; the parser is defensive. Leave unset to disable. |

Only feed-provided text is ever stored; article pages are never fetched.

### Not verified live

No Supabase project, Anthropic key, Finnhub key or CryptoPanic key was available while building. Verified by unit tests (feed fixtures, canonicalization, matcher, pre-filter, mocked-Claude scoring incl. malformed output / budget / injection text, alert planning and idempotency, HTTP retry/conditional GET, web filter/cursor helpers), `tsc`, `next build` and `eslint`. The migration SQL, the PostgREST embeds/filters, the structured-output request against the live API and the pgTAP file have not been executed.

## Tests

Unit tests (vitest: crypto, Fidelity CSV, BTC derivation vs BIP84 vectors, Esplora/Alchemy mocks, valuation):

```sh
cd web && npm test
cd worker && npm test      # news pipeline (Phase 4), symbol mapping, universe diffs, writer throttling, alert crossings, provider protocols against a mock ws server
```

RLS isolation (pgTAP; user A cannot read or write user B's rows). `supabase test db` needs a local Docker database, so on a hosted-only setup run `supabase/tests/rls.test.sql` manually in the dashboard SQL editor, or skip it.

## Production notes

Set all variables from `.env.example` in Vercel (mark `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `SNAPTRADE_CONSUMER_KEY` and `ALCHEMY_API_KEY` as server-only; never `NEXT_PUBLIC_`), set `NEXT_PUBLIC_SITE_URL`, and add your site URL and `/auth/callback` to the Supabase redirect allow-list.
