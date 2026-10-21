-- 団体間の連携・活動者データ共有
--
-- 原則
--   * 既存の「自団体だけを参照できる RLS」は変更しない。共有元の people などを共有先へ開放しない。
--   * 連携（organization_partnerships）と、個々の共有許可（person_share_grants）を分けて管理する。
--     連携の承認だけでは何も見えない。
--   * 共有は一方向。共有先が受け取った情報は people に入らないので、第三者へ再共有する経路がない。
--   * 共有先が読めるのは、公開済みのスナップショット（person_share_versions）のうち許可された項目だけ。
--     共有先向けの RLS ポリシーは置かず、状態を毎回確認する DB 関数だけを入口にする。
--   * 状態（連携・共有・期限・根拠・機能フラグ・所属・権限）はアクセス時に確認する。定期ジョブに依存しない。

-- 共有できる項目
create or replace function public.share_field_keys() returns text[]
language sql immutable as $$
  select array['display_name', 'full_name', 'region', 'interests', 'skills', 'tags', 'activities', 'email', 'phone']
$$;

-- 連携申請に使うコード（団体IDを相手に教えずに申請できるようにする）
alter table public.organizations
  add column partner_code text not null unique
    default upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 12));

-- ------------------------------------------------------------
-- 連携
-- ------------------------------------------------------------
create table public.organization_partnerships (
  id uuid primary key default gen_random_uuid(),
  org_low uuid not null references public.organizations(id) on delete cascade,
  org_high uuid not null references public.organizations(id) on delete cascade,
  requester_org uuid not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'cancelled', 'dissolved')),
  message text check (char_length(message) <= 500),
  requested_by uuid references public.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  responded_by uuid references public.users(id) on delete set null,
  responded_at timestamptz,
  dissolved_by uuid references public.users(id) on delete set null,
  dissolved_at timestamptz,
  check (org_low < org_high),
  check (requester_org in (org_low, org_high))
);
create unique index organization_partnerships_open_idx on public.organization_partnerships(org_low, org_high)
  where status in ('pending', 'active');
create index organization_partnerships_high_idx on public.organization_partnerships(org_high);

create or replace function public.partnership_active(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.organization_partnerships
                 where org_low = least(a, b) and org_high = greatest(a, b) and status = 'active')
$$;

-- ------------------------------------------------------------
-- 共有根拠（本人同意など）。法的妥当性はアプリでは判断せず、スタッフが確認した記録を保存する。
-- ------------------------------------------------------------
create table public.sharing_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,                 -- 共有元
  person_id uuid not null,
  target_organization_id uuid not null references public.organizations(id) on delete cascade,
  basis_type text not null check (basis_type in ('consent', 'contract', 'other')),
  basis_detail text check (char_length(basis_detail) <= 1000),
  purpose text not null check (char_length(purpose) between 1 and 500),
  allowed_fields text[] not null,
  evidence_ref text check (char_length(evidence_ref) <= 500),   -- 同意書の保管場所、回答ID など
  evidence_submission_id uuid,
  confirmed_by uuid references public.users(id) on delete set null,
  confirmed_at timestamptz not null,
  valid_until timestamptz,
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_by uuid references public.users(id) on delete set null,
  withdrawn_at timestamptz,
  withdraw_reason text check (char_length(withdraw_reason) <= 500),
  created_at timestamptz not null default now(),
  check (organization_id <> target_organization_id),
  check (cardinality(allowed_fields) > 0 and allowed_fields <@ public.share_field_keys()),
  unique (organization_id, person_id, target_organization_id, id),
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade,
  foreign key (organization_id, evidence_submission_id) references public.form_submissions(organization_id, id) on delete set null (evidence_submission_id)
);
create index sharing_authorizations_person_idx on public.sharing_authorizations(organization_id, person_id);

-- ------------------------------------------------------------
-- 共有許可（活動者 × 共有先）
-- ------------------------------------------------------------
create table public.person_share_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,                 -- 共有元
  target_organization_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null,
  authorization_id uuid not null,
  fields text[] not null,
  tag_ids uuid[] not null default '{}',           -- 共有元が選んだタグ
  participation_ids uuid[] not null default '{}', -- 共有元が選んだ活動履歴（参加確認済みのみ）
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'stopped', 'expired')),
  stop_reason text,
  current_version integer not null default 0,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stopped_by uuid references public.users(id) on delete set null,
  stopped_at timestamptz,
  check (organization_id <> target_organization_id),
  check (cardinality(fields) > 0 and fields <@ public.share_field_keys()),
  unique (organization_id, id),
  -- 元人物・共有根拠・共有先の団体が一致することを DB 制約で保証する
  foreign key (organization_id, person_id) references public.people(organization_id, id) on delete cascade,
  foreign key (organization_id, person_id, target_organization_id, authorization_id)
    references public.sharing_authorizations(organization_id, person_id, target_organization_id, id) on delete cascade
);
create unique index person_share_grants_one_active_idx on public.person_share_grants(organization_id, person_id, target_organization_id)
  where status = 'active';
