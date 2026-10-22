-- 顧客管理の基本機能：項目の追加、企業（法人）、やりとりの記録、タスク

-- ------------------------------------------------------------
-- 項目の追加（組織ごとの項目定義。値は people / companies の custom_fields に保存）
-- ------------------------------------------------------------
create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity text not null check (entity in ('person', 'company')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (char_length(label) between 1 and 60),
  field_type text not null check (field_type in ('text', 'long_text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'email', 'phone')),
  options text[] not null default '{}',
  required boolean not null default false,
  position integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, entity, key),
  check (field_type not in ('select', 'multi_select') or cardinality(options) between 1 and 100)
);
create index custom_field_definitions_org_idx on public.custom_field_definitions(organization_id, entity, position);

alter table public.people add column custom_fields jsonb not null default '{}';
grant update (custom_fields) on public.people to authenticated;

-- 値の検証と正規化。定義にない項目・型が合わない値はエラー。null・空文字は削除扱い
create or replace function public.validate_custom_fields(org uuid, p_entity text, vals jsonb, current jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $fn$
declare
  d record;
  v jsonb;
  out jsonb := coalesce(current, '{}');
  k text;
  maxlen int;
begin
  for k in select jsonb_object_keys(coalesce(vals, '{}')) loop
    if not exists (select 1 from public.custom_field_definitions where organization_id = org and entity = p_entity and key = k and not archived) then
      raise exception 'unknown_field' using hint = '定義されていない項目です：' || k;
    end if;
  end loop;
  for d in select * from public.custom_field_definitions where organization_id = org and entity = p_entity and not archived loop
    if not (coalesce(vals, '{}') ? d.key) then continue; end if;
    v := vals -> d.key;
    if v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb then
      out := out - d.key;
      continue;
    end if;
    case d.field_type
      when 'number' then
        if jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then v := to_jsonb((v #>> '{}')::numeric); end if;
        if jsonb_typeof(v) <> 'number' then raise exception 'invalid_field_value' using hint = d.label || 'は数値で入力してください。'; end if;
      when 'date' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'invalid_field_value' using hint = d.label || 'は日付（YYYY-MM-DD）で入力してください。';
        end if;
        perform (v #>> '{}')::date;
      when 'checkbox' then
        if jsonb_typeof(v) = 'string' then v := to_jsonb((v #>> '{}') in ('true', 'on', '1', 'はい')); end if;
        if jsonb_typeof(v) <> 'boolean' then raise exception 'invalid_field_value' using hint = d.label || 'の値が正しくありません。'; end if;
      when 'select' then
        if jsonb_typeof(v) <> 'string' or not ((v #>> '{}') = any(d.options)) then
          raise exception 'invalid_field_value' using hint = d.label || 'は選択肢から選んでください。';
        end if;
      when 'multi_select' then
        if jsonb_typeof(v) = 'string' then v := to_jsonb(regexp_split_to_array(v #>> '{}', '\s*[,、]\s*')); end if;
        if jsonb_typeof(v) <> 'array' or exists (select 1 from jsonb_array_elements_text(v) x where not (x = any(d.options))) then
          raise exception 'invalid_field_value' using hint = d.label || 'は選択肢から選んでください。';
        end if;
      when 'url' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~* '^https?://[^\s]+$' then
          raise exception 'invalid_field_value' using hint = d.label || 'は http(s):// で始まるURLで入力してください。';
        end if;
      when 'email' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
          raise exception 'invalid_field_value' using hint = d.label || 'のメールアドレスの形式が正しくありません。';
        end if;
      else
        if jsonb_typeof(v) <> 'string' then v := to_jsonb(v #>> '{}'); end if;
        maxlen := 500;
        if d.field_type = 'long_text' then maxlen := 10000; end if;
        if char_length(v #>> '{}') > maxlen then
          raise exception 'invalid_field_value' using hint = d.label || 'が長すぎます。';
        end if;
    end case;
    out := out || jsonb_build_object(d.key, v);
  end loop;
  return out;
end $fn$;

-- ------------------------------------------------------------
-- 企業（法人）と担当者
-- ------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  name_kana text,
  industry text,
  website text,
  phone text,
  address text,
  custom_fields jsonb not null default '{}',
  name_key text generated always as (public.normalize_name(name)) stored,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index companies_org_name_idx on public.companies(organization_id, name_key);
create index companies_org_trgm_idx on public.companies using gin (name gin_trgm_ops);
create trigger companies_touch before update on public.companies for each row execute function public.touch_updated_at();

create table public.person_company_links (
  organization_id uuid not null,
  person_id uuid not null,
  company_id uuid not null,
  title text,             -- 役職
  department text,        -- 部署
  is_primary boolean not null default false,  -- 主担当
  created_at timestamptz not null default now(),
  primary key (organization_id, person_id, company_id),
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies(organization_id, id) on delete cascade
);
create index person_company_links_company_idx on public.person_company_links(organization_id, company_id);

-- ------------------------------------------------------------
-- やりとりの記録（電話・面談・メール・訪問など）
-- ------------------------------------------------------------
create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  kind text not null check (kind in ('call', 'meeting', 'email', 'visit', 'online', 'other')),
  direction text check (direction in ('inbound', 'outbound')),
  occurred_at timestamptz not null default now(),
  subject text check (char_length(subject) <= 200),
  body text check (char_length(body) <= 20000),
  person_id uuid,
  company_id uuid,
  email_recipient_id uuid,    -- 一斉配信の送信記録から自動で作られた場合
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (person_id is not null or company_id is not null),
  unique (organization_id, id),
  foreign key (organization_id) references public.organizations(id) on delete cascade,
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies(organization_id, id) on delete cascade
);
create index interactions_person_idx on public.interactions(organization_id, person_id, occurred_at desc);
create index interactions_company_idx on public.interactions(organization_id, company_id, occurred_at desc);
create trigger interactions_touch before update on public.interactions for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- タスク・フォローアップ
-- ------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text check (char_length(description) <= 5000),
  due_date date,
  assignee_id uuid references public.users(id) on delete set null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  person_id uuid,
  company_id uuid,
  created_by uuid references public.users(id) on delete set null,
  completed_by uuid references public.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies(organization_id, id) on delete cascade
);
create index tasks_assignee_idx on public.tasks(organization_id, assignee_id, status, due_date);
create index tasks_person_idx on public.tasks(organization_id, person_id);
create index tasks_company_idx on public.tasks(organization_id, company_id);
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();

-- 担当者は組織のメンバーに限る
create or replace function public.trg_task_assignee() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.assignee_id is not null and not exists (
    select 1 from public.memberships where organization_id = new.organization_id and user_id = new.assignee_id) then
    raise exception 'invalid_assignee' using hint = '担当者は組織のスタッフから選んでください。';
  end if;
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := now();
    new.completed_by := auth.uid();
  elsif new.status <> 'done' then
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end $$;
create trigger tasks_assignee before insert or update on public.tasks for each row execute function public.trg_task_assignee();

-- ------------------------------------------------------------
-- RLS：閲覧はメンバー、登録・編集は編集者以上。項目定義は管理者以上
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['companies', 'person_company_links', 'interactions', 'tasks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(organization_id))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_role(organization_id, ''editor''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_role(organization_id, ''editor'')) with check (public.has_role(organization_id, ''editor''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_role(organization_id, ''editor''))', t || '_delete', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.prevent_org_change()', t || '_no_org_change', t);
  end loop;
end $$;

-- 企業の削除は管理者以上
drop policy companies_delete on public.companies;
create policy companies_delete on public.companies for delete to authenticated using (public.has_role(organization_id, 'admin'));
-- やりとりの編集・削除は、記録した本人か管理者
drop policy interactions_update on public.interactions;
drop policy interactions_delete on public.interactions;
create policy interactions_update on public.interactions for update to authenticated
  using (public.has_role(organization_id, 'admin') or (created_by = auth.uid() and public.has_role(organization_id, 'editor')))
  with check (public.has_role(organization_id, 'editor'));
create policy interactions_delete on public.interactions for delete to authenticated
  using (public.has_role(organization_id, 'admin') or (created_by = auth.uid() and public.has_role(organization_id, 'editor')));
-- custom_fields は検証つきの RPC でだけ書き換える
revoke update on public.companies from authenticated;
grant update (name, name_kana, industry, website, phone, address) on public.companies to authenticated;
revoke update on public.people from authenticated;
grant update (full_name, full_name_kana, region, attributes, display_name, interests, skills) on public.people to authenticated;
revoke update (email_recipient_id) on public.interactions from authenticated;

alter table public.custom_field_definitions enable row level security;
create policy custom_fields_read on public.custom_field_definitions for select to authenticated using (public.is_member(organization_id));
create policy custom_fields_insert on public.custom_field_definitions for insert to authenticated with check (public.has_role(organization_id, 'admin'));
create policy custom_fields_update on public.custom_field_definitions for update to authenticated
  using (public.has_role(organization_id, 'admin')) with check (public.has_role(organization_id, 'admin'));
create policy custom_fields_delete on public.custom_field_definitions for delete to authenticated using (public.has_role(organization_id, 'admin'));
revoke update on public.custom_field_definitions from authenticated;
grant update (label, options, required, position, archived) on public.custom_field_definitions to authenticated;
create trigger custom_field_definitions_no_org_change before update on public.custom_field_definitions
  for each row execute function public.prevent_org_change();

-- ------------------------------------------------------------
-- RPC
-- ------------------------------------------------------------
create or replace function public.set_custom_fields(p_entity text, record_id uuid, vals jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  org uuid;
  cur jsonb;
  nxt jsonb;
begin
  if p_entity = 'person' then
    select organization_id, custom_fields into org, cur from public.people where id = record_id;
  elsif p_entity = 'company' then
    select organization_id, custom_fields into org, cur from public.companies where id = record_id;
  else
    raise exception 'invalid_entity';
  end if;
  if org is null then raise exception 'not_found'; end if;
  perform public.require_role(org, 'editor');
  nxt := public.validate_custom_fields(org, p_entity, vals, cur);
  if p_entity = 'person' then
    update public.people set custom_fields = nxt where id = record_id;
  else
    update public.companies set custom_fields = nxt where id = record_id;
  end if;
  return nxt;
end $$;

create or replace function public.create_company(org uuid, data jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid;
begin
  perform public.require_role(org, 'editor');
  insert into public.companies (organization_id, name, name_kana, industry, website, phone, address, custom_fields, created_by)
    values (org, btrim(data->>'name'), nullif(btrim(data->>'name_kana'), ''), nullif(btrim(data->>'industry'), ''),
            nullif(btrim(data->>'website'), ''), nullif(btrim(data->>'phone'), ''), nullif(btrim(data->>'address'), ''),
            public.validate_custom_fields(org, 'company', coalesce(data->'custom_fields', '{}')), auth.uid())
    returning id into cid;
  return cid;
end $$;

-- 企業一覧（担当者数・未完了タスク数・最終接触日つき）
create or replace function public.search_companies(org uuid, q text default null, sort text default 'name',
                                                   page_size int default 50, page int default 1)
returns table (id uuid, name text, name_kana text, industry text, phone text, contact_count bigint, open_tasks bigint,
               last_interaction_at timestamptz, created_at timestamptz, total_count bigint)
language sql stable security invoker set search_path = public, extensions as $$
  with base as (
    select c.*,
      (select count(*) from public.person_company_links l where l.organization_id = org and l.company_id = c.id) contact_count,
      (select count(*) from public.tasks t where t.organization_id = org and t.company_id = c.id and t.status = 'open') open_tasks,
      (select max(i.occurred_at) from public.interactions i where i.organization_id = org and
         (i.company_id = c.id or i.person_id in (select l.person_id from public.person_company_links l where l.organization_id = org and l.company_id = c.id))) last_interaction_at
    from public.companies c
    where c.organization_id = org
      and (q is null or btrim(q) = '' or c.name ilike '%' || btrim(q) || '%' or c.name_kana ilike '%' || btrim(q) || '%'
           or c.industry ilike '%' || btrim(q) || '%' or c.name_key = public.normalize_name(q))
  )
  select b.id, b.name, b.name_kana, b.industry, b.phone, b.contact_count, b.open_tasks, b.last_interaction_at, b.created_at,
         count(*) over ()
  from base b
  order by
    case when sort = 'name' then coalesce(b.name_kana, b.name) end asc,
    case when sort = 'recent_contact' then b.last_interaction_at end desc nulls last,
    case when sort = 'created' then b.created_at end desc,
    b.name, b.id
  limit least(greatest(page_size, 1), 200) offset (greatest(page, 1) - 1) * least(greatest(page_size, 1), 200)
$$;

-- 人物のタイムライン（やりとり・メモ・参加履歴・応募回答を時系列に）
create or replace function public.person_timeline(org uuid, pid uuid, max_rows int default 200)
returns table (kind text, item_id uuid, occurred_at timestamptz, title text, body text, meta jsonb)
language sql stable security invoker set search_path = public, extensions as $$
  select * from (
    select 'interaction:' || i.kind, i.id, i.occurred_at, coalesce(i.subject, ''), i.body,
           jsonb_build_object('direction', i.direction, 'created_by', i.created_by, 'company_id', i.company_id,
                              'from_campaign', i.email_recipient_id is not null)
      from public.interactions i where i.organization_id = org and i.person_id = pid
    union all
    select 'note', n.id, n.created_at, 'メモ', n.body, jsonb_build_object('created_by', n.author_id)
      from public.person_notes n where n.organization_id = org and n.person_id = pid
    union all
    select 'participation', ep.id, e.starts_at, e.title, null, jsonb_build_object('status', ep.status, 'event_id', e.id)
      from public.event_participations ep join public.events e on e.id = ep.event_id
      where ep.organization_id = org and ep.person_id = pid
    union all
    select 'submission', s.id, coalesce(s.submitted_at, s.received_at), coalesce(c.name, 'フォーム'), null,
           jsonb_build_object('status', s.status)
      from public.form_submissions s join public.form_connections c on c.id = s.connection_id
      where s.organization_id = org and s.person_id = pid
  ) x
  order by occurred_at desc
  limit least(max_rows, 500)
$$;

-- 自分のタスク件数（メニューの表示用）
create or replace function public.my_task_counts(org uuid) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select jsonb_build_object(
    'overdue', count(*) filter (where due_date < (now() at time zone 'Asia/Tokyo')::date),
    'today', count(*) filter (where due_date = (now() at time zone 'Asia/Tokyo')::date),
    'open', count(*))
  from public.tasks
  where organization_id = org and status = 'open' and assignee_id = auth.uid()
$$;

-- フォーム取り込みで追加項目へ入れる（対応先 "custom:<key>"）
create or replace function public.map_submission(raw jsonb, mapping jsonb) returns jsonb
language plpgsql immutable as $$
declare
  k text;
  target text;
  val text;
  out jsonb := jsonb_build_object('attributes', '{}'::jsonb, 'emails', '[]'::jsonb, 'phones', '[]'::jsonb, 'tags', '[]'::jsonb, 'custom', '{}'::jsonb);
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
    elsif target like 'custom:%' then
      out := jsonb_set(out, array['custom', substr(target, 8)], to_jsonb(val));
    elsif target in ('full_name', 'full_name_kana', 'region', 'note', 'external_id', 'submitted_at') then
      out := out || jsonb_build_object(target, val);
    end if;
  end loop;
  return out;
end $$;

-- 取り込んだ値は、空欄の追加項目だけを補う（型が合わない値は取り込まず、原文に残る）
create or replace function public.trg_apply_custom_from_submission() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  c public.form_connections;
  m jsonb;
  cur jsonb;
  add jsonb := '{}';
  k text;
begin
  if new.person_id is null or new.status not in ('linked', 'created') or (old.person_id is not distinct from new.person_id and old.status = new.status) then
    return null;
  end if;
  select * into c from public.form_connections where id = new.connection_id;
  m := public.map_submission(new.raw, c.field_mapping) -> 'custom';
  if m is null or m = '{}'::jsonb then return null; end if;
  select custom_fields into cur from public.people where id = new.person_id;
  for k in select jsonb_object_keys(m) loop
    if not (cur ? k) then
      begin
        add := add || public.validate_custom_fields(new.organization_id, 'person', jsonb_build_object(k, m -> k), '{}');
      exception when others then
        null;
      end;
    end if;
  end loop;
  if add <> '{}'::jsonb then
    update public.people set custom_fields = add || custom_fields where id = new.person_id;
  end if;
  return null;
end $$;
create trigger form_submissions_custom after update on public.form_submissions
  for each row execute function public.trg_apply_custom_from_submission();
