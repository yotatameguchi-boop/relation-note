-- 団体・スタッフ・権限の操作（§3）。変更系はすべてここを通し、操作履歴を残す。

-- 停止中の団体は閲覧のみ（has_role を上書き）
create or replace function public.has_role(org uuid, min_role public.org_role) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((
    select public.role_rank(m.role) >= public.role_rank(min_role)
             and (o.status = 'active' or min_role = 'viewer')
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org and m.user_id = auth.uid() and o.status <> 'cancelled'
  ), false)
$$;

create or replace function public.default_permissions(r public.org_role) returns text[]
language sql immutable as $$
  select case r
    when 'owner' then array['bulk_export', 'bulk_delete', 'merge_people', 'manage_permissions']
    when 'admin' then array['bulk_export', 'merge_people']
    else array[]::text[]
  end
$$;

create or replace function public.create_organization(org_name text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  insert into public.users (id, email)
    select id, lower(email) from auth.users where id = auth.uid()
    on conflict (id) do nothing;
  insert into public.organizations (name) values (btrim(org_name)) returning id into new_id;
  insert into public.memberships (organization_id, user_id, role, permissions)
    values (new_id, auth.uid(), 'owner', public.default_permissions('owner'));
  perform public.audit(new_id, 'organization.create', 'organization', new_id::text, jsonb_build_object('name', org_name));
  return new_id;
end $$;

create or replace function public.staff_seats_used(org uuid) returns int
language sql stable security definer set search_path = public, extensions as $$
  select (select count(*) from public.memberships where organization_id = org)::int
       + (select count(*) from public.invitations
          where organization_id = org and accepted_at is null and revoked_at is null and expires_at > now())::int
$$;

-- 招待：生のトークンは戻り値でだけ返し、DBにはハッシュを保存する
create or replace function public.create_invitation(org uuid, invitee_email text, invitee_role public.org_role,
                                                    invitee_permissions text[] default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  raw_token text := encode(gen_random_bytes(24), 'hex');
  lim int;
  perms text[] := coalesce(invitee_permissions, public.default_permissions(invitee_role));
begin
  perform public.require_role(org, 'admin');
  if invitee_role = 'owner' then
    raise exception 'invalid_role' using hint = 'オーナーは所有権移譲で設定します。';
  end if;
  -- 管理者権限の付与・明示的権限の付与は権限管理の権限が必要
  if (invitee_role = 'admin' or cardinality(perms) > 0) and not public.has_perm(org, 'manage_permissions') then
    raise exception 'forbidden' using errcode = '42501', hint = 'permission manage_permissions required';
  end if;
  perform pg_advisory_xact_lock(hashtext('staff:' || org::text));
  select p.max_staff into lim from public.organizations o join public.plans p on p.id = o.plan_id where o.id = org;
  if public.staff_seats_used(org) >= lim then
    raise exception 'quota_exceeded:staff' using hint = 'スタッフ数がプランの上限（' || lim || '人）に達しています。';
  end if;
  insert into public.invitations (organization_id, email, role, permissions, token_hash, invited_by)
    values (org, lower(btrim(invitee_email)), invitee_role, perms, encode(digest(raw_token, 'sha256'), 'hex'), auth.uid());
  perform public.audit(org, 'invitation.create', 'invitation', lower(invitee_email),
                       jsonb_build_object('role', invitee_role, 'permissions', perms));
  return raw_token;
end $$;

create or replace function public.revoke_invitation(inv uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare org uuid;
begin
  select organization_id into org from public.invitations where id = inv;
  perform public.require_role(org, 'admin');
  update public.invitations set revoked_at = now() where id = inv and accepted_at is null;
  perform public.audit(org, 'invitation.revoke', 'invitation', inv::text);
end $$;

create or replace function public.accept_invitation(raw_token text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  inv public.invitations;
  my_email text;
  lim int;
  members int;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into inv from public.invitations
    where token_hash = encode(digest(raw_token, 'sha256'), 'hex') for update;
  if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at <= now() then
    raise exception 'invitation_invalid' using hint = '招待が無効か、期限切れです。';
  end if;
  select lower(email) into my_email from auth.users where id = auth.uid();
  if my_email is distinct from inv.email then
    raise exception 'invitation_email_mismatch' using hint = '招待されたメールアドレスでログインしてください。';
  end if;
  insert into public.users (id, email) values (auth.uid(), my_email) on conflict (id) do nothing;
  if exists (select 1 from public.memberships where organization_id = inv.organization_id and user_id = auth.uid()) then
    update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
    return inv.organization_id;
  end if;
  perform pg_advisory_xact_lock(hashtext('staff:' || inv.organization_id::text));
  select p.max_staff into lim from public.organizations o join public.plans p on p.id = o.plan_id where o.id = inv.organization_id;
  select count(*) into members from public.memberships where organization_id = inv.organization_id;
  if members >= lim then
    raise exception 'quota_exceeded:staff' using hint = 'スタッフ数がプランの上限に達しています。';
  end if;
  insert into public.memberships (organization_id, user_id, role, permissions)
    values (inv.organization_id, auth.uid(), inv.role, inv.permissions);
  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
  perform public.audit(inv.organization_id, 'membership.join', 'user', auth.uid()::text, jsonb_build_object('role', inv.role));
  return inv.organization_id;
end $$;

create or replace function public.set_member_role(org uuid, member uuid, new_role public.org_role, new_permissions text[])
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  cur public.memberships;
begin
  perform public.require_role(org, 'admin');
  perform public.require_perm(org, 'manage_permissions');
  select * into cur from public.memberships where organization_id = org and user_id = member;
  if cur.user_id is null then raise exception 'not_found'; end if;
  if new_role = 'owner' then
    raise exception 'invalid_role' using hint = 'オーナーは所有権移譲で設定します。';
  end if;
  -- オーナーの権限を変えられるのはオーナーだけ（最後のオーナーはトリガーで保護）
  if cur.role = 'owner' and not public.has_role(org, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.memberships set role = new_role,
    permissions = case when new_role = 'owner' then public.default_permissions('owner') else coalesce(new_permissions, '{}') end
    where organization_id = org and user_id = member;
  perform public.audit(org, 'membership.update', 'user', member::text,
    jsonb_build_object('from_role', cur.role, 'to_role', new_role, 'from_permissions', cur.permissions, 'to_permissions', new_permissions));
end $$;

create or replace function public.remove_member(org uuid, member uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare cur public.memberships;
begin
  select * into cur from public.memberships where organization_id = org and user_id = member;
  if cur.user_id is null then raise exception 'not_found'; end if;
  if member = auth.uid() then
    perform public.require_role(org, 'viewer');  -- 自分の脱退
  elsif cur.role = 'owner' then
    perform public.require_role(org, 'owner');
  else
    perform public.require_role(org, 'admin');
    if cur.role = 'admin' then perform public.require_perm(org, 'manage_permissions'); end if;
  end if;
  delete from public.memberships where organization_id = org and user_id = member;
  perform public.audit(org, case when member = auth.uid() then 'membership.leave' else 'membership.remove' end,
                       'user', member::text, jsonb_build_object('role', cur.role));
end $$;

create or replace function public.transfer_ownership(org uuid, new_owner uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.require_role(org, 'owner');
  if not exists (select 1 from public.memberships where organization_id = org and user_id = new_owner) then
    raise exception 'not_found' using hint = '移譲先は団体のメンバーである必要があります。';
  end if;
  update public.memberships set role = 'owner', permissions = public.default_permissions('owner')
    where organization_id = org and user_id = new_owner;
  if new_owner <> auth.uid() then
    update public.memberships set role = 'admin', permissions = public.default_permissions('admin') || array['manage_permissions']
      where organization_id = org and user_id = auth.uid();
  end if;
  perform public.audit(org, 'organization.transfer_ownership', 'user', new_owner::text);
end $$;

-- 団体削除。ストレージの実ファイルはサーバー側で先に削除する。
create or replace function public.delete_organization(org uuid, confirm_name text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare n text;
begin
  perform public.require_role(org, 'owner');
  select name into n from public.organizations where id = org;
  if n is distinct from confirm_name then
    raise exception 'confirm_mismatch' using hint = '確認のため団体名を正確に入力してください。';
  end if;
  delete from public.organizations where id = org;
end $$;

-- ------------------------------------------------------------
-- 利用量
-- ------------------------------------------------------------
create or replace function public.current_period() returns text
language sql stable as $$ select to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM') $$;

create or replace function public.usage_in_use(org uuid, m text) returns bigint
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(sum(quantity), 0)::bigint from public.usage_records
  where organization_id = org and metric = m
    and (m = 'storage_bytes' or period = public.current_period())
    and (status = 'committed' or (status = 'reserved' and (expires_at is null or expires_at > now())))
$$;

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
    'people', jsonb_build_object('used', (select count(*) from public.people where organization_id = org), 'limit', p.max_people),
    'photo_analysis', jsonb_build_object('used', public.usage_in_use(org, 'photo_analysis'), 'limit', p.max_photo_analyses_per_month),
    'storage_bytes', jsonb_build_object('used', public.usage_in_use(org, 'storage_bytes'), 'limit', p.max_storage_bytes)
  );
end $$;
