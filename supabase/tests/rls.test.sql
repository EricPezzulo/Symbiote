-- RLS isolation test (pgTAP). Run with: npx supabase test db
begin;
select plan(15);

-- Two users; the on_auth_user_created trigger creates their profiles.
insert into auth.users (id, instance_id, aud, role, email)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.com');

select is((select count(*)::int from public.profiles), 2, 'profile auto-created for each user');

-- Seed B's data as superuser.
insert into public.connections (id, user_id, provider, secret_encrypted)
  values ('bbbbbbbb-1000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'snaptrade', 'ciphertext-b');
insert into public.accounts (id, user_id, name, type)
  values ('bbbbbbbb-2000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'B brokerage', 'brokerage');
insert into public.holdings (user_id, account_id, symbol, asset_type, quantity)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-2000-0000-0000-000000000001', 'AAPL', 'stock', 10);
insert into public.watchlist (user_id, symbol, asset_type)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'NVDA', 'stock');
insert into public.theses (id, user_id, title)
  values ('bbbbbbbb-3000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'B thesis');
insert into public.thesis_entries (thesis_id, content)
  values ('bbbbbbbb-3000-0000-0000-000000000001', 'B private note');
insert into public.prices (symbol, asset_type, price) values ('AAPL', 'stock', 100);
insert into public.news_items (source, url, title, published_at)
  values ('test', 'https://example.com/n', 'headline', now());

-- Act as user A.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
-- Older auth.uid() definitions read this per-claim setting instead.
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);

select is((select count(*)::int from public.profiles), 1, 'A sees only own profile');
select is((select count(*)::int from public.accounts), 0, 'A cannot read B accounts');
select is((select count(*)::int from public.holdings), 0, 'A cannot read B holdings');
select is((select count(*)::int from public.watchlist), 0, 'A cannot read B watchlist');
select is((select count(*)::int from public.theses), 0, 'A cannot read B theses');
select is((select count(*)::int from public.thesis_entries), 0, 'A cannot read B thesis entries');
select is((select count(*)::int from public.connections), 0, 'A cannot read B connections');

-- Positive control: A can create and read own rows (so the zeros above are meaningful).
insert into public.watchlist (user_id, symbol, asset_type)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'MSFT', 'stock');
select is((select count(*)::int from public.watchlist), 1, 'A sees own watchlist row only');

-- Global tables are readable.
select is((select count(*)::int from public.prices), 1, 'A can read global prices');
select is((select count(*)::int from public.news_items), 1, 'A can read global news');

-- Writes into B's space are rejected.
select throws_ok(
  $$insert into public.watchlist (user_id, symbol, asset_type)
    values ('bbbbbbbb-0000-0000-0000-000000000002', 'TSLA', 'stock')$$,
  '42501', null, 'A cannot insert a row owned by B');
select throws_ok(
  $$insert into public.thesis_entries (thesis_id, content)
    values ('bbbbbbbb-3000-0000-0000-000000000001', 'injected')$$,
  '42501', null, 'A cannot add entries to B thesis');
select throws_ok(
  $$insert into public.holdings (user_id, account_id, symbol, asset_type, quantity)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-2000-0000-0000-000000000001', 'X', 'stock', 1)$$,
  '42501', null, 'A cannot attach a holding to B account');

-- Secret column is not readable by clients, even for own rows.
select throws_ok(
  $$select secret_encrypted from public.connections$$,
  '42501', null, 'secret_encrypted is not selectable by authenticated');

select * from finish();
rollback;
