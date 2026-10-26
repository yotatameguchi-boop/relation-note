-- 二段階認証（TOTP：認証アプリの6桁のコード）
--   組織のオーナーが「二段階認証を必須にする」と、その組織のデータは二段階認証を済ませたログイン（aal2）でしか読めない。
--   画面だけでなく DB の権限判定（RLS が使う関数）で強制するので、API を直接呼んでも回避できない。

alter table public.organizations add column require_mfa boolean not null default false;

-- 今のログインが二段階認証済みか
create or replace function public.session_is_aal2() returns boolean
language sql stable set search_path = public, extensions as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
$$;

-- 権限判定に「二段階認証が必須の組織では aal2 であること」を加える（判定の他の部分は従来どおり）
create or replace function public.my_role(org uuid) returns public.org_role
language sql stable security definer set search_path = public, extensions as $$
  select m.role from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = org and m.user_id = auth.uid() and o.status <> 'cancelled'
    and (not o.require_mfa or public.session_is_aal2())
$$;

create or replace function public.has_role(org uuid, min_role public.org_role) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((
    select public.role_rank(m.role) >= public.role_rank(min_role)
             and (o.status = 'active' or min_role = 'viewer')
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org and m.user_id = auth.uid() and o.status <> 'cancelled'
      and (not o.require_mfa or public.session_is_aal2())
  ), false)
$$;

create or replace function public.has_perm(org uuid, perm text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org and m.user_id = auth.uid() and o.status <> 'cancelled'
      and (not o.require_mfa or public.session_is_aal2())
      and (m.role = 'owner' or perm = any(m.permissions))
  )
$$;

create or replace function public.my_org_ids(min_role public.org_role default 'viewer') returns setof uuid
language sql stable security definer set search_path = public, extensions as $$
  select m.organization_id from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = auth.uid() and o.status <> 'cancelled'
    and public.role_rank(m.role) >= public.role_rank(min_role)
    and (o.status = 'active' or min_role = 'viewer')
    and (not o.require_mfa or public.session_is_aal2())
$$;

-- 画面の案内用：この組織に入るのに何が必要か（所属していない組織については何も教えない）
--   ok / verify（コードの入力が必要）/ enroll（二段階認証の設定が必要）/ none（所属していない）
create or replace function public.mfa_gate(org uuid) returns text
language sql stable security definer set search_path = public, extensions, auth as $$
  select case
    when not exists (select 1 from public.memberships m join public.organizations o on o.id = m.organization_id
                     where m.organization_id = org and m.user_id = auth.uid() and o.status <> 'cancelled') then 'none'
    when not (select o.require_mfa from public.organizations o where o.id = org) or public.session_is_aal2() then 'ok'
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified') then 'verify'
    else 'enroll'
  end
$$;

-- 二段階認証の必須化（オーナーのみ。自分が締め出されないよう、必須にするときは自分が二段階認証済みであること）
create or replace function public.set_org_require_mfa(org uuid, required boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.require_role(org, 'owner');
  if required and not public.session_is_aal2() then
    raise exception 'mfa_required_self' using errcode = 'P0001',
      hint = '先にご自身の二段階認証を設定し、コードを入力してログインしてください。';
  end if;
  update public.organizations set require_mfa = required where id = org;
  perform public.audit(org, case when required then 'org.require_mfa_on' else 'org.require_mfa_off' end, 'organization', org::text, '{}'::jsonb);
end $$;

-- 組織のスタッフの二段階認証の設定状況（管理者以上。誰が未設定かを確認して声をかけるため）
create or replace function public.member_mfa_status(org uuid) returns table (user_id uuid, has_mfa boolean)
language plpgsql stable security definer set search_path = public, extensions, auth as $$
begin
  perform public.require_role(org, 'admin');
  return query
    select m.user_id, exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified')
    from public.memberships m where m.organization_id = org;
end $$;

revoke execute on function public.mfa_gate(uuid), public.set_org_require_mfa(uuid, boolean), public.member_mfa_status(uuid) from public, anon;
grant execute on function public.mfa_gate(uuid), public.set_org_require_mfa(uuid, boolean), public.member_mfa_status(uuid) to authenticated;

-- 二段階認証が必須のため今は入れない、自分の所属組織（組織の一覧で案内する）
create or replace function public.mfa_blocked_orgs() returns table (id uuid, name text)
language sql stable security definer set search_path = public, extensions as $$
  select o.id, o.name from public.memberships m join public.organizations o on o.id = m.organization_id
  where m.user_id = auth.uid() and o.status <> 'cancelled' and o.require_mfa and not public.session_is_aal2()
  order by o.name
$$;
revoke execute on function public.mfa_blocked_orgs() from public, anon;
grant execute on function public.mfa_blocked_orgs() to authenticated;
