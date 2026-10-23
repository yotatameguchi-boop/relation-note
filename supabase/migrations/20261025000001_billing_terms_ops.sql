-- 課金・契約（Stripe）、規約への同意、監視
--
-- 契約の流れ
--   作成時は30日間の無料期間（trialing）。期間内に申し込めば active。
--   無料期間が終わって申し込みがない／解約して期間が終わった／支払いが滞ったまま → 組織を「停止中」（閲覧・出力のみ）にする。
--   データは停止後も一定期間残し、出力できる（期間は利用規約で定める）。
--   Stripe からの通知（Webhook）はイベントIDで1回だけ処理する。

alter table public.organizations
  add column subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'complimentary')),
  add column trial_ends_at timestamptz not null default now() + interval '30 days',
  add column current_period_end timestamptz,
  add column cancel_at_period_end boolean not null default false,
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text unique,
  add column billing_email text,
  -- 契約の都合で停止した組織だけを、契約が戻ったときに自動で再開する（運営者が手で止めた組織は戻さない）
  add column billing_suspended boolean not null default false;

-- 既存の組織にも30日間の無料期間を付ける
update public.organizations set trial_ends_at = now() + interval '30 days';

create table public.billing_events (
  id text primary key,                 -- Stripe のイベントID
  organization_id uuid references public.organizations(id) on delete set null,
  type text not null,
  detail jsonb not null default '{}',  -- 状態・期間だけ（カード情報などは保存しない）
  received_at timestamptz not null default now()
);
alter table public.billing_events enable row level security;
create policy billing_events_read on public.billing_events for select to authenticated
  using (organization_id is not null and public.has_role(organization_id, 'owner'));

