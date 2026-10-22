-- 外部データとのコネクト（自動取り込み）
--   取りに行く型：Google フォーム / Google スプレッドシート（OAuth で連携し、定期的に新しい回答・行を取得）
--   届けてもらう型：Typeform / Tally（相手のサービスから Webhook。署名で送信元を確認）
--
--   * 連携の鍵（Google のリフレッシュトークン、Webhook の署名用の秘密）は Vault に暗号化して保存し、
--     利用者向けの API からは一切読めない。読めるのはサービスロールで動くワーカーとサーバーだけ。
--   * 取り込んだ回答は既存の流れ（二重取り込み防止 → 名寄せ → 確認待ち）にそのまま流す。
--   * 項目の対応（氏名の列）が決まるまでは、届いた回答を「保留」にして処理しない。

alter table public.form_connections drop constraint form_connections_kind_check;
alter table public.form_connections add constraint form_connections_kind_check
  check (kind in ('csv', 'webhook', 'google_forms', 'google_sheets', 'typeform', 'tally'));
alter table public.import_batches drop constraint import_batches_source_check;
alter table public.import_batches add constraint import_batches_source_check check (source in ('csv', 'webhook', 'sync'));
alter table public.form_submissions drop constraint form_submissions_source_check;
alter table public.form_submissions add constraint form_submissions_source_check check (source in ('csv', 'webhook', 'manual', 'sync'));
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('process_submissions', 'photo_analysis', 'export_people', 'send_campaign', 'send_test_email', 'task_digest', 'sync_connector'));

alter table public.form_connections
  add column provider_config jsonb not null default '{}',   -- { form_id | spreadsheet_id, sheet, columns: [...] }
  add column sync_enabled boolean not null default false,
  add column sync_interval_minutes integer not null default 15 check (sync_interval_minutes between 5 and 1440),
  add column next_sync_at timestamptz,
  add column last_synced_at timestamptz,
  add column last_sync_status text check (last_sync_status in ('ok', 'error', 'reauth_required', 'needs_mapping')),
  add column last_sync_error text,
  add column sync_cursor text,
  add column external_account text;          -- 連携した Google アカウント（表示用）

-- 利用者が書き換えられる列を限定（同期の状態はワーカーだけが更新）
revoke update on public.form_connections from authenticated;
grant update (name, field_mapping, default_tag_ids, event_id, is_active, provider_config, sync_enabled, sync_interval_minutes)
  on public.form_connections to authenticated;

