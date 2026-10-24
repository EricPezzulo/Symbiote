# Symbiote — Build Plan

Multi-user personal finance + market-intelligence app. Stocks and crypto (incl. Trezor cold storage), 24/7 news/catalyst agent, daily briefing, watchlist, thesis builder. Near-free to run.

## Stack
- Hosting decision: hosted Supabase project (no local Docker stack).
- Web: Next.js (App Router, TypeScript, Tailwind, shadcn/ui) → Vercel free tier. Lives in `/web`.
- DB/Auth: Supabase (Postgres, Google OAuth, RLS on every user table, Realtime). Migrations in `/supabase/migrations`.
- Worker: Node/TS service in `/worker` (home box or ~$5 VPS). Websocket price ingest, news polling, Claude Haiku relevance scoring, daily briefing generation, wallet/brokerage sync.
- Secrets never reach the browser; encrypted at rest.

## Data sources
- Stocks realtime: Alpaca free (IEX websocket); fallback Finnhub free.
- Crypto prices: Binance public websocket / CoinGecko.
- News: Finnhub company/market news, CryptoPanic, RSS (Fed, SEC EDGAR, CNBC), economic calendar.
- Fidelity: SnapTrade (free tier = 5 brokerage connections app-wide; track slots used) + Fidelity Positions CSV import fallback.
- Trezor: watch-only. BTC xpub/zpub → derive BIP44/49/84 addresses (gap limit 20) → mempool.space. EVM addresses → Alchemy/Etherscan. Verification: user confirms first derived address matches Trezor Suite; optional signed-message proof. Never store seeds or private keys.

## Data model (all RLS `user_id = auth.uid()` unless noted)
profiles, connections, wallets, accounts, holdings, balance_snapshots, watchlist, prices (global, public read), news_items (global), alerts, briefings, theses, thesis_entries.

## Routes
/login, / (dashboard: balances + daily briefing + top alerts), /holdings, /news, /watchlist, /theses, /theses/[id], /settings/connections.

## Phases
- [x] **1. Foundation**: scaffold `/web` (Next.js+TS+Tailwind+shadcn), Supabase config, schema + RLS migrations, Google auth, app shell/nav with placeholder routes, `.env.example`, README.
- [x] 2. Holdings: manual entry, Fidelity via SnapTrade + CSV fallback, Trezor watch-only (BTC xpub + EVM) with verification, dashboard balances.
- [x] 3. Prices + watchlist: worker websocket ingest → `prices` → Realtime to UI.
- [x] 4. News + alerts pipeline; Claude relevance scoring; `/news`.
- [ ] 5. Daily briefing generation + dashboard card.
- [ ] 6. Thesis builder.
- [ ] 7. Hardening: secret encryption, rate limits, LLM cost caps, tests, deployment.

## Testing
xpub derivation vectors, Fidelity CSV fixtures, RLS cross-user isolation tests, end-to-end manual run (see phase deliverables).

## Open items
Confirm free-tier limits (Alpaca/Finnhub/CoinGecko); SnapTrade 5-connection terms; non-BTC/ETH chains held on Trezor.
