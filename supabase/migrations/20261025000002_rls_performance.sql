-- 負荷試験（10万人規模の組織）で、RLS の is_member()/has_role() が「行ごと」に呼ばれ、
-- 人物の件数を数えるだけで約8秒かかることが分かった（1回 約80µs × 10万行）。
-- 所属組織の一覧を1回だけ求める my_org_ids() に置き換え、条件を「organization_id IN (SELECT …)」にする。
-- Postgres はこれをクエリごとに1回だけ評価する（initplan）。判定の中身（役割の順位・停止中は閲覧のみ・解約済みは不可）は同じ。

create or replace function public.my_org_ids(min_role public.org_role default 'viewer') returns setof uuid
language sql stable security definer set search_path = public, extensions as $$
  select m.organization_id from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = auth.uid() and o.status <> 'cancelled'
    and public.role_rank(m.role) >= public.role_rank(min_role)
    and (o.status = 'active' or min_role = 'viewer')
$$;
revoke execute on function public.my_org_ids(public.org_role) from public, anon;
grant execute on function public.my_org_ids(public.org_role) to authenticated, service_role;

do $$
declare
  p record;
  q text;
  c text;
  changed int := 0;
begin
  for p in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    q := p.qual;
    c := p.with_check;
    -- has_role(x, '役割') → x IN (SELECT my_org_ids('役割'))、is_member(x) → x IN (SELECT my_org_ids('viewer'))
    q := regexp_replace(q, $re$has_role\((organization_id|id), ('(owner|admin|editor|viewer)'::org_role)\)$re$, '(\1 IN ( SELECT public.my_org_ids(\2)))', 'g');
    q := regexp_replace(q, $re$is_member\((organization_id|id)\)$re$, '(\1 IN ( SELECT public.my_org_ids(''viewer''::org_role)))', 'g');
    c := regexp_replace(c, $re$has_role\((organization_id|id), ('(owner|admin|editor|viewer)'::org_role)\)$re$, '(\1 IN ( SELECT public.my_org_ids(\2)))', 'g');
    c := regexp_replace(c, $re$is_member\((organization_id|id)\)$re$, '(\1 IN ( SELECT public.my_org_ids(''viewer''::org_role)))', 'g');
    if q is distinct from p.qual or c is distinct from p.with_check then
      execute format('alter policy %I on public.%I %s %s', p.policyname, p.tablename,
        case when q is not null then format('using (%s)', q) else '' end,
        case when c is not null then format('with check (%s)', c) else '' end);
      changed := changed + 1;
    end if;
  end loop;
  raise notice 'rewrote % policies', changed;
end $$;