create index person_share_grants_target_idx on public.person_share_grants(target_organization_id, status);

-- 公開した版（許可された値だけのスナップショット）
create table public.person_share_versions (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.person_share_grants(id) on delete cascade,
  organization_id uuid not null,
  target_organization_id uuid not null,
  version integer not null,
  fields text[] not null,
  snapshot jsonb not null,
  published_by uuid references public.users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (grant_id, version),
  foreign key (organization_id, grant_id) references public.person_share_grants(organization_id, id) on delete cascade
);

-- 共有の監査記録（共有データ本文は保存しない。項目名・件数・版番号だけ）
create table public.sharing_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.users(id) on delete set null,
  actor_organization_id uuid references public.organizations(id) on delete set null,
  source_organization_id uuid references public.organizations(id) on delete cascade,
  target_organization_id uuid references public.organizations(id) on delete cascade,
  partnership_id uuid,
  grant_id uuid,
  authorization_id uuid,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index sharing_audit_logs_source_idx on public.sharing_audit_logs(source_organization_id, created_at desc);
create index sharing_audit_logs_target_idx on public.sharing_audit_logs(target_organization_id, created_at desc);

create or replace function public.sharing_audit(actor_org uuid, src uuid, tgt uuid, act text,
                                                p_partnership uuid default null, p_grant uuid default null,
                                                p_authorization uuid default null, det jsonb default '{}')
returns void language sql security definer set search_path = public, extensions as $$
  insert into public.sharing_audit_logs (actor_id, actor_organization_id, source_organization_id, target_organization_id,
                                         partnership_id, grant_id, authorization_id, action, detail)
  values (auth.uid(), actor_org, src, tgt, p_partnership, p_grant, p_authorization, act, coalesce(det, '{}'));
