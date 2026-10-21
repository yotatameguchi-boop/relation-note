-- 基本設計書 §4.1〜§4.3：人物・分類、フォーム回答、イベント・参加履歴

-- ------------------------------------------------------------
-- 正規化（名寄せ用）
-- ------------------------------------------------------------
create or replace function public.normalize_email(v text) returns text
language sql immutable as $$
  select nullif(lower(btrim(translate(coalesce(v, ''),
    '＠．ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９＿－',
    '@.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'))), '')
$$;

create or replace function public.normalize_phone(v text) returns text
language sql immutable as $$
  select nullif(
    regexp_replace(
      regexp_replace(translate(coalesce(v, ''), '０１２３４５６７８９＋', '0123456789+'), '[^0-9+]', '', 'g'),
      '^\+81', '0'),
    '')
$$;

create or replace function public.normalize_name(v text) returns text
language sql immutable as $$
  select nullif(lower(regexp_replace(coalesce(v, ''), '[\s　・･]', '', 'g')), '')
$$;

create or replace function public.normalize_contact(kind text, v text) returns text
language sql immutable as $$
  select case kind
    when 'email' then public.normalize_email(v)
    when 'phone' then public.normalize_phone(v)
    else nullif(btrim(coalesce(v, '')), '')
  end
$$;

-- ------------------------------------------------------------
-- 人物
-- ------------------------------------------------------------
create table public.people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 200),
  full_name_kana text,
  region text,
  attributes jsonb not null default '{}',
  name_key text generated always as (public.normalize_name(full_name)) stored,
  -- 参加集計（参加確認済みのみ。トリガーで更新）
  attendance_count integer not null default 0,
  last_attended_at timestamptz,
  first_seen_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index people_org_name_idx on public.people(organization_id, name_key);
create index people_org_name_trgm_idx on public.people using gin (full_name gin_trgm_ops);
create index people_org_region_idx on public.people(organization_id, region);
create index people_org_last_idx on public.people(organization_id, last_attended_at desc nulls last);
create index people_org_count_idx on public.people(organization_id, attendance_count desc);
create index people_org_created_idx on public.people(organization_id, created_at desc);

create table public.person_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  person_id uuid not null,
  kind text not null check (kind in ('email', 'phone', 'address', 'other')),
  value text not null,
  normalized_value text generated always as (public.normalize_contact(kind, value)) stored,
  label text,
  created_at timestamptz not null default now(),
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade,
  unique (organization_id, person_id, kind, normalized_value)
);
create index person_contacts_lookup_idx on public.person_contacts(organization_id, kind, normalized_value);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  color text not null default '#6b7280',
  created_at timestamptz not null default now(),
  unique (organization_id, name),
  unique (organization_id, id)
);

create table public.person_tags (
  organization_id uuid not null,
  person_id uuid not null,
  tag_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, person_id, tag_id),
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade,
  foreign key (organization_id, tag_id) references public.tags(organization_id, id) on delete cascade
);
create index person_tags_tag_idx on public.person_tags(organization_id, tag_id);

create table public.person_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  person_id uuid not null,
  body text not null check (char_length(body) between 1 and 10000),
  author_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade
);
create index person_notes_person_idx on public.person_notes(organization_id, person_id, created_at desc);

create table public.person_merge_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  kept_person_id uuid not null,
  merged_person_id uuid not null,         -- 統合で消えた人物（行は残らないので FK なし）
  merged_snapshot jsonb not null,         -- 統合直前の人物・連絡先・タグ
  merged_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, kept_person_id) references public.people(organization_id, id) on delete cascade
);

-- 「別人と確認済み」の組。重複候補に再表示しない。
create table public.person_distinct_pairs (
  organization_id uuid not null,
  person_a uuid not null,
  person_b uuid not null,
  decided_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (organization_id, person_a, person_b),
  check (person_a < person_b),
  foreign key (organization_id, person_a) references public.people(organization_id, id) on delete cascade,
  foreign key (organization_id, person_b) references public.people(organization_id, id) on delete cascade
);

-- ------------------------------------------------------------
-- イベント・参加履歴
-- ------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  description text,
  -- 名簿に載らない匿名参加者（個人単位の重複排除はできない）
  anonymous_count integer not null default 0 check (anonymous_count >= 0),
  -- スタッフが確定したイベント参加人数（受付記録と別に確定する場合）
  confirmed_headcount integer check (confirmed_headcount >= 0),
  headcount_confirmed_by uuid references public.users(id) on delete set null,
  headcount_confirmed_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index events_org_start_idx on public.events(organization_id, starts_at desc);

