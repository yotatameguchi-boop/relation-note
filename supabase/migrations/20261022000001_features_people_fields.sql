-- 機能フラグ、人物の共有対象項目（表示名・関心分野・スキル）、共有用の個別権限

-- ------------------------------------------------------------
-- 機能フラグ（団体ごと）。変更はサービスロール（運営側）のみ。
-- 実データで有効化する前に、検証用の団体だけで有効にして確認する。
-- ------------------------------------------------------------
create table public.organization_features (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  partner_sharing boolean not null default false,      -- 団体間の連携・活動者データ共有
  photo_pipeline_v2 boolean not null default false,    -- 画像の前処理・検出枠の整理・修正UI
  photo_tiling boolean not null default false,          -- 高解像度画像の領域分割解析（評価用）
  updated_at timestamptz not null default now()
);
alter table public.organization_features enable row level security;
create policy organization_features_read on public.organization_features for select to authenticated
  using (public.is_member(organization_id));

create or replace function public.feature_enabled(org uuid, flag text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((
    select case flag
      when 'partner_sharing' then f.partner_sharing
      when 'photo_pipeline_v2' then f.photo_pipeline_v2
      when 'photo_tiling' then f.photo_tiling
    end
    from public.organization_features f where f.organization_id = org
  ), false)
$$;

-- ------------------------------------------------------------
-- 人物：共有対象として選べる項目を追加
-- ------------------------------------------------------------
alter table public.people
  add column display_name text check (display_name is null or char_length(display_name) <= 100),
  add column interests text[] not null default '{}',
  add column skills text[] not null default '{}';
grant update (display_name, interests, skills) on public.people to authenticated;

-- ------------------------------------------------------------
-- 個別権限の追加
--   manage_sharing : 連携の申請・承認・解除、共有根拠の記録、共有の設定・停止（管理者以上に付与）
--   view_shared    : 他団体から共有された活動者の閲覧
-- ------------------------------------------------------------
alter table public.memberships drop constraint memberships_permissions_check;
alter table public.memberships add constraint memberships_permissions_check check (
  permissions <@ array['bulk_export', 'bulk_delete', 'merge_people', 'manage_permissions', 'manage_sharing', 'view_shared']::text[]
);

create or replace function public.default_permissions(r public.org_role) returns text[]
language sql immutable as $$
  select case r
    when 'owner' then array['bulk_export', 'bulk_delete', 'merge_people', 'manage_permissions', 'manage_sharing', 'view_shared']
    when 'admin' then array['bulk_export', 'merge_people']
    else array[]::text[]
  end
$$;
