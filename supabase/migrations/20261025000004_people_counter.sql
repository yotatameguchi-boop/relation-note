-- 負荷試験で、10万人の組織に人物を追加すると、上限確認のため1行ごとに全件を数えていた
-- （2,000行の取り込みで約6秒。人数に比例して遅くなる）。また全画面で呼ぶ org_usage() も毎回全件を数えていた。
-- 組織ごとの人数を数え続ける表を置き、上限確認は「文」単位で1回だけ行う。
--   ・同じ組織への同時追加は、カウンター行の更新ロックで直列になり、上限を超えない
--   ・上限を超える追加は文ごと失敗する（従来どおり。エラー内容も同じ）

create table public.org_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  people integer not null default 0 check (people >= 0)
);
alter table public.org_counters enable row level security;  -- 直接は読ませない（org_usage 経由）

insert into public.org_counters (organization_id, people)
select o.id, (select count(*) from public.people p where p.organization_id = o.id) from public.organizations o;

create or replace function public.trg_org_counter_new() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.org_counters (organization_id) values (new.id) on conflict do nothing;
  return null;
end $$;
create trigger organizations_counter after insert on public.organizations
  for each row execute function public.trg_org_counter_new();

-- 追加：件数を足してから上限を確かめる（超えたら例外で文ごと取り消し）
create or replace function public.trg_people_count_insert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  r record;
begin
  for r in
    with added as (select organization_id, count(*) n from new_rows group by organization_id)
    update public.org_counters c set people = c.people + a.n
    from added a where c.organization_id = a.organization_id
    returning c.organization_id, c.people
  loop
    if r.people > (select p.max_people from public.organizations o join public.plans p on p.id = o.plan_id where o.id = r.organization_id) then
      raise exception 'quota_exceeded:people' using errcode = 'P0001',
        hint = '登録人物数がプランの上限（' || (select p.max_people from public.organizations o join public.plans p on p.id = o.plan_id where o.id = r.organization_id) || '人）に達しています。';
    end if;
  end loop;
  return null;
end $$;

create or replace function public.trg_people_count_delete() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  with removed as (select organization_id, count(*) n from old_rows group by organization_id)
  update public.org_counters c set people = greatest(c.people - r.n, 0)
  from removed r where c.organization_id = r.organization_id;
  return null;
end $$;

drop trigger people_limit on public.people;
create trigger people_count_insert after insert on public.people
  referencing new table as new_rows for each statement execute function public.trg_people_count_insert();
create trigger people_count_delete after delete on public.people
  referencing old table as old_rows for each statement execute function public.trg_people_count_delete();

do $$
begin
  execute 'revoke execute on function public.trg_people_count_insert() from public, anon, authenticated';
  execute 'revoke execute on function public.trg_people_count_delete() from public, anon, authenticated';
  execute 'revoke execute on function public.trg_org_counter_new() from public, anon, authenticated';
end $$;

-- 利用量：人数はカウンターから読む
create or replace function public.org_usage(org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  p public.plans;
begin
  perform public.require_role(org, 'viewer');
  select pl.* into p from public.organizations o join public.plans pl on pl.id = o.plan_id where o.id = org;
  return jsonb_build_object(
    'plan', jsonb_build_object('id', p.id, 'name', p.name),
    'period', public.current_period(),
    'staff', jsonb_build_object('used', public.staff_seats_used(org), 'limit', p.max_staff),
    'people', jsonb_build_object('used', coalesce((select c.people from public.org_counters c where c.organization_id = org), 0), 'limit', p.max_people),
    'photo_analysis', jsonb_build_object('used', public.usage_in_use(org, 'photo_analysis'), 'limit', p.max_photo_analyses_per_month),
    'storage_bytes', jsonb_build_object('used', public.usage_in_use(org, 'storage_bytes'), 'limit', p.max_storage_bytes)
  );
end $$;