-- 契約の状態から、組織の利用状態（active / suspended）を決める
create or replace function public.refresh_org_access(org uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  o public.organizations;
  usable boolean;
begin
  select * into o from public.organizations where id = org for update;
  if o.id is null or o.status = 'cancelled' then return null; end if;
  usable := case o.subscription_status
    when 'active' then true
    when 'complimentary' then true
    when 'trialing' then o.trial_ends_at > now()
    -- 支払いの失敗は、Stripe の再請求期間中は使えるままにする
    when 'past_due' then coalesce(o.current_period_end, now()) + interval '14 days' > now()
    when 'canceled' then coalesce(o.current_period_end, now()) > now()
    else false
  end;
  if usable and o.status = 'suspended' and o.billing_suspended then
    update public.organizations set status = 'active', billing_suspended = false where id = org;
    return 'active';
  elsif not usable and o.status = 'active' then
    update public.organizations set status = 'suspended', billing_suspended = true where id = org;
    return 'suspended';
  end if;
  return o.status;
end $$;

-- 定期実行：無料期間・契約期間の終わった組織を停止中にする
create or replace function public.refresh_all_org_access() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  r record;
  n int := 0;
begin
  for r in select id from public.organizations where status <> 'cancelled' loop
    perform public.refresh_org_access(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Stripe の通知を1回だけ処理するための記録（既に処理済みなら false）
create or replace function public.record_billing_event(event_id text, org uuid, event_type text, det jsonb) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.billing_events (id, organization_id, type, detail) values (event_id, org, event_type, coalesce(det, '{}'));
  return true;
exception when unique_violation then
  return false;
end $$;

-- Stripe の契約情報を組織に反映（サーバーが署名を確認した通知からだけ呼ぶ）
create or replace function public.apply_stripe_subscription(org uuid, customer text, subscription text, sub_status text,
                                                            cycle text, period_end timestamptz, cancel_at_end boolean)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  mapped text := case sub_status
    when 'active' then 'active' when 'trialing' then 'active' when 'past_due' then 'past_due'
    when 'canceled' then 'canceled' when 'unpaid' then 'unpaid' when 'incomplete_expired' then 'canceled'
    when 'paused' then 'unpaid' else 'incomplete' end;
begin
  update public.organizations set
    stripe_customer_id = coalesce(customer, stripe_customer_id),
    stripe_subscription_id = coalesce(subscription, stripe_subscription_id),
    subscription_status = case when subscription_status = 'complimentary' then subscription_status else mapped end,
    billing_cycle = coalesce(cycle, billing_cycle),
    current_period_end = coalesce(period_end, current_period_end),
    cancel_at_period_end = coalesce(cancel_at_end, false)
  where id = org;
  perform public.refresh_org_access(org);
  insert into public.audit_logs (organization_id, actor_id, action, target_type, target_id, detail)
    values (org, null, 'billing.subscription_updated', 'organization', org::text,
            jsonb_build_object('status', mapped, 'cycle', cycle, 'period_end', period_end, 'cancel_at_period_end', cancel_at_end));
  return mapped;
end $$;

create or replace function public.set_stripe_customer(org uuid, customer text, email text) returns void
language sql security definer set search_path = public, extensions as $$
  update public.organizations set stripe_customer_id = customer, billing_email = coalesce(email, billing_email) where id = org;
$$;

-- ------------------------------------------------------------
-- 規約への同意
-- ------------------------------------------------------------
alter table public.users
  add column terms_version text,
  add column terms_accepted_at timestamptz;

create or replace function public.accept_terms(version text) returns void
language sql security definer set search_path = public, extensions as $$
  update public.users set terms_version = version, terms_accepted_at = now() where id = auth.uid();
$$;

-- 新規登録時に、登録画面で同意した版を記録する
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.users (id, email, display_name, terms_version, terms_accepted_at)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
          nullif(new.raw_user_meta_data->>'terms_version', ''),
          case when nullif(new.raw_user_meta_data->>'terms_version', '') is not null then now() end)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

-- ------------------------------------------------------------
-- 監視
-- ------------------------------------------------------------
create table public.worker_heartbeats (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  processed integer not null default 0,
  failed integer not null default 0,
  duration_ms integer
);
alter table public.worker_heartbeats enable row level security;

create or replace function public.worker_heartbeat(p_processed int, p_failed int, p_ms int) returns void
language sql security definer set search_path = public, extensions as $$
  insert into public.worker_heartbeats (processed, failed, duration_ms) values (p_processed, p_failed, p_ms);
  delete from public.worker_heartbeats where ran_at < now() - interval '3 days';
$$;

-- 運用の健全性（監視から呼ぶ。個人情報は含めず、件数と時刻だけ）
create or replace function public.ops_health() returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pgmq, cron as $$
declare
  last_beat timestamptz;
  q_len bigint;
  q_oldest timestamptz;
begin
  select max(ran_at) into last_beat from public.worker_heartbeats;
  select count(*), min(enqueued_at) into q_len, q_oldest from pgmq.q_jobs where vt <= now() + interval '1 hour';
  return jsonb_build_object(
    'checked_at', now(),
    'worker_last_run', last_beat,
    'worker_minutes_since_run', round(extract(epoch from now() - coalesce(last_beat, '-infinity'::timestamptz)) / 60),
    'queue_length', q_len,
    'queue_oldest_minutes', round(coalesce(extract(epoch from now() - q_oldest) / 60, 0)),
    'jobs_dead_24h', (select count(*) from public.jobs where status = 'dead' and finished_at > now() - interval '24 hours'),
    'jobs_running_stuck', (select count(*) from public.jobs where status = 'running' and locked_until < now() - interval '15 minutes'),
    'cron_failures_1h', (select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '1 hour'),
    'emails_failed_24h', (select count(*) from public.email_recipients where status in ('failed', 'unknown') and claimed_at > now() - interval '24 hours'),
    'connectors_in_error', (select count(*) from public.form_connections where last_sync_status in ('error', 'reauth_required')),
    'orgs', jsonb_build_object(
      'active', (select count(*) from public.organizations where status = 'active'),
      'suspended', (select count(*) from public.organizations where status = 'suspended'),
      'past_due', (select count(*) from public.organizations where subscription_status = 'past_due')),
    'db_size_mb', round(pg_database_size(current_database()) / 1024.0 / 1024.0)
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'refresh_org_access(uuid)', 'refresh_all_org_access()', 'record_billing_event(text, uuid, text, jsonb)',
    'apply_stripe_subscription(uuid, text, text, text, text, timestamptz, boolean)', 'set_stripe_customer(uuid, text, text)',
    'worker_heartbeat(int, int, int)', 'ops_health()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- 契約・利用状態の列は利用者に更新の権限を付けない（organizations の更新は列ごとの許可だけ）

select cron.schedule('npo-crm-org-access', '7 * * * *', 'select public.refresh_all_org_access()');
