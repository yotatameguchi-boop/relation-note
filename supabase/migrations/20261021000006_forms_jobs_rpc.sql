-- フォーム取り込み（§4.2, §11.1）とジョブ処理（§11.3）

-- ------------------------------------------------------------
-- ジョブ登録：ジョブ行とキューメッセージを同一トランザクションで保存する
-- ------------------------------------------------------------
create or replace function public.enqueue_job(org uuid, job_kind text, target uuid, job_payload jsonb, delay_seconds int default 0)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  jid uuid;
  mid bigint;
begin
  insert into public.jobs (organization_id, kind, target_id, payload, created_by)
    values (org, job_kind, target, coalesce(job_payload, '{}'), auth.uid())
    returning id into jid;
  select pgmq.send('jobs', jsonb_build_object('job_id', jid), delay_seconds) into mid;
  update public.jobs set msg_id = mid where id = jid;
  return jid;
end $$;
revoke execute on function public.enqueue_job(uuid, text, uuid, jsonb, int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- フォーム接続
-- ------------------------------------------------------------
create or replace function public.rotate_webhook_secret(conn uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  org uuid;
  raw text := 'whsec_' || encode(gen_random_bytes(24), 'hex');
begin
  select organization_id into org from public.form_connections where id = conn and kind = 'webhook';
  if org is null then raise exception 'not_found'; end if;
  perform public.require_role(org, 'admin');
  insert into public.form_connection_secrets (connection_id, secret_hash)
    values (conn, encode(digest(raw, 'sha256'), 'hex'))
    on conflict (connection_id) do update set secret_hash = excluded.secret_hash, created_at = now();
  perform public.audit(org, 'form_connection.rotate_secret', 'form_connection', conn::text);
  return raw;
end $$;

-- ------------------------------------------------------------
-- CSV 取り込み：バッチ作成 → 行の追加（分割送信可）→ 開始
-- ------------------------------------------------------------
create or replace function public.create_import_batch(conn uuid, file_name text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.form_connections;
  bid uuid;
begin
  select * into c from public.form_connections where id = conn;
  if c.id is null then raise exception 'not_found'; end if;
  perform public.require_role(c.organization_id, 'editor');
  insert into public.import_batches (organization_id, connection_id, source, filename, created_by)
    values (c.organization_id, conn, 'csv', file_name, auth.uid()) returning id into bid;
  return bid;
end $$;

-- rows: [{ "raw": {...}, "dedupe_key": "...", "external_id": "..." }]
create or replace function public.append_import_rows(batch uuid, rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  b public.import_batches;
  inserted int;
  total int := jsonb_array_length(rows);
begin
  select * into b from public.import_batches where id = batch for update;
  if b.id is null then raise exception 'not_found'; end if;
  perform public.require_role(b.organization_id, 'editor');
  if b.status <> 'queued' then raise exception 'batch_already_started'; end if;
  if total > 2000 then raise exception 'too_many_rows' using hint = '1回の送信は2000行までです。'; end if;

  with ins as (
    insert into public.form_submissions (organization_id, connection_id, batch_id, dedupe_key, external_id, raw, source)
    select b.organization_id, b.connection_id, b.id,
           coalesce(nullif(r->>'dedupe_key', ''), encode(digest((r->'raw')::text, 'sha256'), 'hex')),
           nullif(r->>'external_id', ''), r->'raw', 'csv'
    from jsonb_array_elements(rows) r
    on conflict (connection_id, dedupe_key) do nothing
    returning 1
  ) select count(*) into inserted from ins;

  update public.import_batches set total_rows = total_rows + total, duplicate_rows = duplicate_rows + (total - inserted)
    where id = b.id;
  return jsonb_build_object('received', total, 'inserted', inserted, 'duplicates', total - inserted);
end $$;

create or replace function public.start_import_batch(batch uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  b public.import_batches;
  jid uuid;
begin
  select * into b from public.import_batches where id = batch for update;
  if b.id is null then raise exception 'not_found'; end if;
  perform public.require_role(b.organization_id, 'editor');
  if b.status <> 'queued' then raise exception 'batch_already_started'; end if;
  update public.import_batches set status = 'processing' where id = b.id;
  jid := public.enqueue_job(b.organization_id, 'process_submissions', b.id, jsonb_build_object('batch_id', b.id));
  perform public.audit(b.organization_id, 'import.start', 'import_batch', b.id::text,
                       jsonb_build_object('filename', b.filename, 'rows', b.total_rows));
  return jid;
end $$;

-- 外部フォームからの受信（サーバーが送信元を認証したあとにサービスロールで呼ぶ）
create or replace function public.ingest_webhook_submission(conn uuid, secret text, ext_id text, payload jsonb, sent_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.form_connections;
  sid uuid;
  key text;
begin
  select * into c from public.form_connections where id = conn and kind = 'webhook' and is_active;
  if c.id is null then raise exception 'not_found'; end if;
  if not exists (select 1 from public.form_connection_secrets s
                 where s.connection_id = conn and s.secret_hash = encode(digest(secret, 'sha256'), 'hex')) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  key := coalesce(nullif(ext_id, ''), encode(digest(payload::text, 'sha256'), 'hex'));
  insert into public.form_submissions (organization_id, connection_id, dedupe_key, external_id, raw, source, submitted_at)
    values (c.organization_id, conn, key, nullif(ext_id, ''), payload, 'webhook', sent_at)
    on conflict (connection_id, dedupe_key) do nothing
    returning id into sid;
  if sid is null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  perform public.enqueue_job(c.organization_id, 'process_submissions', sid, jsonb_build_object('submission_id', sid));
  return jsonb_build_object('status', 'accepted', 'submission_id', sid);
end $$;
revoke execute on function public.ingest_webhook_submission(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 回答の変換と名寄せ
-- ------------------------------------------------------------
-- 回答原文を共通項目に変換する
create or replace function public.map_submission(raw jsonb, mapping jsonb) returns jsonb
language plpgsql immutable as $$
declare
  k text;
  target text;
  val text;
  out jsonb := jsonb_build_object('attributes', '{}'::jsonb, 'emails', '[]'::jsonb, 'phones', '[]'::jsonb, 'tags', '[]'::jsonb);
begin
  for k, target in select key, value #>> '{}' from jsonb_each(coalesce(mapping, '{}')) loop
    val := nullif(btrim(raw ->> k), '');
    continue when val is null or target is null or target = 'ignore';
    if target = 'email' then
      out := jsonb_set(out, '{emails}', (out->'emails') || to_jsonb(val));
    elsif target = 'phone' then
      out := jsonb_set(out, '{phones}', (out->'phones') || to_jsonb(val));
    elsif target = 'tags' then
      out := jsonb_set(out, '{tags}', (out->'tags') || coalesce((
        select jsonb_agg(btrim(t)) from regexp_split_to_table(val, '[,、;；/／]') t where btrim(t) <> ''), '[]'));
    elsif target like 'attr:%' then
      out := jsonb_set(out, array['attributes', substr(target, 6)], to_jsonb(val));
    elsif target in ('full_name', 'full_name_kana', 'region', 'note', 'external_id', 'submitted_at') then
      out := out || jsonb_build_object(target, val);
    end if;
  end loop;
  return out;
end $$;

-- 既存人物に回答の情報を足す（空欄の補完と連絡先・タグの追加のみ。上書きしない）
create or replace function public.attach_submission_to_person(sub public.form_submissions, m jsonb, pid uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v text;
  c public.form_connections;
  tid uuid;
begin
  select * into c from public.form_connections where id = sub.connection_id;
  update public.people set
    full_name_kana = coalesce(full_name_kana, m->>'full_name_kana'),
    region = coalesce(region, m->>'region'),
    attributes = coalesce(m->'attributes', '{}') || attributes
  where organization_id = sub.organization_id and id = pid;
  for v in select jsonb_array_elements_text(m->'emails') loop
    if public.normalize_email(v) is not null then
      insert into public.person_contacts (organization_id, person_id, kind, value, label)
        values (sub.organization_id, pid, 'email', v, c.name) on conflict do nothing;
    end if;
  end loop;
  for v in select jsonb_array_elements_text(m->'phones') loop
    if public.normalize_phone(v) is not null then
      insert into public.person_contacts (organization_id, person_id, kind, value, label)
        values (sub.organization_id, pid, 'phone', v, c.name) on conflict do nothing;
    end if;
  end loop;
  -- 回答に含まれるタグ名（未作成なら作る）と接続の既定タグ
  for v in select jsonb_array_elements_text(m->'tags') loop
    insert into public.tags (organization_id, name) values (sub.organization_id, left(v, 60))
      on conflict (organization_id, name) do update set name = excluded.name returning id into tid;
    insert into public.person_tags (organization_id, person_id, tag_id) values (sub.organization_id, pid, tid) on conflict do nothing;
  end loop;
  insert into public.person_tags (organization_id, person_id, tag_id)
    select sub.organization_id, pid, t.id from public.tags t
    where t.organization_id = sub.organization_id and t.id = any(c.default_tag_ids)
    on conflict do nothing;
  if c.event_id is not null then
    insert into public.event_participations (organization_id, event_id, person_id, status, submission_id)
      values (sub.organization_id, c.event_id, pid, 'applied', sub.id)
      on conflict (event_id, person_id) do nothing;
  end if;
end $$;
revoke execute on function public.attach_submission_to_person(public.form_submissions, jsonb, uuid) from public, anon, authenticated;

-- 1件の回答を処理する。
--   * メール or 電話が一致し、氏名も一致する人物が1人 → 紐づけ
--   * メール・電話は一致するが氏名が違う（家族で共有など）→ 確認待ち
--   * 氏名だけ一致 → 確認待ち（氏名だけでは自動統合しない）
--   * 一致なし → 新規作成
create or replace function public.apply_submission(sub_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  sub public.form_submissions;
  c public.form_connections;
  m jsonb;
  nkey text;
  emails text[];
  phones text[];
  contact_hits uuid[];
  same_name_hits uuid[];
  name_hits uuid[];
  pid uuid;
  result text;
  err_detail text;
begin
  select * into sub from public.form_submissions where id = sub_id for update;
  if sub.id is null or sub.status <> 'pending' then return coalesce(sub.status, 'missing'); end if;
  select * into c from public.form_connections where id = sub.connection_id;
  m := public.map_submission(sub.raw, c.field_mapping);

  begin
    if nullif(m->>'full_name', '') is null then
      raise exception using message = 'missing_name', detail = '氏名の列が空、または対応設定がありません';
    end if;
    if char_length(m->>'full_name') > 200 then
      raise exception using message = 'invalid_name', detail = '氏名が長すぎます';
    end if;
    select coalesce(array_agg(public.normalize_email(e)) filter (where public.normalize_email(e) is not null), '{}')
      into emails from jsonb_array_elements_text(m->'emails') e;
    if exists (select 1 from unnest(emails) e where e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
      raise exception using message = 'invalid_email', detail = 'メールアドレスの形式が正しくありません';
    end if;
    select coalesce(array_agg(public.normalize_phone(p)) filter (where public.normalize_phone(p) is not null), '{}')
      into phones from jsonb_array_elements_text(m->'phones') p;
    nkey := public.normalize_name(m->>'full_name');

    select coalesce(array_agg(distinct pc.person_id), '{}') into contact_hits
      from public.person_contacts pc
      where pc.organization_id = sub.organization_id
        and ((pc.kind = 'email' and pc.normalized_value = any(emails))
          or (pc.kind = 'phone' and pc.normalized_value = any(phones)));
    select coalesce(array_agg(id), '{}') into same_name_hits
      from public.people where organization_id = sub.organization_id and id = any(contact_hits) and name_key = nkey;
    select coalesce(array_agg(id), '{}') into name_hits
      from (select id from public.people where organization_id = sub.organization_id and name_key = nkey limit 20) x;

    if cardinality(same_name_hits) = 1 then
      pid := same_name_hits[1];
      perform public.attach_submission_to_person(sub, m, pid);
      update public.form_submissions set status = 'linked', person_id = pid, match_reason = 'contact_and_name',
        submitted_at = coalesce(submitted_at, (m->>'submitted_at')::timestamptz), processed_at = now(), error = null
        where id = sub.id;
      result := 'linked';
    elsif cardinality(contact_hits) > 0 or cardinality(name_hits) > 0 then
      update public.form_submissions set status = 'needs_review',
        match_reason = case when cardinality(same_name_hits) > 1 then 'multiple_matches'
                            when cardinality(contact_hits) > 0 then 'contact_only'
                            else 'name_only' end,
        candidate_person_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(contact_hits || name_hits) x),
        processed_at = now(), error = null
        where id = sub.id;
      result := 'needs_review';
    else
      insert into public.people (organization_id, full_name, full_name_kana, region, first_seen_at)
        values (sub.organization_id, m->>'full_name', m->>'full_name_kana', m->>'region',
                coalesce((m->>'submitted_at')::timestamptz, sub.submitted_at, sub.received_at))
        returning id into pid;
      perform public.attach_submission_to_person(sub, m, pid);
      update public.form_submissions set status = 'created', person_id = pid, match_reason = 'new',
        submitted_at = coalesce(submitted_at, (m->>'submitted_at')::timestamptz), processed_at = now(), error = null
        where id = sub.id;
      result := 'created';
    end if;
  exception
    when others then
      if sqlerrm like 'quota_exceeded%' then
        -- 上限到達時は保留（あとで再処理できる）
        update public.form_submissions set error = '登録人物数の上限に達したため保留中です', processed_at = now() where id = sub.id;
        return 'quota_exceeded';
      end if;
      get stacked diagnostics err_detail = pg_exception_detail;
      update public.form_submissions set status = 'error',
        error = case when sqlerrm in ('missing_name', 'invalid_name', 'invalid_email') then err_detail
                     else '処理できませんでした: ' || sqlerrm end,
        processed_at = now()
        where id = sub.id;
      return 'error';
  end;
  return result;
end $$;
revoke execute on function public.apply_submission(uuid) from public, anon, authenticated;

-- 確認待ちの回答をスタッフが解決する
create or replace function public.resolve_submission(sub_id uuid, action text, target_person uuid default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  sub public.form_submissions;
  c public.form_connections;
  m jsonb;
  pid uuid;
begin
  select * into sub from public.form_submissions where id = sub_id for update;
  if sub.id is null then raise exception 'not_found'; end if;
  perform public.require_role(sub.organization_id, 'editor');
  if sub.status not in ('needs_review', 'error', 'pending') then raise exception 'already_resolved'; end if;
  select * into c from public.form_connections where id = sub.connection_id;
  m := public.map_submission(sub.raw, c.field_mapping);

  if action = 'link' then
    if not exists (select 1 from public.people where organization_id = sub.organization_id and id = target_person) then
      raise exception 'not_found';
    end if;
    perform public.attach_submission_to_person(sub, m, target_person);
    update public.form_submissions set status = 'linked', person_id = target_person, match_reason = 'manual',
      resolved_by = auth.uid(), processed_at = now(), error = null where id = sub.id;
  elsif action = 'create' then
    if nullif(m->>'full_name', '') is null then raise exception 'missing_name'; end if;
    insert into public.people (organization_id, full_name, full_name_kana, region, created_by)
      values (sub.organization_id, m->>'full_name', m->>'full_name_kana', m->>'region', auth.uid()) returning id into pid;
    perform public.attach_submission_to_person(sub, m, pid);
    update public.form_submissions set status = 'created', person_id = pid, match_reason = 'manual',
      resolved_by = auth.uid(), processed_at = now(), error = null where id = sub.id;
  elsif action = 'ignore' then
    update public.form_submissions set status = 'ignored', resolved_by = auth.uid(), processed_at = now() where id = sub.id;
  elsif action = 'retry' then
    update public.form_submissions set status = 'pending', error = null where id = sub.id;
    perform public.apply_submission(sub.id);
  else
    raise exception 'invalid_action';
  end if;
  perform public.audit(sub.organization_id, 'submission.resolve', 'form_submission', sub.id::text,
                       jsonb_build_object('action', action, 'person_id', coalesce(target_person, pid)));
end $$;

create or replace function public.import_batch_summary(batch uuid) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select jsonb_build_object(
    'batch', to_jsonb(b),
    'counts', coalesce((select jsonb_object_agg(status, n) from (
       select status, count(*) n from public.form_submissions s where s.batch_id = b.id group by status) x), '{}'),
    'held', (select count(*) from public.form_submissions s where s.batch_id = b.id and s.status = 'pending' and s.error is not null)
  )
  from public.import_batches b where b.id = batch
$$;

-- ------------------------------------------------------------
-- ワーカー用（サービスロール専用）
-- ------------------------------------------------------------
-- メッセージを受け取り、団体ごとの同時実行上限を守ってジョブを開始する
create or replace function public.worker_claim(batch_size int default 5, visibility_seconds int default 120)
returns table (msg_id bigint, job_id uuid, kind text, organization_id uuid, target_id uuid, payload jsonb, attempt int)
language plpgsql security definer set search_path = public, extensions as $$
declare
  msg record;
  j public.jobs;
  running int;
  lim int;
begin
  for msg in select * from pgmq.read('jobs', visibility_seconds, batch_size) loop
    select * into j from public.jobs where id = (msg.message->>'job_id')::uuid for update;
    if j.id is null or j.status in ('succeeded', 'dead', 'cancelled') then
      perform pgmq.archive('jobs', msg.msg_id);
      continue;
    end if;
    select p.max_concurrent_jobs into lim from public.organizations o join public.plans p on p.id = o.plan_id
      where o.id = j.organization_id;
    select count(*) into running from public.jobs x
      where x.organization_id = j.organization_id and x.status = 'running' and x.id <> j.id and x.locked_until > now();
    if running >= coalesce(lim, 3) then
      -- 特定団体の大量処理で他団体を待たせないよう、上限超過分は後回しにする
      perform pgmq.set_vt('jobs', msg.msg_id, 15);
      continue;
    end if;
    -- 前回の試行が終わらずに消えた場合
    update public.job_attempts set finished_at = now(), outcome = 'abandoned'
      where job_attempts.job_id = j.id and finished_at is null;
    update public.jobs set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()),
      locked_until = now() + make_interval(secs => visibility_seconds), msg_id = msg.msg_id
      where id = j.id returning * into j;
    -- 分割処理で次回に回した分は jobs.attempts に数えないので、試行番号は記録の続き番号にする
    insert into public.job_attempts (organization_id, job_id, attempt_no)
      values (j.organization_id, j.id,
              (select coalesce(max(attempt_no), 0) + 1 from public.job_attempts where job_attempts.job_id = j.id));
    if j.kind = 'photo_analysis' then
      update public.photos set status = 'analyzing' where id = j.target_id and photos.organization_id = j.organization_id;
    end if;
    msg_id := msg.msg_id; job_id := j.id; kind := j.kind; organization_id := j.organization_id;
    target_id := j.target_id; payload := j.payload; attempt := j.attempts;
    return next;
  end loop;
end $$;

create or replace function public.worker_note_external_call(job uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update public.job_attempts set external_calls = external_calls + 1
  where id = (select id from public.job_attempts where job_id = job order by attempt_no desc limit 1);
$$;

create or replace function public.worker_complete(job uuid, msg bigint, job_result jsonb default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.jobs set status = 'succeeded', finished_at = now(), result = job_result, last_error = null, locked_until = null
    where id = job;
  update public.job_attempts set finished_at = now(), outcome = 'succeeded'
    where job_id = job and finished_at is null;
  perform pgmq.archive('jobs', msg);
end $$;

-- 分割処理：まだ残りがある場合、失敗扱いにせず次回に回す
create or replace function public.worker_requeue(job uuid, msg bigint, progress jsonb default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.jobs set status = 'queued', attempts = greatest(attempts - 1, 0), result = progress, locked_until = null
    where id = job;
  update public.job_attempts set finished_at = now(), outcome = 'requeued' where job_id = job and finished_at is null;
  perform pgmq.set_vt('jobs', msg, 0);
end $$;

create or replace function public.worker_fail(job uuid, msg bigint, err text, retryable boolean default true) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
begin
  select * into j from public.jobs where id = job for update;
  update public.job_attempts set finished_at = now(), outcome = 'failed', error = left(err, 2000)
    where job_id = job and finished_at is null;
  if not retryable or j.attempts >= j.max_attempts then
    -- 継続して失敗するジョブは隔離（dead）。確認後に retry_job で再実行する。
    update public.jobs set status = 'dead', last_error = left(err, 2000), finished_at = now(), locked_until = null where id = job;
    perform pgmq.archive('jobs', msg);
    if j.kind = 'photo_analysis' then
      update public.photos set status = 'failed', failure_reason = left(err, 500)
        where id = j.target_id and organization_id = j.organization_id;
      -- 結果が出なかった解析は利用枠に計上しない
      update public.usage_records set status = 'released', released_at = now()
        where idempotency_key = 'photo_analysis:' || j.target_id and status = 'reserved';
    elsif j.kind = 'process_submissions' and j.payload ? 'batch_id' then
      update public.import_batches set status = 'failed', finished_at = now() where id = (j.payload->>'batch_id')::uuid;
    end if;
    return 'dead';
  end if;
  update public.jobs set status = 'queued', last_error = left(err, 2000), locked_until = null where id = job;
  -- 指数バックオフ（30秒, 60秒, 120秒…最大30分）
  perform pgmq.set_vt('jobs', msg, least(30 * power(2, greatest(j.attempts - 1, 0))::int, 1800));
  return 'retry';
end $$;

-- 回答をまとめて処理する（分割処理の1単位）
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

-- 隔離されたジョブを再実行（管理者）
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
    -- 再解析にも利用枠を予約
    perform public.reserve_photo_analysis(j.organization_id, j.target_id);
    update public.photos set status = 'queued', failure_reason = null where id = j.target_id;
  elsif j.kind = 'process_submissions' and j.payload ? 'batch_id' then
    update public.import_batches set status = 'processing', finished_at = null where id = (j.payload->>'batch_id')::uuid;
  end if;
  select pgmq.send('jobs', jsonb_build_object('job_id', j.id)) into mid;
  update public.jobs set status = 'queued', attempts = 0, msg_id = mid, finished_at = null where id = j.id;
  perform public.audit(j.organization_id, 'job.retry', 'job', j.id::text, jsonb_build_object('kind', j.kind));
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'worker_claim(int, int)', 'worker_note_external_call(uuid)', 'worker_complete(uuid, bigint, jsonb)',
    'worker_requeue(uuid, bigint, jsonb)', 'worker_fail(uuid, bigint, text, boolean)',
    'worker_process_submissions(uuid, int)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
grant execute on function public.ingest_webhook_submission(uuid, text, text, jsonb, timestamptz) to service_role;
