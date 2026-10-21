-- 人物の検索・重複確認・統合・一括操作（§4.1）

-- 検索。security invoker なので RLS がそのまま効く。
create or replace function public.search_people(
  org uuid,
  q text default null,
  tag_ids uuid[] default null,        -- すべてのタグを持つ人物（AND）
  region_filter text default null,
  sort text default 'recent',         -- recent | name | last_attended | attendance_count
  page_size int default 50,
  page int default 1
) returns table (
  id uuid, full_name text, full_name_kana text, region text,
  attendance_count int, last_attended_at timestamptz, created_at timestamptz,
  emails text[], phones text[], tags jsonb, total_count bigint
) language sql stable security invoker set search_path = public, extensions as $$
  with base as (
    select p.* from public.people p
    where p.organization_id = org
      and (region_filter is null or p.region ilike '%' || region_filter || '%')
      and (tag_ids is null or cardinality(tag_ids) = 0 or (
        select count(distinct pt.tag_id) from public.person_tags pt
        where pt.organization_id = org and pt.person_id = p.id and pt.tag_id = any(tag_ids)
      ) = cardinality(tag_ids))
      and (q is null or btrim(q) = '' or
        p.full_name ilike '%' || btrim(q) || '%'
        or p.full_name_kana ilike '%' || btrim(q) || '%'
        or p.name_key = public.normalize_name(q)
        or exists (
          select 1 from public.person_contacts c
          where c.organization_id = org and c.person_id = p.id
            and (c.normalized_value = public.normalize_email(q)
                 or (public.normalize_phone(q) is not null and length(public.normalize_phone(q)) >= 4
                     and c.kind = 'phone' and c.normalized_value like '%' || public.normalize_phone(q) || '%')
                 or c.value ilike '%' || btrim(q) || '%')
        ))
  ), counted as (
    select b.*, count(*) over () as total_count from base b
    order by
      case when sort = 'name' then coalesce(b.full_name_kana, b.full_name) end asc,
      case when sort = 'last_attended' then b.last_attended_at end desc nulls last,
      case when sort = 'attendance_count' then b.attendance_count end desc,
      b.created_at desc, b.id
    limit least(greatest(page_size, 1), 200) offset (greatest(page, 1) - 1) * least(greatest(page_size, 1), 200)
  )
  select c.id, c.full_name, c.full_name_kana, c.region, c.attendance_count, c.last_attended_at, c.created_at,
    coalesce((select array_agg(pc.value order by pc.created_at) from public.person_contacts pc
              where pc.organization_id = org and pc.person_id = c.id and pc.kind = 'email'), '{}'),
    coalesce((select array_agg(pc.value order by pc.created_at) from public.person_contacts pc
              where pc.organization_id = org and pc.person_id = c.id and pc.kind = 'phone'), '{}'),
    coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) order by t.name)
              from public.person_tags pt join public.tags t on t.id = pt.tag_id
              where pt.organization_id = org and pt.person_id = c.id), '[]'),
    c.total_count
  from counted c
  order by
    case when sort = 'name' then coalesce(c.full_name_kana, c.full_name) end asc,
    case when sort = 'last_attended' then c.last_attended_at end desc nulls last,
    case when sort = 'attendance_count' then c.attendance_count end desc,
    c.created_at desc, c.id
$$;

-- 重複候補：同じメール・電話・氏名を持つ組。「別人」と判断済みの組は除く。
create or replace function public.duplicate_candidates(org uuid, max_rows int default 100)
returns table (person_a uuid, person_b uuid, reasons text[])
language sql stable security invoker set search_path = public, extensions as $$
  with pairs as (
    select least(c1.person_id, c2.person_id) a, greatest(c1.person_id, c2.person_id) b, c1.kind as reason
    from public.person_contacts c1
    join public.person_contacts c2
      on c2.organization_id = c1.organization_id and c2.kind = c1.kind
     and c2.normalized_value = c1.normalized_value and c2.person_id <> c1.person_id
    where c1.organization_id = org and c1.kind in ('email', 'phone')
    union all
    select least(p1.id, p2.id), greatest(p1.id, p2.id), 'name'
    from public.people p1
    join public.people p2 on p2.organization_id = p1.organization_id and p2.name_key = p1.name_key and p2.id <> p1.id
    where p1.organization_id = org
  )
  select a, b, array_agg(distinct reason order by reason)
  from pairs
  where not exists (select 1 from public.person_distinct_pairs d
                    where d.organization_id = org and d.person_a = pairs.a and d.person_b = pairs.b)
  group by a, b
  order by count(distinct reason) desc, a, b
  limit least(max_rows, 500)
$$;

create or replace function public.mark_people_distinct(org uuid, a uuid, b uuid) returns void
language sql security invoker set search_path = public, extensions as $$
  insert into public.person_distinct_pairs (organization_id, person_a, person_b, decided_by)
  values (org, least(a, b), greatest(a, b), auth.uid())
  on conflict do nothing;
$$;

