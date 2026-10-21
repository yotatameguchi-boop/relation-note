-- 基本設計書 §4.4 写真、§11.3 非同期処理、§2.3 利用枠、§12 日次集計

create extension if not exists pgmq;

select pgmq.create('jobs');

-- ------------------------------------------------------------
-- 写真
-- ------------------------------------------------------------
create table public.photos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid,
  storage_path text not null unique,
  original_filename text,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint not null check (size_bytes > 0),
  status text not null default 'uploading'
    check (status in ('uploading', 'queued', 'analyzing', 'analyzed', 'failed', 'expired')),
  failure_reason text,
  uploaded_by uuid references public.users(id) on delete set null,
  upload_deadline timestamptz not null default now() + interval '30 minutes',
  uploaded_at timestamptz,
  expires_at timestamptz not null,           -- 保存期限
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, event_id) references public.events(organization_id, id) on delete set null (event_id)
);
create index photos_org_idx on public.photos(organization_id, created_at desc);
create index photos_event_idx on public.photos(organization_id, event_id);

-- ------------------------------------------------------------
-- ジョブ（処理要求の状態）。キュー本体は pgmq の jobs キュー。
-- ------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('process_submissions', 'photo_analysis', 'export_people')),
  target_id uuid,
  payload jsonb not null default '{}',
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  result jsonb,
  msg_id bigint,
  locked_until timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (organization_id, id)
);
create index jobs_org_idx on public.jobs(organization_id, created_at desc);
create index jobs_running_idx on public.jobs(organization_id) where status = 'running';
-- 同じ写真の解析ジョブを二重に積まない
create unique index jobs_photo_once_idx on public.jobs(target_id)
  where kind = 'photo_analysis' and status in ('queued', 'running');

-- 試行単位の記録（外部APIの呼び出し回数・費用の追跡用）
create table public.job_attempts (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  job_id uuid not null,
  attempt_no integer not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('succeeded', 'failed', 'requeued', 'abandoned')),
  error text,
  external_calls integer not null default 0,
  foreign key (organization_id, job_id) references public.jobs(organization_id, id) on delete cascade,
  unique (job_id, attempt_no)
);

-- ------------------------------------------------------------
-- 解析結果と確定値（推定値と確定値は分離して保存）
-- ------------------------------------------------------------
create table public.photo_analysis_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  photo_id uuid not null,
  job_id uuid not null unique,   -- 同じジョブの再実行で結果が重複しない
  estimated_count integer not null check (estimated_count >= 0),
  -- [{ "x":0..1, "y":0..1, "w":0..1, "h":0..1, "confidence":0..100 }]
  detections jsonb not null default '[]',
  model_provider text not null,
  model_name text not null,
  model_version text,
  min_confidence numeric,
  analyzed_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, photo_id) references public.photos(organization_id, id) on delete cascade,
  foreign key (organization_id, job_id) references public.jobs(organization_id, id) on delete cascade
);
create index photo_analysis_photo_idx on public.photo_analysis_results(organization_id, photo_id, analyzed_at desc);

create table public.photo_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  photo_id uuid not null,
  analysis_result_id uuid,
  confirmed_count integer not null check (confirmed_count >= 0 and confirmed_count <= 10000),
  note text,
  reviewed_by uuid references public.users(id) on delete set null default auth.uid(),
  reviewed_at timestamptz not null default now(),
  foreign key (organization_id, photo_id) references public.photos(organization_id, id) on delete cascade,
  foreign key (organization_id, analysis_result_id) references public.photo_analysis_results(organization_id, id) on delete set null (analysis_result_id)
);
create index photo_reviews_photo_idx on public.photo_reviews(organization_id, photo_id, reviewed_at desc);

-- ------------------------------------------------------------
-- 利用量（予約→確定／解放）
-- ------------------------------------------------------------
create table public.usage_records (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  metric text not null check (metric in ('photo_analysis', 'storage_bytes', 'export')),
  period text not null,                 -- 'YYYY-MM'（storage_bytes は保有量なので期間集計しない）
  quantity bigint not null check (quantity >= 0),
  status text not null check (status in ('reserved', 'committed', 'released')),
  idempotency_key text not null unique,
  expires_at timestamptz,               -- 予約の有効期限
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  released_at timestamptz
);
create index usage_records_org_idx on public.usage_records(organization_id, metric, period, status);

create table public.daily_metrics (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  day date not null,
  people_total integer not null,
  people_new integer not null,
  events_held integer not null,
  attended_participations integer not null,
  unique_attendees integer not null,
  anonymous_attendees integer not null,
  photo_analyses integer not null,
  computed_at timestamptz not null default now(),
  primary key (organization_id, day)
);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.photos enable row level security;
alter table public.jobs enable row level security;
alter table public.job_attempts enable row level security;
alter table public.photo_analysis_results enable row level security;
alter table public.photo_reviews enable row level security;
alter table public.usage_records enable row level security;
alter table public.daily_metrics enable row level security;

create policy photos_read on public.photos for select to authenticated using (public.is_member(organization_id));
create policy photos_update on public.photos for update to authenticated
  using (public.has_role(organization_id, 'editor')) with check (public.has_role(organization_id, 'editor'));
revoke update on public.photos from authenticated;
grant update (event_id) on public.photos to authenticated;

create policy jobs_read on public.jobs for select to authenticated using (public.is_member(organization_id));
create policy job_attempts_read on public.job_attempts for select to authenticated using (public.has_role(organization_id, 'admin'));
create policy analysis_read on public.photo_analysis_results for select to authenticated using (public.is_member(organization_id));
create policy reviews_read on public.photo_reviews for select to authenticated using (public.is_member(organization_id));
create policy reviews_insert on public.photo_reviews for insert to authenticated
  with check (public.has_role(organization_id, 'editor') and reviewed_by = auth.uid());
create policy usage_read on public.usage_records for select to authenticated using (public.is_member(organization_id));
create policy daily_metrics_read on public.daily_metrics for select to authenticated using (public.is_member(organization_id));

do $$
declare t text;
begin
  foreach t in array array['photos', 'jobs', 'job_attempts', 'photo_analysis_results', 'photo_reviews',
                           'usage_records', 'daily_metrics'] loop
    if t not in ('daily_metrics') then
      execute format('create trigger %I before update on public.%I for each row execute function public.prevent_org_change()',
                     t || '_no_org_change', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- ストレージ：非公開バケット。パスの先頭フォルダは団体ID。
-- アップロードはサーバーが発行する期限付きURLのみ。閲覧は所属メンバーが期限付きURLで。
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('photos', 'photos', false, 15 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp']),
  ('exports', 'exports', false, 200 * 1024 * 1024, array['text/csv'])
on conflict (id) do nothing;

create policy "photos: members read own org" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
-- exports はサーバーが権限確認後に期限付きURLを発行するため、利用者向けポリシーは置かない
