-- Phase 4: news ingestion, Claude relevance scores, news alerts, calendar. Additive and idempotent.
-- Existing news_items.symbols (text[], GIN-indexed) is used as the ticker array; no duplicate "tickers" column.

-- ---------------------------------------------------------------- news_items
alter table public.news_items
  add column if not exists url_hash text,
  add column if not exists title_hash text,
  add column if not exists category text,
  add column if not exists fetched_at timestamptz,
  add column if not exists score_status text not null default 'pending',
  add column if not exists score_attempts smallint not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'news_items_category_check') then
    alter table public.news_items add constraint news_items_category_check
      check (category is null or category in ('company', 'market', 'crypto', 'macro'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'news_items_score_status_check') then
    alter table public.news_items add constraint news_items_score_status_check
      check (score_status in ('pending', 'scored', 'skipped', 'failed'));
  end if;
end $$;

-- Unique (non-partial so PostgREST upsert can target it); NULLs stay distinct for any legacy rows.
create unique index if not exists news_items_url_hash_key on public.news_items (url_hash);
create index if not exists news_items_title_hash_idx on public.news_items (title_hash, created_at desc);
create index if not exists news_items_category_published_idx on public.news_items (category, published_at desc);
create index if not exists news_items_pending_idx on public.news_items (published_at desc) where score_status = 'pending';

-- --------------------------------------------------------------- news_scores
-- Global, symbol-agnostic scores (one per item, never rescored). Per-user relevance is derived in the worker/UI
-- by joining against the user's holdings/watchlist.
create table if not exists public.news_scores (
  news_item_id uuid primary key references public.news_items (id) on delete cascade,
  relevance smallint not null check (relevance between 0 and 100),
  sentiment text not null check (sentiment in ('positive', 'negative', 'neutral', 'mixed')),
  impact_horizon text not null check (impact_horizon in ('intraday', 'days', 'weeks', 'long_term')),
  is_catalyst boolean not null default false,
  affected_symbols text[] not null default '{}',
  why_it_matters text not null default '',
  model text not null,
  input_tokens integer,
  output_tokens integer,
  scored_at timestamptz not null default now()
);
create index if not exists news_scores_scored_idx on public.news_scores (scored_at desc);
create index if not exists news_scores_catalyst_idx on public.news_scores (relevance desc, scored_at desc) where is_catalyst;
create index if not exists news_scores_symbols_idx on public.news_scores using gin (affected_symbols);

-- --------------------------------------------------------------- news_usage
-- Daily Claude spend ledger (UTC day). Internal: RLS on, no client policies.
create table if not exists public.news_usage (
  day date primary key,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  requests integer not null default 0,
  items_scored integer not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.news_usage_add(
  p_day date, p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint, p_requests integer, p_items integer
) returns void
language sql security definer set search_path = '' as $$
  insert into public.news_usage as u (day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests, items_scored)
  values (p_day, p_input, p_output, p_cache_read, p_cache_write, p_requests, p_items)
  on conflict (day) do update set
    input_tokens = u.input_tokens + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    cache_read_tokens = u.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = u.cache_write_tokens + excluded.cache_write_tokens,
    requests = u.requests + excluded.requests,
    items_scored = u.items_scored + excluded.items_scored,
    updated_at = now()
$$;
revoke all on function public.news_usage_add(date, bigint, bigint, bigint, bigint, integer, integer) from public, anon, authenticated;

-- ----------------------------------------------------------- calendar_events
create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  unique_key text not null unique,
  kind text not null check (kind in ('earnings', 'economic')),
  symbol text,
  title text not null,
  event_at timestamptz not null,
  country text,
  importance smallint check (importance is null or importance between 1 and 3),
  details jsonb not null default '{}'::jsonb,
  source text not null,
  fetched_at timestamptz not null default now()
);
create index if not exists calendar_events_time_idx on public.calendar_events (event_at);
create index if not exists calendar_events_symbol_idx on public.calendar_events (symbol, event_at);

-- -------------------------------------------------------------------- alerts
alter table public.alerts
  add column if not exists sentiment text,
  add column if not exists is_catalyst boolean not null default false,
  add column if not exists symbols text[] not null default '{}',
  add column if not exists scope text,
  add column if not exists dismissed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alerts_scope_check') then
    alter table public.alerts add constraint alerts_scope_check check (scope is null or scope in ('holding', 'watchlist', 'market'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alerts_sentiment_check') then
    alter table public.alerts add constraint alerts_sentiment_check
      check (sentiment is null or sentiment in ('positive', 'negative', 'neutral', 'mixed'));
  end if;
end $$;

-- Idempotency: at most one alert per (user, news item). Price alerts have a NULL news_item_id and are unaffected.
create unique index if not exists alerts_user_news_unique on public.alerts (user_id, news_item_id);
create index if not exists alerts_user_kind_time_idx on public.alerts (user_id, kind, created_at desc, id desc);

-- ----------------------------------------------------------------------- RLS
alter table public.news_scores enable row level security;
alter table public.news_usage enable row level security;
alter table public.calendar_events enable row level security;

drop policy if exists news_scores_select on public.news_scores;
create policy news_scores_select on public.news_scores for select to authenticated using (true);
drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events for select to authenticated using (true);
-- news_usage: no policy => no client access at all.

-- Defence in depth: global tables are read-only for clients (service role bypasses these).
revoke insert, update, delete on public.news_scores, public.calendar_events, public.news_items from anon, authenticated;
revoke all on public.news_usage from anon, authenticated;
