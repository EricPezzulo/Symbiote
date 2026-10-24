-- Phase 2: holdings, SnapTrade slot accounting, wallet verification challenge.

-- ------------------------------------------------------------------ wallets
-- One-time signed-message challenge (EVM personal_sign proof of ownership).
alter table public.wallets
  add column challenge text,
  add column challenge_expires_at timestamptz;

-- A wallet owns at most one backing account.
create unique index accounts_wallet_unique on public.accounts (wallet_id) where wallet_id is not null;

-- Imports match accounts by (connection, external id).
create unique index accounts_connection_external_unique
  on public.accounts (user_id, connection_id, external_id)
  where connection_id is not null and external_id is not null;

-- ---------------------------------------------------------- snaptrade slots
-- One connections row per SnapTrade brokerage authorization. The registration
-- row (before any brokerage is linked) has no authorization_id and does not
-- consume a slot.
create unique index connections_snaptrade_auth_unique
  on public.connections (user_id, (metadata ->> 'authorization_id'))
  where provider = 'snaptrade' and metadata ->> 'authorization_id' is not null;

-- App-wide count of active SnapTrade brokerage connections (free tier cap = 5).
-- SECURITY DEFINER so any signed-in user can see the aggregate without being
-- able to read other users' rows; it returns a single integer, nothing else.
create function public.snaptrade_slots_used() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer
  from public.connections
  where provider = 'snaptrade'
    and status = 'active'
    and metadata ->> 'authorization_id' is not null
$$;
revoke all on function public.snaptrade_slots_used() from public, anon;
grant execute on function public.snaptrade_slots_used() to authenticated;