-- 連携の鍵（Vault の参照だけを持つ。利用者向けのポリシーは置かない）
create table public.connector_credentials (
  connection_id uuid primary key references public.form_connections(id) on delete cascade,
  vault_secret_id uuid not null,
  purpose text not null check (purpose in ('google_refresh_token', 'webhook_signing_secret')),
  scopes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.connector_credentials enable row level security;

-- OAuth の途中状態（PKCE の検証子など）。サーバーだけが使う
create table public.oauth_states (
  state text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.form_connections(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);
alter table public.oauth_states enable row level security;

-- 連携の削除時に Vault の鍵も消す
create or replace function public.trg_delete_connector_secret() returns trigger
language plpgsql security definer set search_path = public, extensions, vault as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return null;
end $$;
create trigger connector_credentials_cleanup after delete on public.connector_credentials
  for each row execute function public.trg_delete_connector_secret();

-- ------------------------------------------------------------
-- 鍵の保存・取得（サービスロール専用）
-- ------------------------------------------------------------
create or replace function public.store_connector_secret(conn uuid, p_purpose text, secret text, p_scopes text default null,
                                                         account text default null)
returns void language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  cur public.connector_credentials;
  sid uuid;
begin
  select * into cur from public.connector_credentials where connection_id = conn;
  if cur.connection_id is not null then
    perform vault.update_secret(cur.vault_secret_id, secret);
    update public.connector_credentials set purpose = p_purpose, scopes = coalesce(p_scopes, scopes), updated_at = now()
      where connection_id = conn;
  else
    sid := vault.create_secret(secret, 'connector:' || conn::text || ':' || extract(epoch from now())::bigint::text);
    insert into public.connector_credentials (connection_id, vault_secret_id, purpose, scopes) values (conn, sid, p_purpose, p_scopes);
  end if;
  update public.form_connections set external_account = coalesce(account, external_account),
    last_sync_status = case when last_sync_status = 'reauth_required' then null else last_sync_status end,
    last_sync_error = case when last_sync_status = 'reauth_required' then null else last_sync_error end
    where id = conn;
end $$;

create or replace function public.get_connector_secret(conn uuid) returns text
language sql stable security definer set search_path = public, extensions, vault as $$
  select s.decrypted_secret from public.connector_credentials c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.connection_id = conn
$$;

-- ------------------------------------------------------------
-- 同期（取りに行く型）
-- ------------------------------------------------------------
-- 定期実行：期限が来た連携ごとに同期ジョブを作る（同じ連携のジョブが動いている間は作らない）
create or replace function public.enqueue_connector_syncs() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  c record;
  n int := 0;
begin
  for c in
    select fc.* from public.form_connections fc
    join public.organizations o on o.id = fc.organization_id and o.status = 'active'
    where fc.kind in ('google_forms', 'google_sheets') and fc.sync_enabled and fc.is_active
      and coalesce(fc.next_sync_at, '-infinity') <= now()
      and coalesce(fc.last_sync_status, 'ok') <> 'reauth_required'
      and exists (select 1 from public.connector_credentials cc where cc.connection_id = fc.id)
      and not exists (select 1 from public.jobs j where j.kind = 'sync_connector' and j.target_id = fc.id and j.status in ('queued', 'running'))
  loop
    perform public.enqueue_job(c.organization_id, 'sync_connector', c.id, jsonb_build_object('connection_id', c.id, 'mode', 'sync'));
    update public.form_connections set next_sync_at = now() + make_interval(mins => c.sync_interval_minutes) where id = c.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- 画面から「今すぐ取得」「質問を読み込む」
create or replace function public.request_connector_sync(conn uuid, p_mode text default 'sync') returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.form_connections;
begin
  select * into c from public.form_connections where id = conn;
  if c.id is null then raise exception 'not_found'; end if;
  perform public.require_role(c.organization_id, case when p_mode = 'discover' then 'admin'::public.org_role else 'editor'::public.org_role end);
  if c.kind not in ('google_forms', 'google_sheets') then raise exception 'not_supported'; end if;
  if not exists (select 1 from public.connector_credentials where connection_id = conn) then
    raise exception 'not_connected' using hint = '先に Google アカウントと連携してください。';
  end if;
  if exists (select 1 from public.jobs j where j.kind = 'sync_connector' and j.target_id = conn and j.status in ('queued', 'running')) then
    raise exception 'already_queued' using hint = '取得中です。しばらくお待ちください。';
  end if;
  return public.enqueue_job(c.organization_id, 'sync_connector', conn,
    jsonb_build_object('connection_id', conn, 'mode', case when p_mode = 'discover' then 'discover' else 'sync' end));
end $$;

-- ワーカー：取得した行を回答として保存（回答IDで二重取り込みを防ぐ）し、処理ジョブを積む
create or replace function public.worker_ingest_connector_rows(job uuid, rows jsonb, new_cursor text, columns jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  c public.form_connections;
  bid uuid;
  total int := jsonb_array_length(coalesce(rows, '[]'));
  inserted int := 0;
begin
  select * into j from public.jobs where id = job;
  if j.kind <> 'sync_connector' then raise exception 'wrong_job_kind'; end if;
  select * into c from public.form_connections where id = j.target_id and organization_id = j.organization_id;
  if c.id is null then raise exception 'not_found'; end if;
  if columns is not null then
    update public.form_connections set provider_config = provider_config || jsonb_build_object('columns', columns) where id = c.id;
  end if;
  if total > 0 then
    insert into public.import_batches (organization_id, connection_id, source, filename, status, total_rows)
      values (c.organization_id, c.id, 'sync', '自動取り込み', 'processing', total) returning id into bid;
    with ins as (
      insert into public.form_submissions (organization_id, connection_id, batch_id, dedupe_key, external_id, raw, source, submitted_at)
      select c.organization_id, c.id, bid,
             coalesce(nullif(r->>'external_id', ''), encode(digest((r->'raw')::text, 'sha256'), 'hex')),
             nullif(r->>'external_id', ''), r->'raw', 'sync', (r->>'submitted_at')::timestamptz
      from jsonb_array_elements(rows) r
      on conflict (connection_id, dedupe_key) do nothing
      returning 1
    ) select count(*) into inserted from ins;
    update public.import_batches set duplicate_rows = total - inserted,
      status = case when inserted = 0 then 'completed' else 'processing' end,
      finished_at = case when inserted = 0 then now() end
      where id = bid;
    if inserted > 0 then
      perform public.enqueue_job(c.organization_id, 'process_submissions', bid, jsonb_build_object('batch_id', bid));
    else
      delete from public.import_batches where id = bid;   -- 新しい行がなければ履歴を残さない
    end if;
  end if;
  update public.form_connections set sync_cursor = coalesce(new_cursor, sync_cursor), last_synced_at = now(),
    last_sync_status = case when field_mapping ? '__none__' then last_sync_status
                            when not exists (select 1 from jsonb_each_text(field_mapping) m where m.value = 'full_name') then 'needs_mapping'
                            else 'ok' end,
    last_sync_error = null
    where id = c.id;
  return jsonb_build_object('received', total, 'inserted', inserted);
end $$;

-- ワーカー：質問（列）を読み込み、対応が未設定なら提案した対応を入れる（自動取り込みは管理者が確認してから開始）
create or replace function public.worker_store_discovery(job uuid, columns jsonb, suggested jsonb, title text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
begin
  select * into j from public.jobs where id = job;
  update public.form_connections set
    provider_config = provider_config || jsonb_build_object('columns', columns) || case when title is null then '{}' else jsonb_build_object('title', title) end,
    field_mapping = case when field_mapping = '{}'::jsonb then coalesce(suggested, '{}') else field_mapping end,
    last_sync_status = case when sync_enabled then last_sync_status else 'needs_mapping' end,
    last_sync_error = null
  where id = j.target_id and organization_id = j.organization_id;
end $$;

create or replace function public.worker_connector_error(job uuid, err text, reauth boolean default false) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.form_connections set last_sync_status = case when reauth then 'reauth_required' else 'error' end,
    last_sync_error = left(err, 500), last_synced_at = now(),
    sync_enabled = case when reauth then false else sync_enabled end
  where id = (select target_id from public.jobs where id = job);
end $$;

-- ------------------------------------------------------------
-- 届けてもらう型：署名を確認した後の受け入れ（サービスロール専用）
-- ------------------------------------------------------------
create or replace function public.ingest_verified_submission(conn uuid, ext_id text, payload jsonb, sent_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.form_connections;
  sid uuid;
  key text;
  cols jsonb;
begin
  select * into c from public.form_connections where id = conn and is_active;
  if c.id is null then raise exception 'not_found'; end if;
  key := coalesce(nullif(ext_id, ''), encode(digest(payload::text, 'sha256'), 'hex'));
  insert into public.form_submissions (organization_id, connection_id, dedupe_key, external_id, raw, source, submitted_at)
    values (c.organization_id, conn, key, nullif(ext_id, ''), payload, 'webhook', sent_at)
    on conflict (connection_id, dedupe_key) do nothing
    returning id into sid;
  -- 届いた項目名を覚えておく（項目の対応の画面で選べるように）
  select coalesce(jsonb_agg(distinct k), '[]') into cols
    from (select jsonb_array_elements_text(coalesce(c.provider_config->'columns', '[]')) k union select jsonb_object_keys(payload)) x;
  update public.form_connections set provider_config = provider_config || jsonb_build_object('columns', cols), last_synced_at = now(),
    last_sync_status = case when exists (select 1 from jsonb_each_text(field_mapping) m where m.value = 'full_name') then 'ok' else 'needs_mapping' end
    where id = conn;
  if sid is null then return jsonb_build_object('status', 'duplicate'); end if;
  perform public.enqueue_job(c.organization_id, 'process_submissions', sid, jsonb_build_object('submission_id', sid));
  return jsonb_build_object('status', 'accepted', 'submission_id', sid);
end $$;

-- 回答の処理：氏名の対応がまだない接続の回答は保留にする（対応を設定した後に再処理できる）
create or replace function public.worker_process_submissions(job uuid, max_rows int default 200) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  s record;
  r text;
  processed int := 0;
  remaining int;
  held int := 0;
begin
  select * into j from public.jobs where id = job;
  if j.kind <> 'process_submissions' then raise exception 'wrong_job_kind'; end if;
  update public.form_submissions fs set error = '項目の対応（氏名の列）が未設定のため保留中です'
    from public.form_connections c
    where c.id = fs.connection_id and fs.organization_id = j.organization_id and fs.status = 'pending' and fs.error is null
      and not exists (select 1 from jsonb_each_text(c.field_mapping) m where m.value = 'full_name')
      and ((j.payload ? 'batch_id' and fs.batch_id = (j.payload->>'batch_id')::uuid)
        or (j.payload ? 'submission_id' and fs.id = (j.payload->>'submission_id')::uuid));
  get diagnostics held = row_count;
  for s in
    select fs.id from public.form_submissions fs
    where fs.organization_id = j.organization_id and fs.status = 'pending' and fs.error is null
      and ((j.payload ? 'batch_id' and fs.batch_id = (j.payload->>'batch_id')::uuid)
        or (j.payload ? 'submission_id' and fs.id = (j.payload->>'submission_id')::uuid))
    order by fs.received_at, fs.id
    limit max_rows
  loop
    r := public.apply_submission(s.id);
    processed := processed + 1;
    if r = 'quota_exceeded' then held := held + 1; end if;
  end loop;
  select count(*) into remaining from public.form_submissions fs
    where fs.organization_id = j.organization_id and fs.status = 'pending' and fs.error is null
      and ((j.payload ? 'batch_id' and fs.batch_id = (j.payload->>'batch_id')::uuid)
        or (j.payload ? 'submission_id' and fs.id = (j.payload->>'submission_id')::uuid));
  if remaining = 0 and j.payload ? 'batch_id' then
    update public.import_batches set status = 'completed', finished_at = now()
      where id = (j.payload->>'batch_id')::uuid and status = 'processing';
  end if;
  return jsonb_build_object('processed', processed, 'remaining', remaining, 'held', held);
end $$;

-- 対応を設定した後、この接続で保留にした回答を再処理する
create or replace function public.reprocess_connection(conn uuid) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.form_connections;
  n int;
  b record;
begin
  select * into c from public.form_connections where id = conn;
  if c.id is null then raise exception 'not_found'; end if;
  perform public.require_role(c.organization_id, 'editor');
  update public.form_submissions set error = null
    where connection_id = conn and status = 'pending' and error is not null;
  get diagnostics n = row_count;
  for b in select distinct batch_id from public.form_submissions where connection_id = conn and status = 'pending' and batch_id is not null loop
    update public.import_batches set status = 'processing', finished_at = null where id = b.batch_id;
    perform public.enqueue_job(c.organization_id, 'process_submissions', b.batch_id, jsonb_build_object('batch_id', b.batch_id));
  end loop;
  for b in select id from public.form_submissions where connection_id = conn and status = 'pending' and batch_id is null loop
    perform public.enqueue_job(c.organization_id, 'process_submissions', b.id, jsonb_build_object('submission_id', b.id));
  end loop;
  return n;
end $$;

-- 連携の状態（画面表示用。鍵そのものは返さない）
create or replace function public.connector_status(conn uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  c public.form_connections;
begin
  select * into c from public.form_connections where id = conn;
  if c.id is null then raise exception 'not_found'; end if;
  perform public.require_role(c.organization_id, 'editor');
  return jsonb_build_object(
    'connected', exists (select 1 from public.connector_credentials where connection_id = conn),
    'held', (select count(*) from public.form_submissions where connection_id = conn and status = 'pending' and error is not null),
    'total', (select count(*) from public.form_submissions where connection_id = conn),
    'job', (select jsonb_build_object('status', j.status, 'mode', j.payload->>'mode', 'last_error', j.last_error)
            from public.jobs j where j.kind = 'sync_connector' and j.target_id = conn order by j.created_at desc limit 1));
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'store_connector_secret(uuid, text, text, text, text)', 'get_connector_secret(uuid)', 'enqueue_connector_syncs()',
    'worker_ingest_connector_rows(uuid, jsonb, text, jsonb)', 'worker_store_discovery(uuid, jsonb, jsonb, text)',
    'worker_connector_error(uuid, text, boolean)', 'ingest_verified_submission(uuid, text, jsonb, timestamptz)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- 期限の来た連携の同期を毎分確認する（実際の取得間隔は連携ごとの設定。既定15分）
select cron.schedule('npo-crm-connector-sync', '* * * * *', 'select public.enqueue_connector_syncs()');
-- OAuth の途中状態の掃除
select cron.schedule('npo-crm-oauth-states', '*/30 * * * *', 'delete from public.oauth_states where expires_at < now()');
