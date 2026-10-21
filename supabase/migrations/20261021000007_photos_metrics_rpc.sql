-- 写真解析（§11.2）、出力、集計（§5）、期限切れ整理と定期実行（Supabase Cron）

-- ------------------------------------------------------------
-- 写真：利用枠の予約 → アップロード → 完了確認 → 解析ジョブ
-- ------------------------------------------------------------
create or replace function public.reserve_photo_analysis(org uuid, photo uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  lim int;
begin
  perform pg_advisory_xact_lock(hashtext('usage:' || org::text));
  select p.max_photo_analyses_per_month into lim from public.organizations o join public.plans p on p.id = o.plan_id where o.id = org;
  if public.usage_in_use(org, 'photo_analysis') >= lim then
    raise exception 'quota_exceeded:photo_analysis' using hint = '今月の写真解析枠（' || lim || '枚）に達しています。';
  end if;
  insert into public.usage_records (organization_id, metric, period, quantity, status, idempotency_key, expires_at)
    values (org, 'photo_analysis', public.current_period(), 1, 'reserved', 'photo_analysis:' || photo, now() + interval '1 hour')
  on conflict (idempotency_key) do update set status = 'reserved', released_at = null, period = excluded.period,
    expires_at = excluded.expires_at
    where usage_records.status = 'released';
end $$;
revoke execute on function public.reserve_photo_analysis(uuid, uuid) from public, anon, authenticated;

create or replace function public.reserve_photo_upload(org uuid, event uuid, file_name text, mime text, size_bytes bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  pid uuid := gen_random_uuid();
  path text;
  st_lim bigint;
  retention int;
begin
  perform public.require_role(org, 'editor');
  if mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'invalid_file' using hint = 'JPEG / PNG / WebP の画像を選んでください。';
  end if;
  if size_bytes <= 0 or size_bytes > 15 * 1024 * 1024 then
    raise exception 'invalid_file' using hint = '1枚15MBまでです。';
  end if;
  if event is not null and not exists (select 1 from public.events where organization_id = org and id = event) then
    raise exception 'not_found';
  end if;
  select p.max_storage_bytes, o.photo_retention_days into st_lim, retention
    from public.organizations o join public.plans p on p.id = o.plan_id where o.id = org;

  path := org::text || '/' || pid::text || case mime when 'image/png' then '.png' when 'image/webp' then '.webp' else '.jpg' end;
  insert into public.photos (id, organization_id, event_id, storage_path, original_filename, mime_type, size_bytes,
                             uploaded_by, expires_at)
    values (pid, org, event, path, left(file_name, 255), mime, size_bytes, auth.uid(), now() + make_interval(days => retention));

  -- 解析枠と保存容量を予約（期限内にアップロードが完了しなければ解放）
  perform public.reserve_photo_analysis(org, pid);
  if public.usage_in_use(org, 'storage_bytes') + size_bytes > st_lim then
    raise exception 'quota_exceeded:storage' using hint = '写真の保存容量の上限に達しています。古い写真を削除するか、プランを変更してください。';
  end if;
  insert into public.usage_records (organization_id, metric, period, quantity, status, idempotency_key, expires_at)
    values (org, 'storage_bytes', public.current_period(), size_bytes, 'reserved', 'storage:photo:' || pid, now() + interval '30 minutes');
  update public.usage_records set expires_at = now() + interval '30 minutes' where idempotency_key = 'photo_analysis:' || pid;
  return jsonb_build_object('photo_id', pid, 'path', path);
end $$;

-- サーバーが実ファイル（形式・サイズ）を確認したあとに呼ぶ（サービスロール専用）
create or replace function public.complete_photo_upload(photo uuid, org uuid, actual_size bigint, actual_mime text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  ph public.photos;
  jid uuid;
begin
  select * into ph from public.photos where id = photo for update;
  if ph.id is null or ph.organization_id <> org then raise exception 'not_found'; end if;
  if ph.status <> 'uploading' then
    return (select id from public.jobs where target_id = photo and kind = 'photo_analysis' order by created_at desc limit 1);
  end if;
  if ph.upload_deadline < now() then raise exception 'upload_expired'; end if;
  if actual_mime is distinct from ph.mime_type or actual_size <> ph.size_bytes then
    raise exception 'upload_mismatch' using hint = '申告された形式・サイズと実ファイルが一致しません。';
  end if;
  update public.photos set status = 'queued', uploaded_at = now() where id = photo;
  update public.usage_records set status = 'committed', committed_at = now(), expires_at = null
    where idempotency_key = 'storage:photo:' || photo;
  -- 解析が終わるまで解析枠の予約を延長
  update public.usage_records set expires_at = now() + interval '2 days'
    where idempotency_key = 'photo_analysis:' || photo and status = 'reserved';
  jid := public.enqueue_job(org, 'photo_analysis', photo, jsonb_build_object('photo_id', photo, 'path', ph.storage_path));
  update public.jobs set created_by = ph.uploaded_by where id = jid;
  return jid;
end $$;

-- 解析結果の保存（同じジョブの再実行で結果・利用量が重複しない）
create or replace function public.worker_save_photo_result(job uuid, estimated int, dets jsonb, provider text,
                                                           model text, version text, min_conf numeric)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  ph public.photos;
  rid uuid;
begin
  select * into j from public.jobs where id = job;
  if j.kind <> 'photo_analysis' then raise exception 'wrong_job_kind'; end if;
  select * into ph from public.photos where id = j.target_id;
  -- ジョブ・対象データ・保存先の団体が一致することを確認
  if ph.id is null or ph.organization_id <> j.organization_id
     or split_part(ph.storage_path, '/', 1) <> j.organization_id::text then
    raise exception 'tenant_mismatch';
  end if;
  insert into public.photo_analysis_results (organization_id, photo_id, job_id, estimated_count, detections,
                                             model_provider, model_name, model_version, min_confidence)
    values (j.organization_id, ph.id, j.id, estimated, coalesce(dets, '[]'), provider, model, version, min_conf)
    on conflict (job_id) do nothing
    returning id into rid;
  if rid is null then
    select id into rid from public.photo_analysis_results where job_id = job;
  end if;
  update public.photos set status = 'analyzed', failure_reason = null where id = ph.id;
  update public.usage_records set status = 'committed', committed_at = coalesce(committed_at, now()), expires_at = null
    where idempotency_key = 'photo_analysis:' || ph.id and status in ('reserved', 'committed');
  return rid;
end $$;

-- 再解析（スタッフが明示的に依頼。利用枠を1枚消費）
create or replace function public.reanalyze_photo(photo uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  ph public.photos;
  jid uuid;
begin
  select * into ph from public.photos where id = photo for update;
  if ph.id is null then raise exception 'not_found'; end if;
  perform public.require_role(ph.organization_id, 'editor');
  if ph.status not in ('analyzed', 'failed') then raise exception 'not_ready'; end if;
  if exists (select 1 from public.jobs where target_id = photo and kind = 'photo_analysis' and status in ('queued', 'running')) then
    raise exception 'already_queued';
  end if;
  -- 再解析分は新しい利用キーで予約
  perform pg_advisory_xact_lock(hashtext('usage:' || ph.organization_id::text));
  if public.usage_in_use(ph.organization_id, 'photo_analysis') >=
     (select p.max_photo_analyses_per_month from public.organizations o join public.plans p on p.id = o.plan_id where o.id = ph.organization_id) then
    raise exception 'quota_exceeded:photo_analysis';
  end if;
  update public.usage_records set idempotency_key = idempotency_key || ':' || id
    where idempotency_key = 'photo_analysis:' || photo;
  insert into public.usage_records (organization_id, metric, period, quantity, status, idempotency_key, expires_at)
    values (ph.organization_id, 'photo_analysis', public.current_period(), 1, 'reserved', 'photo_analysis:' || photo, now() + interval '2 days');
  update public.photos set status = 'queued', failure_reason = null where id = photo;
  jid := public.enqueue_job(ph.organization_id, 'photo_analysis', photo, jsonb_build_object('photo_id', photo, 'path', ph.storage_path));
  perform public.audit(ph.organization_id, 'photo.reanalyze', 'photo', photo::text);
  return jid;
end $$;

create or replace function public.delete_photo(photo uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare ph public.photos;
begin
  select * into ph from public.photos where id = photo;
  if ph.id is null then raise exception 'not_found'; end if;
  perform public.require_role(ph.organization_id, 'editor');
  delete from public.photos where id = photo;
  update public.usage_records set status = 'released', released_at = now()
    where idempotency_key = 'storage:photo:' || photo and status <> 'released';
  update public.usage_records set status = 'released', released_at = now()
    where idempotency_key = 'photo_analysis:' || photo and status = 'reserved';
  perform public.audit(ph.organization_id, 'photo.delete', 'photo', photo::text);
  return ph.storage_path;
end $$;

-- 期限切れ：未完了アップロードと保存期限切れの写真（実ファイル削除はワーカーが行う）
create or replace function public.worker_expired_photos(max_rows int default 100)
returns table (photo_id uuid, storage_path text, reason text)
language sql security definer set search_path = public, extensions as $$
  select id, storage_path, 'upload_timeout' from public.photos
    where status = 'uploading' and upload_deadline < now() - interval '5 minutes'
  union all
  select id, storage_path, 'retention' from public.photos
    where status not in ('uploading', 'expired') and expires_at < now()
  limit max_rows
$$;

create or replace function public.worker_mark_photo_removed(photo uuid, reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if reason = 'upload_timeout' then
    delete from public.photos where id = photo and status = 'uploading';
  else
    -- 解析結果・確定人数は残し、画像だけ削除
    update public.photos set status = 'expired' where id = photo;
  end if;
  update public.usage_records set status = 'released', released_at = now()
    where idempotency_key = 'storage:photo:' || photo and status <> 'released';
  update public.usage_records set status = 'released', released_at = now()
    where idempotency_key = 'photo_analysis:' || photo and status = 'reserved';
end $$;

create or replace function public.release_expired_reservations() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  update public.usage_records set status = 'released', released_at = now()
    where status = 'reserved' and expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------
-- 出力（一括出力は明示的権限）
-- ------------------------------------------------------------
create or replace function public.request_people_export(org uuid, filters jsonb default '{}') returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare jid uuid;
begin
  perform public.require_role(org, 'viewer');
  perform public.require_perm(org, 'bulk_export');
  jid := public.enqueue_job(org, 'export_people', null, jsonb_build_object('filters', coalesce(filters, '{}')));
  insert into public.usage_records (organization_id, metric, period, quantity, status, idempotency_key, committed_at)
    values (org, 'export', public.current_period(), 1, 'committed', 'export:' || jid, now());
  perform public.audit(org, 'people.export', 'job', jid::text, jsonb_build_object('filters', filters));
  return jid;
end $$;

-- ------------------------------------------------------------
-- 集計（§5）。写真人数は合算せず、参加人数とは別に扱う。
-- ------------------------------------------------------------
create or replace function public.org_metrics(org uuid, from_ts timestamptz, to_ts timestamptz) returns jsonb
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  o public.organizations;
  res jsonb;
begin
  select * into o from public.organizations where id = org;
  if o.id is null then raise exception 'not_found'; end if;
  with ev as (
    select e.*,
      (select count(*) from public.event_participations ep where ep.event_id = e.id and ep.status = 'attended')::int as attended_records,
      (select count(*) from public.event_participations ep where ep.event_id = e.id and ep.status = 'applied')::int as applied_records
    from public.events e
    where e.organization_id = org and e.starts_at >= from_ts and e.starts_at < to_ts
  ), att as (
    select ep.person_id, count(*) n from public.event_participations ep
    join ev on ev.id = ep.event_id
    where ep.status = 'attended'
    group by ep.person_id
  ), photo_rows as (
    select ph.id, ph.event_id,
      (select r.estimated_count from public.photo_analysis_results r where r.photo_id = ph.id order by r.analyzed_at desc limit 1) est,
      (select v.confirmed_count from public.photo_reviews v where v.photo_id = ph.id order by v.reviewed_at desc limit 1) conf
    from public.photos ph join ev on ev.id = ph.event_id
  ), related as (
    -- 関係人口：定義期間内に「参加確認」または「フォーム回答」があった人物（団体設定の期間）
    select ep.person_id from public.event_participations ep
      join public.events e on e.id = ep.event_id
      where ep.organization_id = org and ep.status = 'attended'
        and e.starts_at >= to_ts - make_interval(days => o.relation_window_days) and e.starts_at < to_ts
    union
    select fs.person_id from public.form_submissions fs
      where fs.organization_id = org and fs.person_id is not null
        and coalesce(fs.submitted_at, fs.received_at) >= to_ts - make_interval(days => o.relation_window_days)
        and coalesce(fs.submitted_at, fs.received_at) < to_ts
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', from_ts, 'to', to_ts),
    'definition', jsonb_build_object('relation_window_days', o.relation_window_days, 'repeat_threshold', o.repeat_threshold),
    'events_held', (select count(*) from ev),
    -- 延べ参加人数：各イベントの参加人数（確定値があれば確定値、なければ参加確認済み＋匿名）の合計
    'total_participation', (select coalesce(sum(coalesce(confirmed_headcount, attended_records + anonymous_count)), 0) from ev),
    'attended_records', (select coalesce(sum(attended_records), 0) from ev),
    'anonymous_attendees', (select coalesce(sum(anonymous_count), 0) from ev),
    -- 実参加者数：名簿上の人物の重複を除いた人数（匿名参加者は含められない）
    'unique_participants', (select count(*) from att),
    'repeat_participants', (select count(*) from att where n >= o.repeat_threshold),
    'related_people', (select count(distinct person_id) from related),
    'photos', jsonb_build_object(
      'count', (select count(*) from photo_rows),
      'with_estimate', (select count(*) from photo_rows where est is not null),
      'confirmed', (select count(*) from photo_rows where conf is not null)
    ),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'id', ev.id, 'title', ev.title, 'starts_at', ev.starts_at,
        'attended_records', ev.attended_records, 'applied_records', ev.applied_records,
        'anonymous_count', ev.anonymous_count, 'confirmed_headcount', ev.confirmed_headcount,
        'headcount', coalesce(ev.confirmed_headcount, ev.attended_records + ev.anonymous_count),
        'headcount_source', case when ev.confirmed_headcount is not null then 'staff_confirmed' else 'attendance_records' end,
        'photo_max_estimated', (select max(est) from photo_rows pr where pr.event_id = ev.id),
        'photo_max_confirmed', (select max(conf) from photo_rows pr where pr.event_id = ev.id)
      ) order by ev.starts_at desc) from ev), '[]')
  ) into res;
  return res;
end $$;

-- イベント参加人数の確定（写真人数は自動転記しない。スタッフが判断して入力する）
create or replace function public.confirm_event_headcount(event uuid, headcount int) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.events;
begin
  select * into e from public.events where id = event;
  if e.id is null then raise exception 'not_found'; end if;
  perform public.require_role(e.organization_id, 'editor');
  if headcount is not null and headcount < 0 then raise exception 'invalid_headcount'; end if;
  update public.events set confirmed_headcount = headcount,
    headcount_confirmed_by = case when headcount is null then null else auth.uid() end,
    headcount_confirmed_at = case when headcount is null then null else now() end
    where id = event;
  perform public.audit(e.organization_id, 'event.confirm_headcount', 'event', event::text,
                       jsonb_build_object('from', e.confirmed_headcount, 'to', headcount));
end $$;

-- 日次集計（全団体）
create or replace function public.refresh_daily_metrics(target_day date default (now() at time zone 'Asia/Tokyo')::date - 1)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare
  n int;
  day_start timestamptz := (target_day::timestamp at time zone 'Asia/Tokyo');
  day_end timestamptz := ((target_day + 1)::timestamp at time zone 'Asia/Tokyo');
begin
  insert into public.daily_metrics (organization_id, day, people_total, people_new, events_held,
                                    attended_participations, unique_attendees, anonymous_attendees, photo_analyses)
  select o.id, target_day,
    (select count(*) from public.people p where p.organization_id = o.id and p.created_at < day_end),
    (select count(*) from public.people p where p.organization_id = o.id and p.created_at >= day_start and p.created_at < day_end),
    (select count(*) from public.events e where e.organization_id = o.id and e.starts_at >= day_start and e.starts_at < day_end),
    (select count(*) from public.event_participations ep join public.events e on e.id = ep.event_id
      where ep.organization_id = o.id and ep.status = 'attended' and e.starts_at >= day_start and e.starts_at < day_end),
    (select count(distinct ep.person_id) from public.event_participations ep join public.events e on e.id = ep.event_id
      where ep.organization_id = o.id and ep.status = 'attended' and e.starts_at >= day_start and e.starts_at < day_end),
    (select coalesce(sum(anonymous_count), 0) from public.events e where e.organization_id = o.id and e.starts_at >= day_start and e.starts_at < day_end),
    (select count(*) from public.photo_analysis_results r where r.organization_id = o.id and r.analyzed_at >= day_start and r.analyzed_at < day_end)
  from public.organizations o
  where o.status <> 'cancelled'
  on conflict (organization_id, day) do update set
    people_total = excluded.people_total, people_new = excluded.people_new, events_held = excluded.events_held,
    attended_participations = excluded.attended_participations, unique_attendees = excluded.unique_attendees,
    anonymous_attendees = excluded.anonymous_attendees, photo_analyses = excluded.photo_analyses, computed_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- 上限で保留された回答を再処理（上限を上げた後など）
create or replace function public.retry_held_submissions(org uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  n int;
  b record;
begin
  perform public.require_role(org, 'editor');
  update public.form_submissions set error = null
    where organization_id = org and status = 'pending' and error is not null;
  get diagnostics n = row_count;
  for b in select distinct batch_id from public.form_submissions
           where organization_id = org and status = 'pending' and batch_id is not null loop
    update public.import_batches set status = 'processing', finished_at = null where id = b.batch_id;
    perform public.enqueue_job(org, 'process_submissions', b.batch_id, jsonb_build_object('batch_id', b.batch_id));
  end loop;
  for b in select id from public.form_submissions
           where organization_id = org and status = 'pending' and batch_id is null loop
    perform public.enqueue_job(org, 'process_submissions', b.id, jsonb_build_object('submission_id', b.id));
  end loop;
  return null;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'complete_photo_upload(uuid, uuid, bigint, text)',
    'worker_save_photo_result(uuid, int, jsonb, text, text, text, numeric)',
    'worker_expired_photos(int)', 'worker_mark_photo_removed(uuid, text)',
    'release_expired_reservations()', 'refresh_daily_metrics(date)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 定期実行（Supabase Cron）
-- ワーカー（Edge Function）の起動先URLと秘密は Vault の project_url / worker_secret に登録する。
-- ------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_worker() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  url text;
  secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'worker_secret';
  if url is null or secret is null then return; end if;
  perform net.http_post(
    url := url || '/functions/v1/process-jobs',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 1000);
end $$;
revoke execute on function public.invoke_worker() from public, anon, authenticated;

select cron.schedule('npo-crm-worker', '* * * * *', 'select public.invoke_worker()');
select cron.schedule('npo-crm-release-reservations', '*/10 * * * *', 'select public.release_expired_reservations()');
select cron.schedule('npo-crm-daily-metrics', '15 15 * * *', 'select public.refresh_daily_metrics()');
-- 処理済みキューメッセージ・古い試行記録の整理（保存期間：90日）
select cron.schedule('npo-crm-purge-history', '30 16 * * *', $$
  delete from pgmq.a_jobs where archived_at < now() - interval '90 days';
  delete from public.job_attempts where started_at < now() - interval '90 days';
  delete from public.audit_logs where created_at < now() - interval '3 years';
$$);
