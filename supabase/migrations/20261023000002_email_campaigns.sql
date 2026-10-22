-- メールの一斉配信（タグで宛先を絞る）、開封の記録、配信停止、タスクの朝の通知
--
--   * 送信は非同期（jobs キュー）。外部への送信は「多くて1回」を優先し、送信中に止まった宛先は自動で再送しない
--   * 開封は画像の読み込みで推定するため、正確な数ではない（画像を表示しないメールソフトでは数えられない）
--   * 特定電子メール法に配慮し、送信者情報と配信停止リンクを必ず付ける。宛先の同意は送信時にスタッフが確認する

-- 一斉配信の権限・利用枠・ジョブの種類
alter table public.memberships drop constraint memberships_permissions_check;
alter table public.memberships add constraint memberships_permissions_check check (
  permissions <@ array['bulk_export', 'bulk_delete', 'merge_people', 'manage_permissions', 'manage_sharing', 'view_shared', 'bulk_email']::text[]
);
create or replace function public.default_permissions(r public.org_role) returns text[]
language sql immutable as $$
  select case r
    when 'owner' then array['bulk_export', 'bulk_delete', 'merge_people', 'manage_permissions', 'manage_sharing', 'view_shared', 'bulk_email']
    when 'admin' then array['bulk_export', 'merge_people']
    else array[]::text[]
  end
$$;

alter table public.plans add column max_emails_per_month integer not null default 1000;
update public.plans set max_emails_per_month = 20000 where id = 'large';

alter table public.usage_records drop constraint usage_records_metric_check;
alter table public.usage_records add constraint usage_records_metric_check
  check (metric in ('photo_analysis', 'storage_bytes', 'export', 'email'));

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('process_submissions', 'photo_analysis', 'export_people', 'send_campaign', 'send_test_email', 'task_digest'));

-- 送信者情報（特定電子メール法の表示用：住所または連絡先）
alter table public.organizations add column email_sender_info text check (char_length(email_sender_info) <= 500);
grant update (email_sender_info) on public.organizations to authenticated;

-- タスクの朝の通知を受け取るか
alter table public.users add column task_digest boolean not null default true;
grant update (task_digest) on public.users to authenticated;

-- ------------------------------------------------------------
-- テーブル
-- ------------------------------------------------------------
create table public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  subject text not null default '' check (char_length(subject) <= 200),
  body_text text not null default '' check (char_length(body_text) <= 20000),
  from_name text check (char_length(from_name) <= 80),
  reply_to text check (reply_to is null or reply_to ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- { "tag_ids": [...], "match": "any" | "all", "exclude_tag_ids": [...] }
  audience jsonb not null default '{"tag_ids": [], "match": "any", "exclude_tag_ids": []}',
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'failed', 'cancelled')),
  consent_confirmed boolean not null default false,
  recipient_count integer not null default 0,
  last_error text,
  created_by uuid references public.users(id) on delete set null,
  sent_by uuid references public.users(id) on delete set null,
  send_requested_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index email_campaigns_org_idx on public.email_campaigns(organization_id, created_at desc);
create trigger email_campaigns_touch before update on public.email_campaigns for each row execute function public.touch_updated_at();

create table public.email_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  person_id uuid,
  email text not null,
  name text,
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  -- queued → sending → sent / failed。sending のまま止まったものは unknown（自動では再送しない）
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'unknown', 'skipped')),
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer not null default 0,
  unique (campaign_id, email),
  unique (organization_id, id),
  foreign key (organization_id, campaign_id) references public.email_campaigns(organization_id, id) on delete cascade,
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete set null (person_id)
);
create index email_recipients_campaign_idx on public.email_recipients(organization_id, campaign_id, status);
create index email_recipients_person_idx on public.email_recipients(organization_id, person_id);

alter table public.interactions
  add foreign key (organization_id, email_recipient_id) references public.email_recipients(organization_id, id) on delete set null (email_recipient_id);

create table public.email_optouts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,          -- 正規化済み
  person_id uuid,
  source text not null check (source in ('link', 'manual')),
  created_at timestamptz not null default now(),
  primary key (organization_id, email)
);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.email_campaigns enable row level security;
alter table public.email_recipients enable row level security;
alter table public.email_optouts enable row level security;
create policy email_campaigns_read on public.email_campaigns for select to authenticated using (public.is_member(organization_id));
create policy email_campaigns_insert on public.email_campaigns for insert to authenticated
  with check (public.has_role(organization_id, 'editor') and status = 'draft');
