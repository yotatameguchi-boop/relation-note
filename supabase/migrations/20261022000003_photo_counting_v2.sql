-- 写真の人数カウント強化
--   既存の photo_analysis_results を「解析ラン（版）」として拡張し、検出枠・利用回数・イベント人数の記録を追加する。
--   * 推定値（解析ラン）と人が確定した値（photo_reviews）は別に保存する。再解析しても確定値は上書きしない。
--   * 写真ファイルの重複（ハッシュ）と、人物の重複判定は別物として扱う。
--   * 利用者向けの解析枚数（usage_records）と、外部APIの呼び出し回数（analysis_usage_records）は別に記録する。

-- ------------------------------------------------------------
-- 写真：検証結果・解析用画像・ハッシュ
-- ------------------------------------------------------------
alter table public.photos
  add column content_sha256 text,
  add column width integer,                -- 回転補正後（正立）の幅
  add column height integer,
  add column exif_orientation smallint,
  add column analysis_path text,           -- 解析用画像（正立・メタデータ除去・縮小済み）
  add column analysis_meta jsonb,          -- 座標変換・領域分割・画像統計
  add column duplicate_of uuid;            -- 同じファイルが既にある場合、その写真（写真ファイルの重複であり、人物の重複ではない）
create index photos_hash_idx on public.photos(organization_id, content_sha256);

-- ------------------------------------------------------------
-- 解析ラン（＝photo_analysis_results の拡張）
-- ------------------------------------------------------------
alter table public.photo_analysis_results
  add column version_no integer,
  add column pipeline text not null default 'v1' check (pipeline in ('v1', 'v2')),
  add column settings jsonb not null default '{}',     -- しきい値・重複抑制・領域分割の設定
  add column raw_detection_count integer,               -- 整理前の検出数（参考）
  add column duration_ms integer,
  add column provider_calls integer not null default 0,
  add column tiles_used integer not null default 0,
  add column review_reasons text[] not null default '{}';

update public.photo_analysis_results r set version_no = x.n
  from (select id, row_number() over (partition by photo_id order by analyzed_at, id) n from public.photo_analysis_results) x
  where x.id = r.id;

-- 人物検出枠（座標は解析用画像＝正立画像に対する 0〜1 の比率）
create table public.photo_detections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  photo_id uuid not null,
  analysis_result_id uuid not null,
  idx integer not null,                     -- ラン内の番号
  x numeric not null, y numeric not null, w numeric not null, h numeric not null,
  score numeric,                            -- モデルのスコア（人数が正しい確率ではない）
  source text not null check (source in ('full', 'tile')),
  tile_index integer,
  status text not null check (status in ('kept', 'suppressed')),
  suppressed_reason text check (suppressed_reason in ('below_threshold', 'duplicate', 'tile_boundary_duplicate')),
  duplicate_of_idx integer,
  unique (analysis_result_id, idx),
  unique (organization_id, id),
  foreign key (organization_id, analysis_result_id) references public.photo_analysis_results(organization_id, id) on delete cascade,
  foreign key (organization_id, photo_id) references public.photos(organization_id, id) on delete cascade
);
create index photo_detections_result_idx on public.photo_detections(organization_id, analysis_result_id);

-- ------------------------------------------------------------
-- 人による修正・確定（＝photo_reviews の拡張）
-- ------------------------------------------------------------
alter table public.photo_reviews
  add column detected_count integer,        -- 確認時点の検出人数
  add column adjustments jsonb not null default '{}',  -- { removed: [検出ID], added: [{x,y,w,h}], moved: [{id,x,y,w,h}] }
  add column review_seconds integer;         -- 修正にかかった時間（評価用）

