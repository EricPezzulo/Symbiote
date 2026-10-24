-- Phase 4 RLS test (pgTAP). Run with: npx supabase test db  (needs local Docker) or paste into the SQL editor.
begin;
select plan(13);

insert into auth.users (id, instance_id, aud, role, email)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.com');

insert into public.news_items (id, source, url, url_hash, title, published_at, category, symbols)
  values ('cccccccc-0000-0000-0000-000000000001', 'test', 'https://example.com/n1', 'hash1', 'headline one', now(), 'market', '{AAPL}');
insert into public.news_scores (news_item_id, relevance, sentiment, impact_horizon, is_catalyst, why_it_matters, model)
  values ('cccccccc-0000-0000-0000-000000000001', 85, 'positive', 'days', true, 'Because.', 'test-model');
insert into public.calendar_events (unique_key, kind, symbol, title, event_at, source)
  values ('earnings:AAPL:2026-11-01', 'earnings', 'AAPL', 'AAPL earnings', now() + interval '3 days', 'test');
insert into public.news_usage (day, input_tokens) values (current_date, 10);
insert into public.alerts (user_id, news_item_id, kind, title, scope, symbols, sentiment)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001', 'news', 'B alert', 'holding', '{AAPL}', 'positive');

-- Idempotency (as superuser/service role): second alert for same (user, item) is rejected.
select throws_ok(
  $$insert into public.alerts (user_id, news_item_id, kind, title)
    values ('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001', 'news', 'dup')$$,
  '23505', null, 'duplicate (user, news_item) alert is rejected');
select lives_ok(
  $$insert into public.alerts (user_id, kind, title) values ('bbbbbbbb-0000-0000-0000-000000000002', 'price', 'p1'), ('bbbbbbbb-0000-0000-0000-000000000002', 'price', 'p2')$$,
  'price alerts (null news_item_id) are not constrained');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);

select is((select count(*)::int from public.news_scores), 1, 'A can read global news_scores');
select is((select count(*)::int from public.calendar_events), 1, 'A can read global calendar_events');
select is((select count(*)::int from public.alerts), 0, 'A cannot read B alerts');
select throws_ok($$select * from public.news_usage$$, '42501', null, 'news_usage is not readable by clients');

select throws_ok(
  $$insert into public.news_scores (news_item_id, relevance, sentiment, impact_horizon, model)
    values ('cccccccc-0000-0000-0000-000000000001', 1, 'neutral', 'days', 'x')$$,
  '42501', null, 'clients cannot write news_scores');
select throws_ok(
  $$insert into public.calendar_events (unique_key, kind, title, event_at, source) values ('k', 'earnings', 't', now(), 's')$$,
  '42501', null, 'clients cannot write calendar_events');
select throws_ok(
  $$insert into public.news_items (source, url, title, published_at) values ('x', 'https://e.com/x', 't', now())$$,
  '42501', null, 'clients cannot write news_items');
select throws_ok(
  $$insert into public.alerts (user_id, kind, title) values ('bbbbbbbb-0000-0000-0000-000000000002', 'news', 'spoof')$$,
  '42501', null, 'A cannot create alerts for B');

-- Positive control: A can create and dismiss an alert of their own.
select lives_ok(
  $$insert into public.alerts (user_id, news_item_id, kind, title, scope)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'news', 'A alert', 'market')$$,
  'A can insert own alert');
select lives_ok($$update public.alerts set dismissed_at = now() where title = 'A alert'$$, 'A can dismiss own alert');
select is((select count(*)::int from public.alerts where dismissed_at is not null), 1, 'A sees only own dismissed alert');

select * from finish();
rollback;
