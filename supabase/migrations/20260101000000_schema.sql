-- Symbiote core schema. RLS is enabled in the next migration.

create extension if not exists pgcrypto;

-- Shared trigger to maintain updated_at.
create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile when a user signs up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------- connections
-- External data sources (SnapTrade brokerage, CSV import, etc).
-- secret_encrypted holds ciphertext only; encryption happens in the worker/server.
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('snaptrade', 'csv', 'manual', 'alchemy', 'etherscan', 'mempool')),
  label text,
  external_user_id text,
  secret_encrypted text,
  status text not null default 'active' check (status in ('active', 'error', 'disabled')),
  last_synced_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index connections_user_idx on public.connections (user_id);
create trigger connections_updated_at before update on public.connections
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------- wallets
-- Watch-only crypto wallets (e.g. Trezor). Never store seeds or private keys.
create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  connection_id uuid references public.connections (id) on delete set null,
  label text not null,
  chain text not null check (chain in ('btc', 'evm')),
  kind text not null check (kind in ('xpub', 'address')),
  public_key text not null,               -- xpub/zpub or address (public data)
  script_type text check (script_type in ('p2pkh', 'p2sh-p2wpkh', 'p2wpkh')),
  first_address text,                     -- shown to user to verify against Trezor Suite
  verified_at timestamptz,
  verification_method text check (verification_method in ('address_match', 'signed_message')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, chain, public_key)
);
create index wallets_user_idx on public.wallets (user_id);
create trigger wallets_updated_at before update on public.wallets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- accounts
-- A brokerage account, manual account, or wallet-backed account.
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  connection_id uuid references public.connections (id) on delete set null,
  wallet_id uuid references public.wallets (id) on delete cascade,
  name text not null,
  type text not null check (type in ('brokerage', 'crypto_wallet', 'exchange', 'bank', 'manual')),
  institution text,
  external_id text,
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index accounts_user_idx on public.accounts (user_id);
create index accounts_connection_idx on public.accounts (connection_id);
create index accounts_wallet_idx on public.accounts (wallet_id);
create trigger accounts_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- holdings
create table public.holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  symbol text not null,
  asset_type text not null check (asset_type in ('stock', 'etf', 'crypto', 'cash', 'other')),
  quantity numeric(38, 18) not null,
  cost_basis numeric(20, 4),             -- total cost, account currency
  source text not null default 'manual' check (source in ('manual', 'snaptrade', 'csv', 'wallet')),
  as_of timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, symbol)
);
create index holdings_user_idx on public.holdings (user_id);
create index holdings_symbol_idx on public.holdings (symbol);
create trigger holdings_updated_at before update on public.holdings
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------- balance_snapshots
create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete cascade,  -- null = total across accounts
  total_value numeric(20, 4) not null,
  currency text not null default 'USD',
  captured_at timestamptz not null default now()
);
create index balance_snapshots_user_time_idx on public.balance_snapshots (user_id, captured_at desc);
create index balance_snapshots_account_idx on public.balance_snapshots (account_id);

-- --------------------------------------------------------------- watchlist
create table public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  symbol text not null,
  asset_type text not null check (asset_type in ('stock', 'etf', 'crypto')),
  notes text,
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);

-- ------------------------------------------------------------------ prices
-- Global latest price per symbol (written by the worker with the service role).
create table public.prices (
  symbol text primary key,
  asset_type text not null check (asset_type in ('stock', 'etf', 'crypto')),
  price numeric(28, 10) not null,
  change_24h_pct numeric(12, 6),
  volume_24h numeric(28, 4),
  source text,
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------- news_items
-- Global news; per-user relevance lives in alerts.
create table public.news_items (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text,
  url text not null,
  title text not null,
  summary text,
  symbols text[] not null default '{}',
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (url)
);
create index news_items_published_idx on public.news_items (published_at desc);
create index news_items_symbols_idx on public.news_items using gin (symbols);

-- ------------------------------------------------------------------ alerts
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  news_item_id uuid references public.news_items (id) on delete cascade,
  symbol text,
  kind text not null check (kind in ('news', 'price', 'catalyst')),
  severity smallint not null default 1 check (severity between 1 and 5),
  relevance_score numeric(4, 3) check (relevance_score between 0 and 1),
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index alerts_user_time_idx on public.alerts (user_id, created_at desc);
create index alerts_news_idx on public.alerts (news_item_id);

-- --------------------------------------------------------------- briefings
create table public.briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  briefing_date date not null,
  content_md text not null,
  model text,
  created_at timestamptz not null default now(),
  unique (user_id, briefing_date)
);

-- ------------------------------------------------------------------ theses
create table public.theses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  symbol text,
  stance text not null default 'neutral' check (stance in ('bullish', 'bearish', 'neutral')),
  summary text,
  status text not null default 'active' check (status in ('draft', 'active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index theses_user_idx on public.theses (user_id);
create trigger theses_updated_at before update on public.theses
  for each row execute function public.set_updated_at();

create table public.thesis_entries (
  id uuid primary key default gen_random_uuid(),
  thesis_id uuid not null references public.theses (id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'evidence', 'risk', 'catalyst', 'update')),
  content text not null,
  news_item_id uuid references public.news_items (id) on delete set null,
  created_at timestamptz not null default now()
);
create index thesis_entries_thesis_idx on public.thesis_entries (thesis_id, created_at);