create table public.event_participations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  event_id uuid not null,
  person_id uuid not null,
  status text not null default 'applied' check (status in ('applied', 'attended', 'absent', 'cancelled')),
  note text,
  submission_id uuid,
  status_changed_by uuid references public.users(id) on delete set null,
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (event_id, person_id),
  foreign key (organization_id, event_id) references public.events(organization_id, id) on delete cascade,
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade
);
create index event_participations_person_idx on public.event_participations(organization_id, person_id);
create index event_participations_event_idx on public.event_participations(organization_id, event_id, status);

-- 人物の参加集計を再計算
create or replace function public.refresh_person_stats(org uuid, pid uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update public.people p set
    attendance_count = s.cnt,
    last_attended_at = s.last_at
  from (
    select count(*)::int cnt, max(e.starts_at) last_at
    from public.event_participations ep
    join public.events e on e.id = ep.event_id
    where ep.organization_id = org and ep.person_id = pid and ep.status = 'attended'
  ) s
  where p.organization_id = org and p.id = pid;
$$;

create or replace function public.trg_participation_stats() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.refresh_person_stats(new.organization_id, new.person_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or old.person_id <> new.person_id) then
    perform public.refresh_person_stats(old.organization_id, old.person_id);
  end if;
  return null;
end $$;

create trigger event_participations_stats after insert or update or delete on public.event_participations
  for each row execute function public.trg_participation_stats();

-- イベント日時の変更で最終参加日がずれるので再計算
create or replace function public.trg_event_time_stats() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  if new.starts_at is distinct from old.starts_at then
    for r in select person_id from public.event_participations where event_id = new.id and status = 'attended' loop
      perform public.refresh_person_stats(new.organization_id, r.person_id);
    end loop;
  end if;
  return null;
end $$;

create trigger events_time_stats after update of starts_at on public.events
  for each row execute function public.trg_event_time_stats();

create or replace function public.trg_participation_status_meta() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.status_changed_at := now();
    new.status_changed_by := coalesce(auth.uid(), new.status_changed_by);
  end if;
  return new;
end $$;

create trigger event_participations_meta before insert or update on public.event_participations
  for each row execute function public.trg_participation_status_meta();

-- ------------------------------------------------------------
-- フォーム連携
-- ------------------------------------------------------------
create table public.form_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  kind text not null check (kind in ('csv', 'webhook')),
  -- { "元の項目名": "full_name" | "full_name_kana" | "email" | "phone" | "region" | "tags"
  --               | "note" | "external_id" | "submitted_at" | "attr:<任意キー>" }
  field_mapping jsonb not null default '{}',
  default_tag_ids uuid[] not null default '{}',
  -- 申込フォームの場合、回答をこのイベントの「申込」として登録する
  event_id uuid,
  is_active boolean not null default true,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, event_id) references public.events(organization_id, id) on delete set null (event_id)
);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  source text not null check (source in ('csv', 'webhook')),
  filename text,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  total_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, connection_id) references public.form_connections(organization_id, id) on delete cascade
);
create index import_batches_org_idx on public.import_batches(organization_id, created_at desc);

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  batch_id uuid,
  -- 二重取り込み防止キー（回答ID、なければ回答原文のハッシュ）
  dedupe_key text not null,
  external_id text,
  raw jsonb not null,           -- 回答原文
  source text not null check (source in ('csv', 'webhook', 'manual')),
  received_at timestamptz not null default now(),
  submitted_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'linked', 'created', 'needs_review', 'error', 'ignored')),
  error text,
  person_id uuid,
  match_reason text,
  candidate_person_ids uuid[] not null default '{}',
  processed_at timestamptz,
  resolved_by uuid references public.users(id) on delete set null,
  unique (connection_id, dedupe_key),
  unique (organization_id, id),
  foreign key (organization_id, connection_id) references public.form_connections(organization_id, id) on delete cascade,
  foreign key (organization_id, batch_id) references public.import_batches(organization_id, id) on delete set null (batch_id),
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete set null (person_id)
);
create index form_submissions_org_status_idx on public.form_submissions(organization_id, status, received_at desc);
create index form_submissions_person_idx on public.form_submissions(organization_id, person_id);
create index form_submissions_batch_idx on public.form_submissions(organization_id, batch_id, status);

alter table public.event_participations
  add foreign key (organization_id, submission_id) references public.form_submissions(organization_id, id) on delete set null (submission_id);

-- ------------------------------------------------------------
-- 更新日時
-- ------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger people_touch before update on public.people for each row execute function public.touch_updated_at();
create trigger events_touch before update on public.events for each row execute function public.touch_updated_at();
create trigger organizations_touch before update on public.organizations for each row execute function public.touch_updated_at();
create trigger form_connections_touch before update on public.form_connections for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 登録人物の上限（§2.3）。上限到達時は新規作成を止め、既存データは使える。
-- ------------------------------------------------------------
create or replace function public.enforce_people_limit() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  lim int;
  cur int;
