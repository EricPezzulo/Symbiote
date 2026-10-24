-- Row Level Security. The worker uses the service role, which bypasses RLS.

alter table public.profiles enable row level security;
alter table public.connections enable row level security;
alter table public.wallets enable row level security;
alter table public.accounts enable row level security;
alter table public.holdings enable row level security;
alter table public.balance_snapshots enable row level security;
alter table public.watchlist enable row level security;
alter table public.prices enable row level security;
alter table public.news_items enable row level security;
alter table public.alerts enable row level security;
alter table public.briefings enable row level security;
alter table public.theses enable row level security;
alter table public.thesis_entries enable row level security;

-- profiles: own row; created by trigger, so no insert policy.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Global read-only tables (writes only via service role).
create policy prices_select on public.prices for select to authenticated using (true);
create policy news_items_select on public.news_items for select to authenticated using (true);

-- Per-user tables: full CRUD on own rows.
do $$
declare t text;
begin
  foreach t in array array[
    'connections', 'wallets', 'accounts', 'balance_snapshots',
    'watchlist', 'alerts', 'briefings', 'theses'
  ] loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))',
      t || '_own', t);
  end loop;
end $$;

-- holdings: additionally require the parent account to belong to the user,
-- so a row cannot be attached to someone else's account.
create policy holdings_own on public.holdings for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.accounts a
                where a.id = holdings.account_id and a.user_id = (select auth.uid()))
  );

-- thesis_entries: access via parent thesis ownership.
create policy thesis_entries_own on public.thesis_entries for all to authenticated
  using (exists (
    select 1 from public.theses th
    where th.id = thesis_entries.thesis_id and th.user_id = (select auth.uid())))
  with check (exists (
    select 1 from public.theses th
    where th.id = thesis_entries.thesis_id and th.user_id = (select auth.uid())));

-- Defence in depth: the client must never read stored secrets directly.
-- Users manage connections but cannot select the ciphertext column.
revoke select on public.connections from authenticated;
grant select (id, user_id, provider, label, external_user_id, status,
              last_synced_at, last_error, metadata, created_at, updated_at)
  on public.connections to authenticated;
