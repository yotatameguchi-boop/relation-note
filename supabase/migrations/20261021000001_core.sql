-- 基本設計書 §9〜§10：団体・スタッフ・権限と、マルチテナントの土台
-- 方針：
--   * 団体に属する主要データはすべて organization_id を持つ。
--   * 関連データの外部キーにも organization_id を含め、別団体の行へ紐づけられないようにする。
--   * 参照・追加・更新・削除は RLS で memberships に基づいて制御する。

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ------------------------------------------------------------
-- プラン（§2.3 標準プランの利用枠案）
-- ------------------------------------------------------------
create table public.plans (
  id text primary key,
  name text not null,
  monthly_price_jpy integer,
  yearly_price_jpy integer,
  max_staff integer not null,
  max_people integer not null,
  max_photo_analyses_per_month integer not null,
  max_storage_bytes bigint not null,
  max_concurrent_jobs integer not null default 3,
  created_at timestamptz not null default now()
);

insert into public.plans (id, name, monthly_price_jpy, yearly_price_jpy, max_staff, max_people,
                          max_photo_analyses_per_month, max_storage_bytes, max_concurrent_jobs)
values
  ('standard', '標準プラン', 4980, 49800, 10, 10000, 200, 5::bigint * 1024 * 1024 * 1024, 3),
  ('large', '上位プラン（個別契約）', null, null, 100, 100000, 5000, 200::bigint * 1024 * 1024 * 1024, 10);

-- ------------------------------------------------------------
-- 団体・ユーザー
-- ------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'suspended', 'cancelled')),
  plan_id text not null default 'standard' references public.plans(id),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  -- §5「関係人口」の定義：対象期間（日）と、何回以上の参加を継続とみなすか
  relation_window_days integer not null default 365 check (relation_window_days between 1 and 3650),
  repeat_threshold integer not null default 2 check (repeat_threshold between 2 and 100),
  photo_retention_days integer not null default 365 check (photo_retention_days between 1 and 3650),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- auth.users のプロフィール（スタッフ）。管理対象の参加者（people）とは別データ。
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- 明示的に制御する権限（§3）。owner は常にすべて持つ。
create type public.org_role as enum ('owner', 'admin', 'editor', 'viewer');

create table public.memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role public.org_role not null,
  -- 'bulk_export' | 'bulk_delete' | 'merge_people' | 'manage_permissions'
  permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  check (permissions <@ array['bulk_export', 'bulk_delete', 'merge_people', 'manage_permissions']::text[])
);
create index memberships_user_idx on public.memberships(user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.org_role not null check (role <> 'owner'),
  permissions text[] not null default '{}',
  token_hash text not null unique,
  invited_by uuid references public.users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references public.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_org_idx on public.invitations(organization_id, created_at desc);

-- ------------------------------------------------------------
-- 権限判定ヘルパー（RLS から使う）
-- security definer で memberships を直接読み、RLS の再帰を避ける。
-- ------------------------------------------------------------
create or replace function public.role_rank(r public.org_role) returns int
language sql immutable as $$
  select case r when 'owner' then 4 when 'admin' then 3 when 'editor' then 2 else 1 end
$$;

create or replace function public.my_role(org uuid) returns public.org_role
language sql stable security definer set search_path = public, extensions as $$
  select m.role from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = org and m.user_id = auth.uid() and o.status <> 'cancelled'
$$;

create or replace function public.is_member(org uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select public.my_role(org) is not null
$$;

create or replace function public.has_role(org uuid, min_role public.org_role) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(public.role_rank(public.my_role(org)) >= public.role_rank(min_role), false)
$$;

create or replace function public.has_perm(org uuid, perm text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org and m.user_id = auth.uid() and o.status <> 'cancelled'
      and (m.role = 'owner' or perm = any(m.permissions))
  )
$$;

-- 例外を投げる版（RPC の冒頭で使う）
create or replace function public.require_role(org uuid, min_role public.org_role) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.has_role(org, min_role) then
    raise exception 'forbidden' using errcode = '42501', hint = 'role ' || min_role || ' required';
  end if;
end $$;

create or replace function public.require_perm(org uuid, perm text) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.has_perm(org, perm) then
    raise exception 'forbidden' using errcode = '42501', hint = 'permission ' || perm || ' required';
  end if;
end $$;

-- ------------------------------------------------------------
-- 操作履歴
-- ------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references public.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs(organization_id, created_at desc);

create or replace function public.audit(org uuid, act text, ttype text, tid text, det jsonb default '{}')
returns void language sql security definer set search_path = public, extensions as $$
  insert into public.audit_logs (organization_id, actor_id, action, target_type, target_id, detail)
  values (org, auth.uid(), act, ttype, tid, coalesce(det, '{}'));
$$;

-- ------------------------------------------------------------
-- 最後のオーナーの削除・脱退を禁止（§3）
-- ------------------------------------------------------------
create or replace function public.protect_last_owner() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  remaining int;
begin
  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    -- 団体ごと削除されている最中は対象外
    if not exists (select 1 from public.organizations where id = old.organization_id) then
      return coalesce(new, old);
    end if;
    select count(*) into remaining from public.memberships
      where organization_id = old.organization_id and role = 'owner' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'last_owner' using errcode = 'P0001', hint = '最後のオーナーは削除・変更できません。先に所有権を移譲してください。';
    end if;
  end if;
  return coalesce(new, old);
end $$;

create trigger memberships_protect_last_owner before update or delete on public.memberships
  for each row execute function public.protect_last_owner();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.organizations enable row level security;
alter table public.users enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_logs enable row level security;

create policy plans_read on public.plans for select to authenticated using (true);

create policy orgs_read on public.organizations for select to authenticated using (public.is_member(id));
-- 団体設定の変更はオーナーのみ。作成・削除は RPC 経由。
create policy orgs_update on public.organizations for update to authenticated
  using (public.has_role(id, 'owner')) with check (public.has_role(id, 'owner'));

create policy users_read on public.users for select to authenticated using (
  id = auth.uid()
  or exists (
    select 1 from public.memberships mine
    join public.memberships theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid() and theirs.user_id = public.users.id
  )
);
create policy users_update_self on public.users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy memberships_read on public.memberships for select to authenticated
  using (public.is_member(organization_id));
-- 変更は RPC（set_member_role / remove_member / leave_organization）経由のみ

create policy invitations_read on public.invitations for select to authenticated
  using (public.has_role(organization_id, 'admin'));

create policy audit_read on public.audit_logs for select to authenticated
  using (public.has_role(organization_id, 'admin'));

-- 列の直接更新を制限：organizations の plan / status は課金側（サービスロール）のみ
revoke update on public.organizations from authenticated;
grant update (name, relation_window_days, repeat_threshold, photo_retention_days) on public.organizations to authenticated;
revoke update on public.users from authenticated;
grant update (display_name) on public.users to authenticated;