create policy email_campaigns_update on public.email_campaigns for update to authenticated
  using (public.has_role(organization_id, 'editor') and status = 'draft')
  with check (public.has_role(organization_id, 'editor') and status = 'draft');
create policy email_campaigns_delete on public.email_campaigns for delete to authenticated
  using (public.has_role(organization_id, 'editor') and status = 'draft');
revoke update on public.email_campaigns from authenticated;
grant update (name, subject, body_text, from_name, reply_to, audience) on public.email_campaigns to authenticated;
create policy email_recipients_read on public.email_recipients for select to authenticated using (public.is_member(organization_id));
create policy email_optouts_read on public.email_optouts for select to authenticated using (public.is_member(organization_id));
create policy email_optouts_insert on public.email_optouts for insert to authenticated
  with check (public.has_role(organization_id, 'editor') and source = 'manual');
create policy email_optouts_delete on public.email_optouts for delete to authenticated using (public.has_role(organization_id, 'admin'));
do $$
declare t text;
begin
  foreach t in array array['email_campaigns', 'email_recipients'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.prevent_org_change()', t || '_no_org_change', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 宛先の決定
-- ------------------------------------------------------------
-- タグで絞った宛先。1人1通（最初に登録したメールアドレス）、同じアドレスは1通、配信停止済みは除外
create or replace function public.campaign_audience(org uuid, aud jsonb)
returns table (person_id uuid, full_name text, display_name text, email text, excluded_reason text)
language sql stable security invoker set search_path = public, extensions as $$
  with tagged as (
    select p.* from public.people p
    where p.organization_id = org
      and (
        case when coalesce(aud->>'match', 'any') = 'all' then
          (select count(distinct pt.tag_id) from public.person_tags pt
            where pt.organization_id = org and pt.person_id = p.id
              and pt.tag_id in (select (jsonb_array_elements_text(coalesce(aud->'tag_ids', '[]')))::uuid))
          = jsonb_array_length(coalesce(aud->'tag_ids', '[]'))
        else exists (select 1 from public.person_tags pt
            where pt.organization_id = org and pt.person_id = p.id
              and pt.tag_id in (select (jsonb_array_elements_text(coalesce(aud->'tag_ids', '[]')))::uuid))
        end)
      and jsonb_array_length(coalesce(aud->'tag_ids', '[]')) > 0
      and not exists (select 1 from public.person_tags pt
            where pt.organization_id = org and pt.person_id = p.id
              and pt.tag_id in (select (jsonb_array_elements_text(coalesce(aud->'exclude_tag_ids', '[]')))::uuid))
  ), withmail as (
    select t.id, t.full_name, t.display_name, t.created_at,
      (select c.normalized_value from public.person_contacts c
        where c.organization_id = org and c.person_id = t.id and c.kind = 'email' order by c.created_at limit 1) as email
    from tagged t
  ), ranked as (
    select w.*, row_number() over (partition by w.email order by w.created_at, w.id) rn from withmail w
  )
  select r.id, r.full_name, r.display_name, r.email,
    case
      when r.email is null then 'no_email'
      when exists (select 1 from public.email_optouts o where o.organization_id = org and o.email = r.email) then 'opted_out'
      when r.rn > 1 then 'duplicate_email'
      else null
    end
  from ranked r
  order by r.full_name
$$;

create or replace function public.preview_campaign(campaign uuid) returns jsonb
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  c public.email_campaigns;
  res jsonb;
  used bigint;
  lim int;
begin
  select * into c from public.email_campaigns where id = campaign;
  if c.id is null then raise exception 'not_found'; end if;
  select public.usage_in_use(c.organization_id, 'email'), p.max_emails_per_month into used, lim
    from public.organizations o join public.plans p on p.id = o.plan_id where o.id = c.organization_id;
  select jsonb_build_object(
    'recipients', count(*) filter (where excluded_reason is null),
    'no_email', count(*) filter (where excluded_reason = 'no_email'),
    'opted_out', count(*) filter (where excluded_reason = 'opted_out'),
    'duplicate_email', count(*) filter (where excluded_reason = 'duplicate_email'),
    'sample', coalesce((select jsonb_agg(jsonb_build_object('name', x.full_name, 'display_name', x.display_name, 'email', x.email))
                        from (select * from public.campaign_audience(c.organization_id, c.audience) a where a.excluded_reason is null limit 5) x), '[]'),
    'usage', jsonb_build_object('used', used, 'limit', lim)
  ) into res
  from public.campaign_audience(c.organization_id, c.audience);
  return res;
end $$;

-- 送信開始：宛先を確定してキューに積む（一括配信の権限が必要）
create or replace function public.send_campaign(campaign uuid, consent boolean) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.email_campaigns;
  n int;
  used bigint;
  lim int;
  sender text;
  jid uuid;
begin
  select * into c from public.email_campaigns where id = campaign for update;
  if c.id is null then raise exception 'not_found'; end if;
  perform public.require_role(c.organization_id, 'admin');
  perform public.require_perm(c.organization_id, 'bulk_email');
  if c.status <> 'draft' then raise exception 'campaign_not_draft' using hint = 'この配信はすでに送信済みか、送信中です。'; end if;
  if btrim(c.subject) = '' or btrim(c.body_text) = '' then raise exception 'campaign_incomplete' using hint = '件名と本文を入力してください。'; end if;
  if not consent then
    raise exception 'consent_required' using hint = '宛先がメールの受け取りに同意していることを確認してください。';
  end if;
  select email_sender_info into sender from public.organizations where id = c.organization_id;
  if nullif(btrim(sender), '') is null then
    raise exception 'sender_info_required' using hint = '組織設定で「送信者情報（住所または連絡先）」を入力してください。メールの末尾に表示します。';
  end if;

  -- 宛先の確定（この組織の人物だけを対象にする）
  create temporary table _aud on commit drop as
    select * from public.campaign_audience(c.organization_id, c.audience) where excluded_reason is null;
  select count(*) into n from _aud;
  if n = 0 then raise exception 'no_recipients' using hint = '送信できる宛先がありません。'; end if;
  perform pg_advisory_xact_lock(hashtext('usage:' || c.organization_id::text));
  select public.usage_in_use(c.organization_id, 'email'), p.max_emails_per_month into used, lim
    from public.organizations o join public.plans p on p.id = o.plan_id where o.id = c.organization_id;
  if used + n > lim then
    raise exception 'quota_exceeded:email' using hint = '今月のメール送信枠（' || lim || '通）を超えます。残り ' || greatest(lim - used, 0) || '通です。';
  end if;
  insert into public.email_recipients (organization_id, campaign_id, person_id, email, name)
    select c.organization_id, c.id, a.person_id, a.email, coalesce(a.display_name, a.full_name) from _aud a;
  -- 利用枠は確定時点で予約し、送れなかった分は完了時に解放する
  insert into public.usage_records (organization_id, metric, period, quantity, status, idempotency_key, committed_at)
    values (c.organization_id, 'email', public.current_period(), n, 'committed', 'email:campaign:' || c.id, now());
  update public.email_campaigns set status = 'sending', consent_confirmed = true, recipient_count = n,
    sent_by = auth.uid(), send_requested_at = now(), last_error = null where id = c.id;
  jid := public.enqueue_job(c.organization_id, 'send_campaign', c.id, jsonb_build_object('campaign_id', c.id));
  perform public.audit(c.organization_id, 'email.campaign_send', 'email_campaign', c.id::text,
                       jsonb_build_object('recipients', n, 'audience', c.audience));
  return n;
end $$;

-- 自分あてのテスト送信（編集者以上）。宛名などの差し込みは自分の名前で行う
create or replace function public.send_test_email(campaign uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.email_campaigns;
  me public.users;
begin
  select * into c from public.email_campaigns where id = campaign;
  if c.id is null then raise exception 'not_found'; end if;
  perform public.require_role(c.organization_id, 'editor');
  select * into me from public.users where id = auth.uid();
  return public.enqueue_job(c.organization_id, 'send_test_email', c.id,
    jsonb_build_object('campaign_id', c.id, 'to', me.email, 'name', coalesce(me.display_name, me.email)));
end $$;

-- 配信停止を手動で登録（本人から電話で依頼された場合など）
create or replace function public.add_email_optout(org uuid, addr text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.require_role(org, 'editor');
  if public.normalize_email(addr) is null then raise exception 'invalid_email'; end if;
  insert into public.email_optouts (organization_id, email, source) values (org, public.normalize_email(addr), 'manual')
    on conflict do nothing;
  perform public.audit(org, 'email.optout', 'email', null, jsonb_build_object('source', 'manual'));
end $$;

create or replace function public.campaign_stats(campaign uuid) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select jsonb_build_object(
    'total', count(*),
    'queued', count(*) filter (where status in ('queued', 'sending')),
    'sent', count(*) filter (where status = 'sent'),
    'failed', count(*) filter (where status in ('failed', 'unknown')),
    'opened', count(*) filter (where opened_at is not null))
  from public.email_recipients where campaign_id = campaign
$$;

-- ------------------------------------------------------------
-- ワーカー用（サービスロール専用）
-- ------------------------------------------------------------
-- 次に送る宛先を「送信中」にして返す。送信中のまま10分以上たったものは unknown にして再送しない
create or replace function public.worker_claim_recipients(job uuid, max_rows int default 20)
returns table (recipient_id uuid, email text, name text, token text, subject text, body_text text, from_name text,
               reply_to text, org_name text, sender_info text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  c public.email_campaigns;
begin
  select * into j from public.jobs where id = job;
  if j.kind <> 'send_campaign' then raise exception 'wrong_job_kind'; end if;
  select * into c from public.email_campaigns where id = j.target_id and organization_id = j.organization_id;
  if c.id is null then raise exception 'not_found'; end if;
  update public.email_recipients set status = 'unknown', error = '送信中に処理が止まったため、二重送信を避けて再送していません'
    where campaign_id = c.id and status = 'sending' and claimed_at < now() - interval '10 minutes';
  return query
  with picked as (
    select r.id from public.email_recipients r
    where r.campaign_id = c.id and r.organization_id = c.organization_id and r.status = 'queued'
    order by r.id limit max_rows for update skip locked
  ), upd as (
    update public.email_recipients r set status = 'sending', claimed_at = now()
    from picked where r.id = picked.id
    returning r.id, r.email, r.name, r.token
  )
  select u.id, u.email, u.name, u.token, c.subject, c.body_text, c.from_name, c.reply_to, o.name, o.email_sender_info
  from upd u, public.organizations o where o.id = c.organization_id;
end $$;

create or replace function public.worker_mark_email(recipient uuid, ok boolean, err text default null, message_id text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  r public.email_recipients;
  c public.email_campaigns;
begin
  select * into r from public.email_recipients where id = recipient for update;
  if r.id is null or r.status <> 'sending' then return; end if;   -- 二重の記録をしない
  select * into c from public.email_campaigns where id = r.campaign_id;
  if ok then
    update public.email_recipients set status = 'sent', sent_at = now(), provider_message_id = message_id, error = null where id = r.id;
    -- やりとりの記録（時系列）に残す
    if r.person_id is not null then
      insert into public.interactions (organization_id, kind, direction, occurred_at, subject, body, person_id, email_recipient_id, created_by)
        values (r.organization_id, 'email', 'outbound', now(), c.subject, '一斉配信「' || c.name || '」', r.person_id, r.id, c.sent_by);
    end if;
  else
    update public.email_recipients set status = 'failed', error = left(err, 500) where id = r.id;
  end if;
end $$;

-- 残りがなければ配信を完了にし、送れなかった分の利用枠を解放する
create or replace function public.worker_finish_campaign(job uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  remaining int;
  sent int;
begin
  select * into j from public.jobs where id = job;
  select count(*) filter (where status in ('queued', 'sending')), count(*) filter (where status = 'sent')
    into remaining, sent from public.email_recipients where campaign_id = j.target_id;
  if remaining = 0 then
    update public.email_campaigns set status = 'sent', completed_at = now() where id = j.target_id and status = 'sending';
    update public.usage_records set quantity = sent where idempotency_key = 'email:campaign:' || j.target_id;
  end if;
  return jsonb_build_object('remaining', remaining, 'sent', sent);
end $$;

create or replace function public.worker_campaign_failed(job uuid, err text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.email_campaigns set status = 'failed', last_error = left(err, 500)
    where id = (select target_id from public.jobs where id = job) and status = 'sending';
end $$;

-- 開封（画像の読み込み）を記録
create or replace function public.record_email_open(p_token text) returns void
language sql security definer set search_path = public, extensions as $$
  update public.email_recipients set open_count = open_count + 1, last_opened_at = now(), opened_at = coalesce(opened_at, now())
  where token = p_token and status = 'sent';
$$;

-- 配信停止リンク。表示用の情報だけ返す
create or replace function public.lookup_unsubscribe(p_token text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('org_name', o.name, 'email', regexp_replace(r.email, '^(.).*(@.*)$', '\1***\2'),
    'already', exists (select 1 from public.email_optouts x where x.organization_id = r.organization_id and x.email = r.email))
  from public.email_recipients r join public.organizations o on o.id = r.organization_id
  where r.token = p_token
$$;

create or replace function public.unsubscribe_by_token(p_token text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare r public.email_recipients;
begin
  select * into r from public.email_recipients where token = p_token;
  if r.id is null then return false; end if;
  insert into public.email_optouts (organization_id, email, person_id, source) values (r.organization_id, r.email, r.person_id, 'link')
    on conflict do nothing;
  -- 配信停止はまだ送っていない宛先にも即時に効かせる
  update public.email_recipients set status = 'skipped', error = '配信停止'
    where organization_id = r.organization_id and email = r.email and status = 'queued';
  return true;
end $$;

-- タスクの朝の通知：期限が今日まで（期限切れを含む）の未完了タスクがある担当者ごとにジョブを作る
create or replace function public.enqueue_task_digests() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  r record;
  n int := 0;
  today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  for r in
    select t.organization_id, t.assignee_id
    from public.tasks t
    join public.users u on u.id = t.assignee_id and u.task_digest
    join public.memberships m on m.organization_id = t.organization_id and m.user_id = t.assignee_id
    join public.organizations o on o.id = t.organization_id and o.status = 'active'
    where t.status = 'open' and t.due_date <= today
    group by t.organization_id, t.assignee_id
  loop
    if not exists (select 1 from public.jobs j where j.kind = 'task_digest' and j.organization_id = r.organization_id
                   and j.target_id = r.assignee_id and j.payload->>'date' = today::text) then
      perform public.enqueue_job(r.organization_id, 'task_digest', r.assignee_id, jsonb_build_object('date', today));
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.worker_task_digest(job uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  today date;
begin
  select * into j from public.jobs where id = job;
  if j.kind <> 'task_digest' then raise exception 'wrong_job_kind'; end if;
  today := (j.payload->>'date')::date;
  return (
    select jsonb_build_object(
      'email', u.email, 'name', coalesce(u.display_name, u.email), 'enabled', u.task_digest, 'org_id', o.id, 'org_name', o.name,
      'tasks', coalesce((select jsonb_agg(jsonb_build_object('title', t.title, 'due_date', t.due_date, 'priority', t.priority,
                 'person', p.full_name, 'company', c.name) order by t.due_date, t.priority desc)
               from public.tasks t
               left join public.people p on p.id = t.person_id
               left join public.companies c on c.id = t.company_id
               where t.organization_id = j.organization_id and t.assignee_id = u.id and t.status = 'open' and t.due_date <= today), '[]'))
    from public.users u, public.organizations o
    where u.id = j.target_id and o.id = j.organization_id
      and exists (select 1 from public.memberships m where m.organization_id = o.id and m.user_id = u.id)
  );
end $$;

-- 隔離された一斉配信ジョブの再実行にも対応
create or replace function public.retry_job(job uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  mid bigint;
begin
  select * into j from public.jobs where id = job for update;
  if j.id is null then raise exception 'not_found'; end if;
  perform public.require_role(j.organization_id, 'admin');
  if j.status <> 'dead' then raise exception 'not_dead' using hint = '隔離されたジョブのみ再実行できます。'; end if;
  if j.kind = 'photo_analysis' then
    perform public.reserve_photo_analysis(j.organization_id, j.target_id);
    update public.photos set status = 'queued', failure_reason = null where id = j.target_id;
  elsif j.kind = 'process_submissions' and j.payload ? 'batch_id' then
    update public.import_batches set status = 'processing', finished_at = null where id = (j.payload->>'batch_id')::uuid;
  elsif j.kind = 'send_campaign' then
    update public.email_campaigns set status = 'sending', last_error = null where id = j.target_id and status = 'failed';
  end if;
  select pgmq.send('jobs', jsonb_build_object('job_id', j.id)) into mid;
  update public.jobs set status = 'queued', attempts = 0, msg_id = mid, finished_at = null where id = j.id;
  perform public.audit(j.organization_id, 'job.retry', 'job', j.id::text, jsonb_build_object('kind', j.kind));
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'worker_claim_recipients(uuid, int)', 'worker_mark_email(uuid, boolean, text, text)', 'worker_finish_campaign(uuid)',
    'worker_campaign_failed(uuid, text)', 'record_email_open(text)', 'lookup_unsubscribe(text)', 'unsubscribe_by_token(text)',
    'enqueue_task_digests()', 'worker_task_digest(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- 毎朝8時（日本時間）にタスクの通知を作る
select cron.schedule('npo-crm-task-digest', '0 23 * * *', 'select public.enqueue_task_digests()');
