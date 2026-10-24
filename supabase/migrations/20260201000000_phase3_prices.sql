-- Phase 3: live prices, daily history, watchlist price targets. Additive and idempotent.

-- ------------------------------------------------------------------ prices
-- Existing columns: symbol, asset_type, price, change_24h_pct, volume_24h, source, updated_at.
-- change_24h_pct holds day change vs prev_close for stocks and the rolling 24h change for crypto.
alter table public.prices
  add column if not exists prev_close numeric(28, 10);

-- Keep updated_at honest on direct writes (the worker also sets it from the tick time).
-- (No trigger: the worker writes the event time, which can legitimately be older than now().)

-- RLS is already enabled with prices_select (authenticated, using true). Re-assert idempotently.
alter table public.prices enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'prices' and policyname = 'prices_select'
  ) then
    create policy prices_select on public.prices for select to authenticated using (true);
  end if;
end $$;

-- Realtime: stream price changes to signed-in browsers.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'prices'
     ) then
    alter publication supabase_realtime add table public.prices;
  end if;
end $$;

-- ----------------------------------------------------------- price_history
-- One row per symbol per UTC day (written by the worker with the service role).
create table if not exists public.price_history (
  symbol text not null,
  day date not null,
  open numeric(28, 10) not null,
  high numeric(28, 10) not null,
  low numeric(28, 10) not null,
  close numeric(28, 10) not null,
  volume numeric(28, 4),
  source text,
  created_at timestamptz not null default now(),
  primary key (symbol, day)
);
create index if not exists price_history_day_idx on public.price_history (day desc);

alter table public.price_history enable row level security;
drop policy if exists price_history_select on public.price_history;
create policy price_history_select on public.price_history for select to authenticated using (true);

-- --------------------------------------------------------------- watchlist
-- Optional target alerts. *_fired_at records the last time the worker raised an alert for the
-- target (cooldown + idempotency); the web app clears it when the user edits a target.
alter table public.watchlist
  add column if not exists alert_above numeric(28, 10),
  add column if not exists alert_below numeric(28, 10),
  add column if not exists alert_above_fired_at timestamptz,
  add column if not exists alert_below_fired_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'watchlist_alert_above_positive') then
    alter table public.watchlist add constraint watchlist_alert_above_positive check (alert_above is null or alert_above > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'watchlist_alert_below_positive') then
    alter table public.watchlist add constraint watchlist_alert_below_positive check (alert_below is null or alert_below > 0);
  end if;
end $$;