-- 人物統合：merge_id の情報を keep_id に移し、merge_id を削除する。統合前の状態は履歴に残す。
create or replace function public.merge_people(org uuid, keep_id uuid, merge_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  snap jsonb;
  kept public.people;
  gone public.people;
begin
  perform public.require_role(org, 'editor');
  perform public.require_perm(org, 'merge_people');
  if keep_id = merge_id then raise exception 'invalid_merge'; end if;
  select * into kept from public.people where organization_id = org and id = keep_id for update;
  select * into gone from public.people where organization_id = org and id = merge_id for update;
  if kept.id is null or gone.id is null then raise exception 'not_found'; end if;

  snap := jsonb_build_object(
    'person', to_jsonb(gone),
    'contacts', coalesce((select jsonb_agg(to_jsonb(c)) from public.person_contacts c where c.organization_id = org and c.person_id = merge_id), '[]'),
    'tag_ids', coalesce((select jsonb_agg(tag_id) from public.person_tags where organization_id = org and person_id = merge_id), '[]'),
    'participations', coalesce((select jsonb_agg(to_jsonb(ep)) from public.event_participations ep where ep.organization_id = org and ep.person_id = merge_id), '[]')
  );

  -- 空欄だけ補う（統合先の値は上書きしない）
  update public.people set
    full_name_kana = coalesce(kept.full_name_kana, gone.full_name_kana),
    region = coalesce(kept.region, gone.region),
    attributes = gone.attributes || kept.attributes,
    first_seen_at = least(kept.first_seen_at, gone.first_seen_at)
  where organization_id = org and id = keep_id;

  insert into public.person_contacts (organization_id, person_id, kind, value, label, created_at)
    select org, keep_id, kind, value, label, created_at from public.person_contacts
    where organization_id = org and person_id = merge_id
  on conflict (organization_id, person_id, kind, normalized_value) do nothing;

  insert into public.person_tags (organization_id, person_id, tag_id)
    select org, keep_id, tag_id from public.person_tags where organization_id = org and person_id = merge_id
  on conflict do nothing;

  update public.person_notes set person_id = keep_id where organization_id = org and person_id = merge_id;
  update public.form_submissions set person_id = keep_id where organization_id = org and person_id = merge_id;

  -- 同じイベントに両方の記録がある場合は「参加」を優先して残す
  update public.event_participations k set status = 'attended'
    from public.event_participations g
    where k.organization_id = org and k.person_id = keep_id and g.organization_id = org and g.person_id = merge_id
      and g.event_id = k.event_id and g.status = 'attended' and k.status <> 'attended';
  update public.event_participations g set person_id = keep_id
    where g.organization_id = org and g.person_id = merge_id
      and not exists (select 1 from public.event_participations k
                      where k.organization_id = org and k.person_id = keep_id and k.event_id = g.event_id);

  insert into public.person_merge_history (organization_id, kept_person_id, merged_person_id, merged_snapshot, merged_by)
    values (org, keep_id, merge_id, snap, auth.uid());
  -- 統合済み人物を指す確認待ち候補を付け替え
  update public.form_submissions set candidate_person_ids = array_replace(candidate_person_ids, merge_id, keep_id)
    where organization_id = org and merge_id = any(candidate_person_ids);

  delete from public.people where organization_id = org and id = merge_id;
  perform public.refresh_person_stats(org, keep_id);
  perform public.audit(org, 'person.merge', 'person', keep_id::text,
                       jsonb_build_object('merged_person_id', merge_id, 'merged_name', gone.full_name));
end $$;

create or replace function public.bulk_delete_people(org uuid, ids uuid[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform public.require_role(org, 'admin');
  perform public.require_perm(org, 'bulk_delete');
  delete from public.people where organization_id = org and id = any(ids);
  get diagnostics n = row_count;
  perform public.audit(org, 'person.bulk_delete', 'person', null, jsonb_build_object('count', n));
  return n;
end $$;

create or replace function public.bulk_tag_people(org uuid, ids uuid[], tag uuid, add boolean default true) returns int
language plpgsql security invoker set search_path = public, extensions as $$
declare n int;
begin
  if add then
    insert into public.person_tags (organization_id, person_id, tag_id)
      select org, unnest(ids), tag on conflict do nothing;
  else
    delete from public.person_tags where organization_id = org and tag_id = tag and person_id = any(ids);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- 人物の新規登録（連絡先・タグ込み）
create or replace function public.create_person(org uuid, data jsonb) returns uuid
language plpgsql security invoker set search_path = public, extensions as $$
declare
  pid uuid;
  v text;
begin
  insert into public.people (organization_id, full_name, full_name_kana, region, attributes, created_by)
    values (org, btrim(data->>'full_name'), nullif(btrim(data->>'full_name_kana'), ''),
            nullif(btrim(data->>'region'), ''), coalesce(data->'attributes', '{}'), auth.uid())
    returning id into pid;
  for v in select jsonb_array_elements_text(coalesce(data->'emails', '[]')) loop
    if public.normalize_email(v) is not null then
      insert into public.person_contacts (organization_id, person_id, kind, value) values (org, pid, 'email', btrim(v)) on conflict do nothing;
    end if;
  end loop;
  for v in select jsonb_array_elements_text(coalesce(data->'phones', '[]')) loop
    if public.normalize_phone(v) is not null then
      insert into public.person_contacts (organization_id, person_id, kind, value) values (org, pid, 'phone', btrim(v)) on conflict do nothing;
    end if;
  end loop;
  insert into public.person_tags (organization_id, person_id, tag_id)
    select org, pid, (t)::uuid from jsonb_array_elements_text(coalesce(data->'tag_ids', '[]')) t
    on conflict do nothing;
  return pid;
end $$;

create or replace function public.trg_audit_person_delete() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.organizations where id = old.organization_id) and auth.uid() is not null then
    perform public.audit(old.organization_id, 'person.delete', 'person', old.id::text, jsonb_build_object('name', old.full_name));
  end if;
  return null;
end $$;
create trigger people_audit_delete after delete on public.people
  for each row when (pg_trigger_depth() < 1) execute function public.trg_audit_person_delete();
