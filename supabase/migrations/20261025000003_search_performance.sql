-- 負荷試験（10万人・企業5千社・やりとり20万件の組織）で遅かった検索を直す。結果は変えない。
--   人物検索：連絡先の照合を「人物1人ごとの副問い合わせ」から「連絡先表を1回だけ走査」に変更（約660ms → 下記参照）
--   企業一覧：連絡人数・未完了タスク・最終接触日を「該当する全社」ではなく「表示する50社」だけ計算
--             （最終接触日で並べるときだけ全社分を計算する）

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
  with term as (
    select nullif(btrim(q), '') t, public.normalize_name(q) nk, public.normalize_email(q) em, public.normalize_phone(q) ph
  ), matched as (
    -- 文字列での検索があるときだけ、氏名と連絡先からそれぞれ1回ずつ候補を集める
    select p.id from public.people p, term
    where term.t is not null and p.organization_id = org
      and (p.full_name ilike '%' || term.t || '%' or p.full_name_kana ilike '%' || term.t || '%' or p.name_key = term.nk)
    union
    select c.person_id from public.person_contacts c, term
    where term.t is not null and c.organization_id = org
      and (c.normalized_value = term.em
           or (term.ph is not null and length(term.ph) >= 4 and c.kind = 'phone' and c.normalized_value like '%' || term.ph || '%')
           or c.value ilike '%' || term.t || '%')
  ), base as (
    select p.* from public.people p, term
    where p.organization_id = org
      and (region_filter is null or p.region ilike '%' || region_filter || '%')
      and (tag_ids is null or cardinality(tag_ids) = 0 or (
        select count(distinct pt.tag_id) from public.person_tags pt
        where pt.organization_id = org and pt.person_id = p.id and pt.tag_id = any(tag_ids)
      ) = cardinality(tag_ids))
      and (term.t is null or p.id in (select m.id from matched m))
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

-- 企業の最終接触日（企業とのやりとり、または所属する人物とのやりとりの最新）
create or replace function public.company_last_interaction(org uuid, cid uuid) returns timestamptz
language sql stable security invoker set search_path = public, extensions as $$
  select greatest(
    (select max(i.occurred_at) from public.interactions i where i.organization_id = org and i.company_id = cid),
    (select max(i.occurred_at) from public.person_company_links l
       join public.interactions i on i.organization_id = org and i.person_id = l.person_id
     where l.organization_id = org and l.company_id = cid))
$$;

create or replace function public.search_companies(org uuid, q text default null, sort text default 'name',
                                                   page_size int default 50, page int default 1)
returns table (id uuid, name text, name_kana text, industry text, phone text, contact_count bigint, open_tasks bigint,
               last_interaction_at timestamptz, created_at timestamptz, total_count bigint)
language sql stable security invoker set search_path = public, extensions as $$
  with base as (
    select c.id, c.name, c.name_kana, c.industry, c.phone, c.created_at,
      case when sort = 'recent_contact' then public.company_last_interaction(org, c.id) end as sort_contact
    from public.companies c
    where c.organization_id = org
      and (q is null or btrim(q) = '' or c.name ilike '%' || btrim(q) || '%' or c.name_kana ilike '%' || btrim(q) || '%'
           or c.industry ilike '%' || btrim(q) || '%' or c.name_key = public.normalize_name(q))
  ), paged as (
    select b.*, count(*) over () as total_count from base b
    order by
      case when sort = 'name' then coalesce(b.name_kana, b.name) end asc,
      case when sort = 'recent_contact' then b.sort_contact end desc nulls last,
      case when sort = 'created' then b.created_at end desc,
      b.name, b.id
    limit least(greatest(page_size, 1), 200) offset (greatest(page, 1) - 1) * least(greatest(page_size, 1), 200)
  )
  select p.id, p.name, p.name_kana, p.industry, p.phone,
    (select count(*) from public.person_company_links l where l.organization_id = org and l.company_id = p.id),
    (select count(*) from public.tasks t where t.organization_id = org and t.company_id = p.id and t.status = 'open'),
    coalesce(p.sort_contact, public.company_last_interaction(org, p.id)),
    p.created_at, p.total_count
  from paged p
  order by
    case when sort = 'name' then coalesce(p.name_kana, p.name) end asc,
    case when sort = 'recent_contact' then p.sort_contact end desc nulls last,
    case when sort = 'created' then p.created_at end desc,
    p.name, p.id
$$;