-- ------------------------------------------------------------
-- イベントの確定人数の記録（根拠つき）。events.confirmed_headcount は最新の値を保持する。
-- ------------------------------------------------------------
create table public.event_count_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  event_id uuid not null,
  headcount integer check (headcount >= 0),  -- null は確定の取り消し
  method text not null check (method in ('reception', 'manual_tally', 'photo_assisted', 'other', 'cleared')),
  basis text check (char_length(basis) <= 1000),
  photo_ids uuid[] not null default '{}',
  note text check (char_length(note) <= 1000),
  confirmed_by uuid references public.users(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  foreign key (organization_id, event_id) references public.events(organization_id, id) on delete cascade
);
create index event_count_records_event_idx on public.event_count_records(organization_id, event_id, confirmed_at desc);

-- ------------------------------------------------------------
-- 外部APIの呼び出し記録（試行単位）。利用者向けの解析枚数とは別。
-- ------------------------------------------------------------
create table public.analysis_usage_records (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  attempt_no integer not null,
  provider text not null,
  provider_calls integer not null default 0,
  billable_units integer not null default 0,   -- 例：Rekognition に送った画像数
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, attempt_no, provider),
  foreign key (organization_id, job_id) references public.jobs(organization_id, id) on delete cascade
);

-- ジョブの実行期限
alter table public.jobs add column deadline_at timestamptz not null default now() + interval '1 day';

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.photo_detections enable row level security;
alter table public.event_count_records enable row level security;
alter table public.analysis_usage_records enable row level security;
create policy photo_detections_read on public.photo_detections for select to authenticated using (public.is_member(organization_id));
create policy event_count_records_read on public.event_count_records for select to authenticated using (public.is_member(organization_id));
create policy analysis_usage_read on public.analysis_usage_records for select to authenticated using (public.has_role(organization_id, 'admin'));
do $$
declare t text;
begin
  foreach t in array array['photo_detections', 'event_count_records', 'analysis_usage_records'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.prevent_org_change()',
                   t || '_no_org_change', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- アップロード完了（v2）：実ファイルの検証結果・ハッシュ・解析用画像を保存してジョブ登録
-- サーバーが実ファイルを確認したあとにサービスロールで呼ぶ。
-- ------------------------------------------------------------
create or replace function public.complete_photo_upload_v2(
  photo uuid, org uuid, actual_size bigint, actual_mime text, sha256 text, p_width int, p_height int,
  p_orientation int, p_analysis_path text, p_analysis_meta jsonb
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  ph public.photos;
  dup uuid;
  jid uuid;
begin
  select * into ph from public.photos where id = photo for update;
  if ph.id is null or ph.organization_id <> org then raise exception 'not_found'; end if;
  if p_analysis_path is not null and split_part(p_analysis_path, '/', 1) <> org::text then raise exception 'tenant_mismatch'; end if;
  if ph.status <> 'uploading' then
    return jsonb_build_object('job_id', (select id from public.jobs where target_id = photo and kind = 'photo_analysis' order by created_at desc limit 1),
                              'duplicate_of', ph.duplicate_of);
  end if;
  if ph.upload_deadline < now() then raise exception 'upload_expired'; end if;
  if actual_mime is distinct from ph.mime_type or actual_size <> ph.size_bytes then
    raise exception 'upload_mismatch' using hint = '申告された形式・サイズと実ファイルが一致しません。';
  end if;
  select id into dup from public.photos
    where organization_id = org and content_sha256 = sha256 and id <> photo and status <> 'expired'
    order by created_at limit 1;
  update public.photos set status = 'queued', uploaded_at = now(), content_sha256 = sha256, width = p_width, height = p_height,
    exif_orientation = p_orientation, analysis_path = p_analysis_path, analysis_meta = p_analysis_meta, duplicate_of = dup
    where id = photo;
  update public.usage_records set status = 'committed', committed_at = now(), expires_at = null
    where idempotency_key = 'storage:photo:' || photo;
  update public.usage_records set expires_at = now() + interval '2 days'
    where idempotency_key = 'photo_analysis:' || photo and status = 'reserved';
  jid := public.enqueue_job(org, 'photo_analysis', photo, jsonb_build_object('photo_id', photo, 'path', ph.storage_path));
  update public.jobs set created_by = ph.uploaded_by, deadline_at = now() + interval '6 hours' where id = jid;
  return jsonb_build_object('job_id', jid, 'duplicate_of', dup);
end $$;

-- 外部APIの呼び出しを試行単位で記録（結果保存の前に呼ぶ。保存に失敗しても呼び出し回数は残る）
create or replace function public.worker_note_provider_calls(job uuid, p_provider text, calls int, units int) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  att int;
begin
  select * into j from public.jobs where id = job;
  select max(attempt_no) into att from public.job_attempts where job_id = job;
  update public.job_attempts set external_calls = external_calls + calls where job_id = job and attempt_no = att;
  insert into public.analysis_usage_records (organization_id, job_id, attempt_no, provider, provider_calls, billable_units)
    values (j.organization_id, job, coalesce(att, 0), p_provider, calls, units)
  on conflict (job_id, attempt_no, provider) do update
    set provider_calls = analysis_usage_records.provider_calls + excluded.provider_calls,
        billable_units = analysis_usage_records.billable_units + excluded.billable_units, updated_at = now();
end $$;

-- 旧版の記録関数も同じ表に残す
create or replace function public.worker_note_external_call(job uuid) returns void
language sql security definer set search_path = public, extensions as $$
  select public.worker_note_provider_calls(job, 'unknown', 1, 1);
$$;

-- 解析ランの保存（同じジョブを再実行しても、ラン・検出枠・利用量は重複しない）
create or replace function public.worker_save_analysis_run(job uuid, run jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  ph public.photos;
  rid uuid;
  ver int;
begin
  select * into j from public.jobs where id = job;
  if j.kind <> 'photo_analysis' then raise exception 'wrong_job_kind'; end if;
  select * into ph from public.photos where id = j.target_id for update;
  if ph.id is null or ph.organization_id <> j.organization_id
     or split_part(ph.storage_path, '/', 1) <> j.organization_id::text then
    raise exception 'tenant_mismatch';
  end if;
  select id into rid from public.photo_analysis_results where job_id = job;
  if rid is not null then return rid; end if;
  select coalesce(max(version_no), 0) + 1 into ver from public.photo_analysis_results where photo_id = ph.id;
  insert into public.photo_analysis_results (organization_id, photo_id, job_id, estimated_count, detections,
      model_provider, model_name, model_version, min_confidence, version_no, pipeline, settings,
      raw_detection_count, duration_ms, provider_calls, tiles_used, review_reasons)
    values (j.organization_id, ph.id, j.id, (run->>'estimated_count')::int, '[]',
      run->>'provider', run->>'model', run->>'model_version', (run->'settings'->>'min_score')::numeric, ver, 'v2',
      coalesce(run->'settings', '{}'), (run->>'raw_count')::int, (run->>'duration_ms')::int,
      coalesce((run->>'provider_calls')::int, 0), coalesce((run->>'tiles_used')::int, 0),
      coalesce((select array_agg(x) from jsonb_array_elements_text(run->'review_reasons') x), '{}'))
    returning id into rid;
  insert into public.photo_detections (organization_id, photo_id, analysis_result_id, idx, x, y, w, h, score, source,
                                       tile_index, status, suppressed_reason, duplicate_of_idx)
    select j.organization_id, ph.id, rid, (d.ord - 1)::int,
           (d.v->>'x')::numeric, (d.v->>'y')::numeric, (d.v->>'w')::numeric, (d.v->>'h')::numeric, (d.v->>'score')::numeric,
           coalesce(d.v->>'source', 'full'), (d.v->>'tile')::int, d.v->>'status', d.v->>'reason', (d.v->>'dup_of')::int
    from jsonb_array_elements(coalesce(run->'detections', '[]')) with ordinality d(v, ord);
  if (select count(*) from public.photo_detections where analysis_result_id = rid and status = 'kept') <> (run->>'estimated_count')::int then
    raise exception 'count_mismatch';
  end if;
  update public.photos set status = 'analyzed', failure_reason = null where id = ph.id;
  update public.usage_records set status = 'committed', committed_at = coalesce(committed_at, now()), expires_at = null
    where idempotency_key = 'photo_analysis:' || ph.id and status in ('reserved', 'committed');
  return rid;
end $$;

-- ------------------------------------------------------------
-- 人による修正・確定
-- ------------------------------------------------------------
create or replace function public.submit_photo_count_review(photo uuid, result_id uuid, removed uuid[], added jsonb,
                                                            moved jsonb, p_confirmed int, p_note text, p_seconds int default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  ph public.photos;
  r public.photo_analysis_results;
  kept int;
  rid uuid;
  b jsonb;
begin
  select * into ph from public.photos where id = photo;
  if ph.id is null then raise exception 'not_found'; end if;
  perform public.require_role(ph.organization_id, 'editor');
  select * into r from public.photo_analysis_results where id = result_id and photo_id = photo and organization_id = ph.organization_id;
  if r.id is null then raise exception 'not_found'; end if;
  -- 削除・移動の対象は、このランの検出枠に限る
  if exists (select 1 from unnest(coalesce(removed, '{}')) x
             where not exists (select 1 from public.photo_detections d where d.id = x and d.analysis_result_id = r.id)) then
    raise exception 'invalid_adjustment';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(moved, '[]')) m
             where not exists (select 1 from public.photo_detections d where d.id = (m->>'id')::uuid and d.analysis_result_id = r.id)) then
    raise exception 'invalid_adjustment';
  end if;
  for b in select * from jsonb_array_elements(coalesce(added, '[]') || coalesce(moved, '[]')) loop
    if (b->>'x')::numeric not between 0 and 1 or (b->>'y')::numeric not between 0 and 1
       or (b->>'w')::numeric not between 0 and 1 or (b->>'h')::numeric not between 0 and 1 then
      raise exception 'invalid_adjustment';
    end if;
  end loop;
  if p_confirmed is null or p_confirmed < 0 or p_confirmed > 10000 then raise exception 'invalid_count'; end if;
  select count(*) into kept from public.photo_detections where analysis_result_id = r.id and status = 'kept';
  if r.pipeline = 'v1' then kept := r.estimated_count; end if;
  insert into public.photo_reviews (organization_id, photo_id, analysis_result_id, confirmed_count, note, reviewed_by,
                                    detected_count, adjustments, review_seconds)
    values (ph.organization_id, photo, r.id, p_confirmed, nullif(btrim(p_note), ''), auth.uid(), kept,
            jsonb_build_object('removed', to_jsonb(coalesce(removed, '{}')), 'added', coalesce(added, '[]'), 'moved', coalesce(moved, '[]')),
            case when p_seconds between 0 and 86400 then p_seconds end)
    returning id into rid;
  return rid;
end $$;

-- ------------------------------------------------------------
-- イベント人数の確定（根拠つき）。写真の人数は自動転記しない。
-- ------------------------------------------------------------
drop function public.confirm_event_headcount(uuid, int);
create or replace function public.confirm_event_headcount(event uuid, headcount int, p_method text default 'manual_tally',
                                                          p_basis text default null, p_note text default null,
                                                          p_photo_ids uuid[] default '{}')
returns void language plpgsql security definer set search_path = public, extensions as $$
declare e public.events;
begin
  select * into e from public.events where id = event;
  if e.id is null then raise exception 'not_found'; end if;
  perform public.require_role(e.organization_id, 'editor');
  if headcount is not null and headcount < 0 then raise exception 'invalid_headcount'; end if;
  if headcount is not null and p_method not in ('reception', 'manual_tally', 'photo_assisted', 'other') then
    raise exception 'invalid_method';
  end if;
  if exists (select 1 from unnest(coalesce(p_photo_ids, '{}')) x
             where not exists (select 1 from public.photos p where p.id = x and p.organization_id = e.organization_id)) then
    raise exception 'not_found';
  end if;
  insert into public.event_count_records (organization_id, event_id, headcount, method, basis, photo_ids, note, confirmed_by)
    values (e.organization_id, e.id, headcount, case when headcount is null then 'cleared' else p_method end,
            nullif(btrim(p_basis), ''), coalesce(p_photo_ids, '{}'), nullif(btrim(p_note), ''), auth.uid());
  update public.events set confirmed_headcount = headcount,
    headcount_confirmed_by = case when headcount is null then null else auth.uid() end,
    headcount_confirmed_at = case when headcount is null then null else now() end
    where id = event;
  perform public.audit(e.organization_id, 'event.confirm_headcount', 'event', event::text,
                       jsonb_build_object('from', e.confirmed_headcount, 'to', headcount, 'method', p_method));
end $$;

-- ------------------------------------------------------------
-- ワーカー：実行期限を過ぎたジョブは隔離する
-- ------------------------------------------------------------
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
    if j.deadline_at < now() then
      perform public.worker_fail(j.id, msg.msg_id, '実行期限を過ぎたため中止しました（deadline_exceeded）', false);
      continue;
    end if;
    select p.max_concurrent_jobs into lim from public.organizations o join public.plans p on p.id = o.plan_id
      where o.id = j.organization_id;
    select count(*) into running from public.jobs x
      where x.organization_id = j.organization_id and x.status = 'running' and x.id <> j.id and x.locked_until > now();
    if running >= coalesce(lim, 3) then
      perform pgmq.set_vt('jobs', msg.msg_id, 15);
      continue;
    end if;
    update public.job_attempts set finished_at = now(), outcome = 'abandoned'
      where job_attempts.job_id = j.id and finished_at is null;
    update public.jobs set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()),
      locked_until = now() + make_interval(secs => visibility_seconds), msg_id = msg.msg_id
      where id = j.id returning * into j;
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

-- 再解析・再実行のジョブにも期限を付け直す
create or replace function public.trg_job_deadline() returns trigger language plpgsql as $$
begin
  if new.status = 'queued' and old.status = 'dead' then new.deadline_at := now() + interval '1 day'; end if;
  return new;
end $$;
create trigger jobs_deadline_reset before update on public.jobs for each row execute function public.trg_job_deadline();

-- 期限切れ写真の削除対象に、解析用画像・分割画像も含める
drop function public.worker_expired_photos(int);
create or replace function public.worker_expired_photos(max_rows int default 100)
returns table (photo_id uuid, storage_path text, reason text, extra_paths text[])
language sql security definer set search_path = public, extensions as $$
  select id, storage_path, r, coalesce(array_remove(array[analysis_path], null), '{}')
      || coalesce((select array_agg(t->>'path') from jsonb_array_elements(coalesce(analysis_meta->'tiles', '[]')) t), '{}')
  from (
    select p.*, 'upload_timeout' r from public.photos p where p.status = 'uploading' and p.upload_deadline < now() - interval '5 minutes'
    union all
    select p.*, 'retention' from public.photos p where p.status not in ('uploading', 'expired') and p.expires_at < now()
  ) x
  limit max_rows
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'complete_photo_upload_v2(uuid, uuid, bigint, text, text, int, int, int, text, jsonb)',
    'worker_note_provider_calls(uuid, text, int, int)', 'worker_save_analysis_run(uuid, jsonb)',
    'worker_claim(int, int)', 'worker_expired_photos(int)', 'worker_note_external_call(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- 旧版の保存処理でも版番号を振る
create or replace function public.trg_analysis_version() returns trigger language plpgsql as $$
begin
  if new.version_no is null then
    select coalesce(max(version_no), 0) + 1 into new.version_no from public.photo_analysis_results where photo_id = new.photo_id;
  end if;
  return new;
end $$;
create trigger photo_analysis_results_version before insert on public.photo_analysis_results
  for each row execute function public.trg_analysis_version();