$$;
revoke execute on function public.sharing_audit(uuid, uuid, uuid, text, uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- RLS：共有元の管理者（共有設定の権限）だけが自団体側の行を読める。共有先向けのポリシーは置かない。
-- ------------------------------------------------------------
create or replace function public.can_manage_sharing(org uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select public.has_role(org, 'admin') and public.has_perm(org, 'manage_sharing')
$$;

alter table public.organization_partnerships enable row level security;
alter table public.sharing_authorizations enable row level security;
alter table public.person_share_grants enable row level security;
alter table public.person_share_versions enable row level security;
alter table public.sharing_audit_logs enable row level security;

create policy partnerships_read on public.organization_partnerships for select to authenticated
  using (public.can_manage_sharing(org_low) or public.can_manage_sharing(org_high)
         or public.has_perm(org_low, 'view_shared') or public.has_perm(org_high, 'view_shared'));
create policy authorizations_read on public.sharing_authorizations for select to authenticated
  using (public.can_manage_sharing(organization_id));
create policy grants_read on public.person_share_grants for select to authenticated
  using (public.can_manage_sharing(organization_id));
create policy versions_read on public.person_share_versions for select to authenticated
  using (public.can_manage_sharing(organization_id));
create policy sharing_audit_read on public.sharing_audit_logs for select to authenticated
  using (public.can_manage_sharing(source_organization_id) or public.can_manage_sharing(target_organization_id));

do $$
declare t text;
begin
  foreach t in array array['sharing_authorizations', 'person_share_grants', 'person_share_versions'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.prevent_org_change()',
                   t || '_no_org_change', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 判定
-- ------------------------------------------------------------
create or replace function public.require_sharing_admin(org uuid) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.require_role(org, 'admin');
  perform public.require_perm(org, 'manage_sharing');
  if not public.feature_enabled(org, 'partner_sharing') then
    raise exception 'feature_disabled' using hint = '団体間共有はこの団体で有効になっていません。';
  end if;
end $$;

-- 根拠の状態：active / withdrawn / expired
create or replace function public.authorization_state(a public.sharing_authorizations) returns text
language sql stable as $$
  select case
    when a.status = 'withdrawn' then 'withdrawn'
    when a.valid_until is not null and a.valid_until <= now() then 'expired'
    else 'active'
  end
$$;

-- 共有の状態。共有先からのアクセスはすべてこれが 'live' のときだけ許可する。
create or replace function public.share_grant_state(g public.person_share_grants) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  a public.sharing_authorizations;
begin
  if g.status = 'stopped' then return 'stopped'; end if;
  if g.status = 'expired' or g.expires_at <= now() then return 'expired'; end if;
  if not public.feature_enabled(g.organization_id, 'partner_sharing')
     or not public.feature_enabled(g.target_organization_id, 'partner_sharing') then
    return 'feature_disabled';
  end if;
  if not public.partnership_active(g.organization_id, g.target_organization_id) then return 'partnership_inactive'; end if;
  select * into a from public.sharing_authorizations where id = g.authorization_id;
  if a.id is null then return 'authorization_missing'; end if;
  if public.authorization_state(a) <> 'active' then return 'authorization_' || public.authorization_state(a); end if;
  if a.target_organization_id <> g.target_organization_id or a.person_id <> g.person_id
     or not (g.fields <@ a.allowed_fields) then
    return 'authorization_mismatch';
  end if;
  if g.current_version = 0 then return 'not_published'; end if;
  if exists (select 1 from public.organizations o where o.id in (g.organization_id, g.target_organization_id) and o.status = 'cancelled') then
    return 'organization_inactive';
  end if;
  return 'live';
end $$;

-- 共有先として閲覧できる立場か（有効な所属＋共有閲覧の権限＋機能フラグ）
create or replace function public.require_shared_viewer(org uuid) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.require_role(org, 'viewer');
  perform public.require_perm(org, 'view_shared');
  if not public.feature_enabled(org, 'partner_sharing') then
    raise exception 'feature_disabled' using hint = '団体間共有はこの団体で有効になっていません。';
  end if;
end $$;

-- ------------------------------------------------------------
-- 連携の申請・承認・拒否・解除
-- ------------------------------------------------------------
create or replace function public.request_partnership(org uuid, code text, msg text default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  other uuid;
  pid uuid;
begin
  perform public.require_sharing_admin(org);
  select id into other from public.organizations where partner_code = upper(btrim(code)) and status = 'active';
  -- 相手が存在しない／自団体／相手の機能が無効、のいずれも同じ応答にする（団体の存在を探れないように）
  if other is null or other = org or not public.feature_enabled(other, 'partner_sharing') then
    raise exception 'partner_not_found' using hint = '連携コードに該当する団体が見つかりません。';
  end if;
  insert into public.organization_partnerships (org_low, org_high, requester_org, message, requested_by)
    values (least(org, other), greatest(org, other), org, nullif(btrim(msg), ''), auth.uid())
    returning id into pid;
  perform public.sharing_audit(org, org, other, 'partnership.request', pid);
  return pid;
exception when unique_violation then
  raise exception 'partnership_exists' using hint = 'この団体とはすでに連携中か、申請中です。';
end $$;

create or replace function public.respond_partnership(partnership uuid, accept boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  p public.organization_partnerships;
  me uuid;
begin
  select * into p from public.organization_partnerships where id = partnership for update;
  if p.id is null or p.status <> 'pending' then raise exception 'not_found'; end if;
  -- 承認・拒否できるのは申請された側だけ
  me := case when p.requester_org = p.org_low then p.org_high else p.org_low end;
  perform public.require_sharing_admin(me);
  update public.organization_partnerships set status = case when accept then 'active' else 'rejected' end,
    responded_by = auth.uid(), responded_at = now() where id = p.id;
  perform public.sharing_audit(me, p.requester_org, me, case when accept then 'partnership.approve' else 'partnership.reject' end, p.id);
end $$;

create or replace function public.end_partnership(partnership uuid, org uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  p public.organization_partnerships;
  other uuid;
begin
  select * into p from public.organization_partnerships where id = partnership for update;
  if p.id is null or org not in (p.org_low, p.org_high) or p.status not in ('pending', 'active') then raise exception 'not_found'; end if;
  perform public.require_role(org, 'admin');
  perform public.require_perm(org, 'manage_sharing');  -- 機能を無効にした後でも解除はできる
  other := case when org = p.org_low then p.org_high else p.org_low end;
  if p.status = 'pending' and p.requester_org <> org then
    raise exception 'not_found';   -- 受けた申請は respond_partnership で拒否する
  end if;
  update public.organization_partnerships
    set status = case when p.status = 'pending' then 'cancelled' else 'dissolved' end,
        dissolved_by = auth.uid(), dissolved_at = now()
    where id = p.id;
  -- 連携解除で、両方向の共有を即時に停止する（閲覧判定は連携状態も見るので、この更新を待たずに閲覧不可）
  update public.person_share_grants set status = 'stopped', stop_reason = 'partnership_dissolved',
    stopped_by = auth.uid(), stopped_at = now(), updated_at = now()
    where status = 'active'
      and ((organization_id = p.org_low and target_organization_id = p.org_high)
        or (organization_id = p.org_high and target_organization_id = p.org_low));
  perform public.sharing_audit(org, org, other, case when p.status = 'pending' then 'partnership.cancel' else 'partnership.dissolve' end, p.id);
end $$;

-- 連携一覧（相手の団体名は、連携・申請の当事者にだけ返す）
create or replace function public.list_partnerships(org uuid)
returns table (id uuid, partner_id uuid, partner_name text, status text, direction text, message text,
               requested_at timestamptz, responded_at timestamptz, dissolved_at timestamptz,
               outgoing_live integer, incoming_live integer)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not (public.can_manage_sharing(org) or public.has_perm(org, 'view_shared')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select p.id, o.id, o.name, p.status,
         case when p.requester_org = org then 'outgoing' else 'incoming' end,
         p.message, p.requested_at, p.responded_at, p.dissolved_at,
         (select count(*)::int from public.person_share_grants g
           where g.organization_id = org and g.target_organization_id = o.id and public.share_grant_state(g) = 'live'),
         (select count(*)::int from public.person_share_grants g
           where g.organization_id = o.id and g.target_organization_id = org and public.share_grant_state(g) = 'live')
  from public.organization_partnerships p
  join public.organizations o on o.id = case when p.org_low = org then p.org_high else p.org_low end
  where org in (p.org_low, p.org_high)
  order by (p.status in ('pending', 'active')) desc, p.requested_at desc;
end $$;

-- ------------------------------------------------------------
-- 共有根拠の記録・撤回
-- ------------------------------------------------------------
create or replace function public.record_sharing_authorizations(
  org uuid, person_ids uuid[], target uuid, p_basis_type text, p_basis_detail text, p_purpose text,
  p_allowed_fields text[], p_evidence_ref text, p_confirmed_at timestamptz, p_valid_until timestamptz default null,
  p_evidence_submission uuid default null
) returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  n int;
begin
  perform public.require_sharing_admin(org);
  if not public.partnership_active(org, target) then
    raise exception 'partnership_inactive' using hint = '連携中の団体に対してのみ記録できます。';
  end if;
  if p_confirmed_at is null or p_confirmed_at > now() + interval '1 day' then
    raise exception 'invalid_confirmed_at' using hint = '確認日時を入力してください（未来の日時は不可）。';
  end if;
  if p_valid_until is not null and p_valid_until <= now() then
    raise exception 'invalid_valid_until' using hint = '有効期限は未来の日時にしてください。';
  end if;
  if coalesce(cardinality(p_allowed_fields), 0) = 0 or not (p_allowed_fields <@ public.share_field_keys()) then
    raise exception 'invalid_fields' using hint = '対象項目を1つ以上選んでください。';
  end if;
  if (select count(*) from public.people where organization_id = org and id = any(person_ids)) <> cardinality(person_ids) then
    raise exception 'not_found';
  end if;
  insert into public.sharing_authorizations (organization_id, person_id, target_organization_id, basis_type, basis_detail,
      purpose, allowed_fields, evidence_ref, evidence_submission_id, confirmed_by, confirmed_at, valid_until)
    select org, pid, target, p_basis_type, nullif(btrim(p_basis_detail), ''), btrim(p_purpose), p_allowed_fields,
           nullif(btrim(p_evidence_ref), ''), p_evidence_submission, auth.uid(), p_confirmed_at, p_valid_until
    from unnest(person_ids) pid;
  get diagnostics n = row_count;
  perform public.sharing_audit(org, org, target, 'authorization.record', null, null, null,
    jsonb_build_object('people', n, 'basis_type', p_basis_type, 'fields', p_allowed_fields));
  return n;
end $$;

create or replace function public.withdraw_sharing_authorization(auth_id uuid, reason text) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  a public.sharing_authorizations;
  n int;
begin
  select * into a from public.sharing_authorizations where id = auth_id for update;
  if a.id is null then raise exception 'not_found'; end if;
  perform public.require_role(a.organization_id, 'admin');
  perform public.require_perm(a.organization_id, 'manage_sharing');
  update public.sharing_authorizations set status = 'withdrawn', withdrawn_by = auth.uid(), withdrawn_at = now(),
    withdraw_reason = nullif(btrim(reason), '') where id = a.id;
  update public.person_share_grants set status = 'stopped', stop_reason = 'authorization_withdrawn',
    stopped_by = auth.uid(), stopped_at = now(), updated_at = now()
    where authorization_id = a.id and status = 'active';
  get diagnostics n = row_count;
  perform public.sharing_audit(a.organization_id, a.organization_id, a.target_organization_id, 'authorization.withdraw',
    null, null, a.id, jsonb_build_object('stopped_grants', n));
  return n;
end $$;

-- ------------------------------------------------------------
-- スナップショット（許可された項目だけ）
-- ------------------------------------------------------------
create or replace function public.build_share_snapshot(org uuid, pid uuid, p_fields text[], p_tag_ids uuid[], p_participation_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  p public.people;
  out jsonb := '{}';
begin
  select * into p from public.people where organization_id = org and id = pid;
  if p.id is null then raise exception 'not_found'; end if;
  if 'display_name' = any(p_fields) then out := out || jsonb_build_object('display_name', p.display_name); end if;
  if 'full_name' = any(p_fields) then out := out || jsonb_build_object('full_name', p.full_name); end if;
  if 'region' = any(p_fields) then out := out || jsonb_build_object('region', p.region); end if;
  if 'interests' = any(p_fields) then out := out || jsonb_build_object('interests', to_jsonb(p.interests)); end if;
  if 'skills' = any(p_fields) then out := out || jsonb_build_object('skills', to_jsonb(p.skills)); end if;
  if 'tags' = any(p_fields) then
    -- 共有元が選んだタグのうち、現在その人物に付いているものだけ
    out := out || jsonb_build_object('tags', coalesce((
      select jsonb_agg(t.name order by t.name) from public.person_tags pt join public.tags t on t.id = pt.tag_id
      where pt.organization_id = org and pt.person_id = pid and pt.tag_id = any(p_tag_ids)), '[]'));
  end if;
  if 'activities' = any(p_fields) then
    -- 共有元が選んだ活動履歴のうち、参加確認済みの記録だけ（推測した情報は作らない）
    out := out || jsonb_build_object('activities', coalesce((
      select jsonb_agg(jsonb_build_object('title', e.title, 'date', to_char(e.starts_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD'))
                       order by e.starts_at desc)
      from public.event_participations ep join public.events e on e.id = ep.event_id
      where ep.organization_id = org and ep.person_id = pid and ep.id = any(p_participation_ids) and ep.status = 'attended'), '[]'));
  end if;
  if 'email' = any(p_fields) then
    out := out || jsonb_build_object('emails', coalesce((select jsonb_agg(value order by created_at) from public.person_contacts
      where organization_id = org and person_id = pid and kind = 'email'), '[]'));
  end if;
  if 'phone' = any(p_fields) then
    out := out || jsonb_build_object('phones', coalesce((select jsonb_agg(value order by created_at) from public.person_contacts
      where organization_id = org and person_id = pid and kind = 'phone'), '[]'));
  end if;
  return out;
end $$;
revoke execute on function public.build_share_snapshot(uuid, uuid, text[], uuid[], uuid[]) from public, anon, authenticated;

-- 共有前のプレビュー（相手に見える内容）
create or replace function public.preview_share(org uuid, pid uuid, p_fields text[], p_tag_ids uuid[] default '{}',
                                                p_participation_ids uuid[] default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.require_sharing_admin(org);
  return public.build_share_snapshot(org, pid, coalesce(p_fields, '{}'), coalesce(p_tag_ids, '{}'), coalesce(p_participation_ids, '{}'));
end $$;

-- 有効な根拠を探す（共有先・項目・期限をすべて満たすもの）
create or replace function public.find_covering_authorization(org uuid, pid uuid, target uuid, p_fields text[], p_until timestamptz)
returns uuid language sql stable security definer set search_path = public, extensions as $$
  select a.id from public.sharing_authorizations a
  where a.organization_id = org and a.person_id = pid and a.target_organization_id = target
    and public.authorization_state(a) = 'active'
    and p_fields <@ a.allowed_fields
    and (a.valid_until is null or a.valid_until >= p_until)
  order by a.confirmed_at desc
  limit 1
$$;
revoke execute on function public.find_covering_authorization(uuid, uuid, uuid, text[], timestamptz) from public, anon, authenticated;

create or replace function public.publish_share_version_internal(g public.person_share_grants) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v int := g.current_version + 1;
begin
  insert into public.person_share_versions (grant_id, organization_id, target_organization_id, version, fields, snapshot, published_by)
    values (g.id, g.organization_id, g.target_organization_id, v, g.fields,
            public.build_share_snapshot(g.organization_id, g.person_id, g.fields, g.tag_ids, g.participation_ids), auth.uid());
  update public.person_share_grants set current_version = v, updated_at = now() where id = g.id;
  return v;
end $$;
revoke execute on function public.publish_share_version_internal(public.person_share_grants) from public, anon, authenticated;

-- 共有の作成（複数の活動者をまとめて）。根拠が未記録・撤回済み・範囲外の人は作成しない。
create or replace function public.create_share_grants(
  org uuid, target uuid, person_ids uuid[], p_fields text[], p_tag_ids uuid[], p_event_ids uuid[], p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  pid uuid;
  aid uuid;
  gid uuid;
  g public.person_share_grants;
  created jsonb := '[]';
  skipped jsonb := '[]';
  parts uuid[];
begin
  perform public.require_sharing_admin(org);
  if not public.partnership_active(org, target) then
    raise exception 'partnership_inactive' using hint = '連携中の団体にだけ共有できます。';
  end if;
  if not public.feature_enabled(target, 'partner_sharing') then
    raise exception 'partnership_inactive' using hint = '共有先で団体間共有が有効になっていません。';
  end if;
  if coalesce(cardinality(p_fields), 0) = 0 or not (p_fields <@ public.share_field_keys()) then
    raise exception 'invalid_fields' using hint = '共有する項目を1つ以上選んでください。';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '3 years' then
    raise exception 'invalid_expires_at' using hint = '共有期限は今日より後、3年以内で指定してください。';
  end if;
  if exists (select 1 from unnest(coalesce(p_tag_ids, '{}')) t where not exists (select 1 from public.tags where organization_id = org and id = t))
     or exists (select 1 from unnest(coalesce(p_event_ids, '{}')) e where not exists (select 1 from public.events where organization_id = org and id = e)) then
    raise exception 'not_found';
  end if;

  foreach pid in array person_ids loop
    if not exists (select 1 from public.people where organization_id = org and id = pid) then
      skipped := skipped || jsonb_build_object('person_id', pid, 'reason', 'not_found');
      continue;
    end if;
    if exists (select 1 from public.person_share_grants where organization_id = org and person_id = pid
               and target_organization_id = target and status = 'active' and expires_at > now()) then
      skipped := skipped || jsonb_build_object('person_id', pid, 'reason', 'already_shared');
      continue;
    end if;
    aid := public.find_covering_authorization(org, pid, target, p_fields, p_expires_at);
    if aid is null then
      skipped := skipped || jsonb_build_object('person_id', pid, 'reason', 'no_valid_authorization');
      continue;
    end if;
    -- 期限切れのまま残っている行は expired にしてから作り直す
    update public.person_share_grants set status = 'expired', updated_at = now()
      where organization_id = org and person_id = pid and target_organization_id = target and status = 'active';
    select coalesce(array_agg(ep.id), '{}') into parts from public.event_participations ep
      where ep.organization_id = org and ep.person_id = pid and ep.event_id = any(coalesce(p_event_ids, '{}')) and ep.status = 'attended';
    insert into public.person_share_grants (organization_id, target_organization_id, person_id, authorization_id, fields,
                                            tag_ids, participation_ids, expires_at, created_by)
      values (org, target, pid, aid, p_fields, coalesce(p_tag_ids, '{}'), parts, p_expires_at, auth.uid())
      returning * into g;
    perform public.publish_share_version_internal(g);
    created := created || jsonb_build_object('person_id', pid, 'grant_id', g.id);
    perform public.sharing_audit(org, org, target, 'grant.create', null, g.id, aid,
      jsonb_build_object('fields', p_fields, 'tags', cardinality(coalesce(p_tag_ids, '{}')), 'activities', cardinality(parts), 'expires_at', p_expires_at));
  end loop;
  return jsonb_build_object('created', created, 'skipped', skipped);
end $$;

-- 共有内容の変更（項目・タグ・活動履歴・期限）。範囲を広げる場合も根拠を再確認し、新しい版として公開する。
create or replace function public.update_share_grant(grant_id uuid, p_fields text[], p_tag_ids uuid[], p_participation_ids uuid[],
                                                     p_expires_at timestamptz) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.person_share_grants;
  aid uuid;
  v int;
begin
  select * into g from public.person_share_grants where id = grant_id for update;
  if g.id is null then raise exception 'not_found'; end if;
  perform public.require_sharing_admin(g.organization_id);
  if g.status <> 'active' or g.expires_at <= now() then raise exception 'share_not_active' using hint = '停止・期限切れの共有は変更できません。新しく共有してください。'; end if;
  if not public.partnership_active(g.organization_id, g.target_organization_id) then raise exception 'partnership_inactive'; end if;
  if coalesce(cardinality(p_fields), 0) = 0 or not (p_fields <@ public.share_field_keys()) then raise exception 'invalid_fields'; end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '3 years' then raise exception 'invalid_expires_at'; end if;
  aid := public.find_covering_authorization(g.organization_id, g.person_id, g.target_organization_id, p_fields, p_expires_at);
  if aid is null then
    raise exception 'no_valid_authorization' using hint = '選んだ項目・期限を含む有効な共有根拠がありません。根拠を記録してから変更してください。';
  end if;
  update public.person_share_grants set
    authorization_id = aid, fields = p_fields, tag_ids = coalesce(p_tag_ids, '{}'),
    -- 活動履歴は、この人物の参加確認済みの記録に限る
    participation_ids = coalesce((select array_agg(ep.id) from public.event_participations ep
      where ep.organization_id = g.organization_id and ep.person_id = g.person_id and ep.id = any(coalesce(p_participation_ids, '{}'))
        and ep.status = 'attended'), '{}'),
    expires_at = p_expires_at, updated_at = now()
    where id = g.id returning * into g;
  v := public.publish_share_version_internal(g);
  perform public.sharing_audit(g.organization_id, g.organization_id, g.target_organization_id, 'grant.update', null, g.id, aid,
    jsonb_build_object('fields', p_fields, 'version', v, 'expires_at', p_expires_at));
  return v;
end $$;

-- 元データの変更との差分（変わった項目名だけを返す）
create or replace function public.share_grant_diff(grant_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g public.person_share_grants;
  cur jsonb;
  pub jsonb;
begin
  select * into g from public.person_share_grants where id = grant_id;
  if g.id is null then raise exception 'not_found'; end if;
  perform public.require_sharing_admin(g.organization_id);
  cur := public.build_share_snapshot(g.organization_id, g.person_id, g.fields, g.tag_ids, g.participation_ids);
  select snapshot into pub from public.person_share_versions where person_share_versions.grant_id = g.id order by version desc limit 1;
  return jsonb_build_object(
    'current', cur, 'published', coalesce(pub, '{}'),
    'changed_keys', coalesce((select jsonb_agg(k) from (
        select k from jsonb_object_keys(cur) k where cur -> k is distinct from coalesce(pub, '{}') -> k
        union select k from jsonb_object_keys(coalesce(pub, '{}')) k where not cur ? k) x), '[]'));
end $$;

-- 差分を確認したうえで更新版を公開
create or replace function public.publish_share_update(grant_id uuid) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.person_share_grants;
  v int;
begin
  select * into g from public.person_share_grants where id = grant_id for update;
  if g.id is null then raise exception 'not_found'; end if;
  perform public.require_sharing_admin(g.organization_id);
  if public.share_grant_state(g) not in ('live', 'not_published') then
    raise exception 'share_not_active' using hint = 'この共有は現在有効ではないため、更新版を公開できません。';
  end if;
  v := public.publish_share_version_internal(g);
  perform public.sharing_audit(g.organization_id, g.organization_id, g.target_organization_id, 'grant.publish', null, g.id, g.authorization_id,
    jsonb_build_object('version', v));
  return v;
end $$;

create or replace function public.stop_share_grants(org uuid, grant_ids uuid[], reason text default null) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  n int;
  r record;
begin
  -- 停止は機能フラグを無効にした後でもできる
  perform public.require_role(org, 'admin');
  perform public.require_perm(org, 'manage_sharing');
  n := 0;
  for r in update public.person_share_grants set status = 'stopped', stop_reason = coalesce(nullif(btrim(reason), ''), 'stopped_by_source'),
             stopped_by = auth.uid(), stopped_at = now(), updated_at = now()
           where organization_id = org and id = any(grant_ids) and status = 'active'
           returning id, target_organization_id loop
    n := n + 1;
    perform public.sharing_audit(org, org, r.target_organization_id, 'grant.stop', null, r.id, null, '{}');
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------
-- 共有先からの閲覧（一覧・件数・検索・詳細は、すべて share_grant_state = 'live' のものだけ）
-- ------------------------------------------------------------
create or replace function public.shared_people_list(org uuid, q text default null, page_size int default 50, page int default 1)
returns table (grant_id uuid, source_organization_id uuid, source_name text, label text, fields text[], version integer,
               published_at timestamptz, expires_at timestamptz, total_count bigint)
language plpgsql security definer set search_path = public, extensions as $$
declare
  lim int := least(greatest(page_size, 1), 200);
begin
  perform public.require_shared_viewer(org);
  return query
  with live as (
    select g.*, v.snapshot, v.published_at as pub_at, v.fields as vfields
    from public.person_share_grants g
    join lateral (select * from public.person_share_versions pv where pv.grant_id = g.id order by pv.version desc limit 1) v on true
    where g.target_organization_id = org and g.status = 'active' and public.share_grant_state(g) = 'live'
  ), filtered as (
    select l.* from live l
    where q is null or btrim(q) = '' or exists (
      -- 検索対象は公開済みスナップショットの値だけ（項目名や未公開の値には当たらない）
      select 1 from jsonb_each(l.snapshot) e,
        lateral (select case jsonb_typeof(e.value) when 'array' then (select string_agg(x #>> '{}', ' ') from jsonb_array_elements(e.value) x)
                                                    else e.value #>> '{}' end as txt) t
      where t.txt ilike '%' || btrim(q) || '%')
  )
  select f.id, f.organization_id, o.name,
         coalesce(f.snapshot ->> 'display_name', f.snapshot ->> 'full_name', '（氏名は共有されていません）'),
         f.vfields, f.current_version, f.pub_at, f.expires_at, count(*) over ()
  from filtered f join public.organizations o on o.id = f.organization_id
  order by f.pub_at desc, f.id
  limit lim offset (greatest(page, 1) - 1) * lim;
  perform public.sharing_audit(org, null, org, 'shared.list', null, null, null,
    jsonb_build_object('searched', q is not null and btrim(q) <> '', 'page', page));
end $$;

create or replace function public.shared_person_detail(org uuid, p_grant uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.person_share_grants;
  v public.person_share_versions;
  src text;
begin
  perform public.require_shared_viewer(org);
  select * into g from public.person_share_grants where id = p_grant;
  -- 他団体宛て・存在しない・無効、のいずれも同じエラー（理由や存在を漏らさない）
  if g.id is null or g.target_organization_id <> org or public.share_grant_state(g) <> 'live' then
    raise exception 'not_found';
  end if;
  select * into v from public.person_share_versions where grant_id = g.id order by version desc limit 1;
  select name into src from public.organizations where id = g.organization_id;
  perform public.sharing_audit(org, g.organization_id, org, 'shared.view', null, g.id, null, jsonb_build_object('version', v.version));
  return jsonb_build_object(
    'grant_id', g.id, 'source_name', src, 'version', v.version, 'published_at', v.published_at,
    'expires_at', g.expires_at, 'fields', v.fields, 'snapshot', v.snapshot);
end $$;

-- 共有先から見た件数（ダッシュボード等用。一覧と同じ条件）
create or replace function public.shared_people_count(org uuid) returns integer
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.require_shared_viewer(org);
  return (select count(*) from public.person_share_grants g
          where g.target_organization_id = org and g.status = 'active' and public.share_grant_state(g) = 'live');
end $$;

-- 期限切れの表示を整える（閲覧可否は share_grant_state で判定しているので、これに依存しない）
create or replace function public.expire_share_grants() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  update public.person_share_grants set status = 'expired', updated_at = now()
    where status = 'active' and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.expire_share_grants() from public, anon, authenticated;
select cron.schedule('npo-crm-expire-shares', '*/15 * * * *', 'select public.expire_share_grants()');