begin
  select p.max_people into lim from public.organizations o join public.plans p on p.id = o.plan_id
    where o.id = new.organization_id;
  -- 同一団体の同時作成で上限を超えないよう団体単位でロック
  perform pg_advisory_xact_lock(hashtext('people:' || new.organization_id::text));
  select count(*) into cur from public.people where organization_id = new.organization_id;
  if cur >= lim then
    raise exception 'quota_exceeded:people' using errcode = 'P0001',
      hint = '登録人物数がプランの上限（' || lim || '人）に達しています。';
  end if;
  return new;
end $$;

create trigger people_limit before insert on public.people
  for each row execute function public.enforce_people_limit();

-- ------------------------------------------------------------
-- RLS：閲覧はメンバー、登録・編集は編集者以上
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['people', 'person_contacts', 'tags', 'person_tags', 'person_notes',
                           'events', 'event_participations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(organization_id))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_role(organization_id, ''editor''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_role(organization_id, ''editor'')) with check (public.has_role(organization_id, ''editor''))', t || '_update', t);
  end loop;
end $$;

-- 削除：人物の削除は管理者以上（一括削除は RPC で bulk_delete 権限を要求）
create policy people_delete on public.people for delete to authenticated using (public.has_role(organization_id, 'admin'));
create policy person_contacts_delete on public.person_contacts for delete to authenticated using (public.has_role(organization_id, 'editor'));
create policy tags_delete on public.tags for delete to authenticated using (public.has_role(organization_id, 'admin'));
create policy person_tags_delete on public.person_tags for delete to authenticated using (public.has_role(organization_id, 'editor'));
-- メモは本人か管理者が削除
create policy person_notes_delete on public.person_notes for delete to authenticated
  using (public.has_role(organization_id, 'admin') or (author_id = auth.uid() and public.has_role(organization_id, 'editor')));
create policy events_delete on public.events for delete to authenticated using (public.has_role(organization_id, 'editor'));
create policy event_participations_delete on public.event_participations for delete to authenticated using (public.has_role(organization_id, 'editor'));

alter table public.person_merge_history enable row level security;
create policy merge_history_read on public.person_merge_history for select to authenticated using (public.is_member(organization_id));

alter table public.person_distinct_pairs enable row level security;
create policy distinct_pairs_read on public.person_distinct_pairs for select to authenticated using (public.is_member(organization_id));
create policy distinct_pairs_insert on public.person_distinct_pairs for insert to authenticated with check (public.has_role(organization_id, 'editor'));

alter table public.form_connections enable row level security;
create policy form_connections_read on public.form_connections for select to authenticated using (public.has_role(organization_id, 'editor'));
create policy form_connections_insert on public.form_connections for insert to authenticated with check (public.has_role(organization_id, 'admin'));
create policy form_connections_update on public.form_connections for update to authenticated using (public.has_role(organization_id, 'admin')) with check (public.has_role(organization_id, 'admin'));
create policy form_connections_delete on public.form_connections for delete to authenticated using (public.has_role(organization_id, 'admin'));

-- 外部フォームの送信元認証用の秘密（ハッシュ）。利用者からは見えない別テーブル。
create table public.form_connection_secrets (
  connection_id uuid primary key references public.form_connections(id) on delete cascade,
  secret_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.form_connection_secrets enable row level security;

alter table public.import_batches enable row level security;
create policy import_batches_read on public.import_batches for select to authenticated using (public.has_role(organization_id, 'editor'));

-- 回答原文は編集者以上のみ閲覧。取り込みは RPC 経由。
alter table public.form_submissions enable row level security;
create policy form_submissions_read on public.form_submissions for select to authenticated using (public.has_role(organization_id, 'editor'));

-- 人物の参加集計列は利用者が直接書き換えない（列単位で許可）
revoke update on public.people from authenticated;
grant update (full_name, full_name_kana, region, attributes) on public.people to authenticated;
revoke update on public.events from authenticated;
grant update (title, starts_at, ends_at, location, description, anonymous_count) on public.events to authenticated;

-- ------------------------------------------------------------
-- organization_id の付け替えを禁止（別団体へのデータ移動を防ぐ）
-- ------------------------------------------------------------
create or replace function public.prevent_org_change() returns trigger language plpgsql as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['people', 'person_contacts', 'tags', 'person_tags', 'person_notes', 'person_merge_history',
                           'events', 'event_participations', 'form_connections', 'import_batches', 'form_submissions',
                           'memberships', 'invitations', 'audit_logs'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.prevent_org_change()',
                   t || '_no_org_change', t);
  end loop;
end $$;
