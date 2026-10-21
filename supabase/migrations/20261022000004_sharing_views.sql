-- 共有元の画面用：自団体から共有中の一覧（状態・未公開の変更の有無つき）と、共有前の根拠チェック

create or replace function public.list_outgoing_shares(org uuid)
returns table (grant_id uuid, person_id uuid, person_name text, target_id uuid, target_name text, fields text[],
               expires_at timestamptz, status text, state text, current_version integer, published_at timestamptz,
               has_changes boolean, stop_reason text)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.can_manage_sharing(org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select g.id, g.person_id, p.full_name, g.target_organization_id, o.name, g.fields, g.expires_at, g.status,
         public.share_grant_state(g), g.current_version, v.published_at,
         case when g.status = 'active' and v.snapshot is not null
              then public.build_share_snapshot(g.organization_id, g.person_id, g.fields, g.tag_ids, g.participation_ids) is distinct from v.snapshot
              else false end,
         g.stop_reason
  from public.person_share_grants g
  join public.people p on p.organization_id = g.organization_id and p.id = g.person_id
  join public.organizations o on o.id = g.target_organization_id
  left join lateral (select pv.snapshot, pv.published_at from public.person_share_versions pv
                     where pv.grant_id = g.id order by pv.version desc limit 1) v on true
  where g.organization_id = org
  order by (g.status = 'active') desc, g.updated_at desc;
end $$;

create or replace function public.share_readiness(org uuid, target uuid, person_ids uuid[], p_fields text[], p_expires_at timestamptz)
returns table (person_id uuid, full_name text, status text, authorization_id uuid)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.require_sharing_admin(org);
  return query
  select p.id, p.full_name,
    case
      when exists (select 1 from public.person_share_grants g where g.organization_id = org and g.person_id = p.id
                   and g.target_organization_id = target and g.status = 'active' and g.expires_at > now()) then 'already_shared'
      when public.find_covering_authorization(org, p.id, target, coalesce(p_fields, '{}'), coalesce(p_expires_at, now())) is not null then 'ok'
      when not exists (select 1 from public.sharing_authorizations a where a.organization_id = org and a.person_id = p.id
                       and a.target_organization_id = target) then 'no_authorization'
      when not exists (select 1 from public.sharing_authorizations a where a.organization_id = org and a.person_id = p.id
                       and a.target_organization_id = target and public.authorization_state(a) = 'active') then 'withdrawn_or_expired'
      when not exists (select 1 from public.sharing_authorizations a where a.organization_id = org and a.person_id = p.id
                       and a.target_organization_id = target and public.authorization_state(a) = 'active'
                       and coalesce(p_fields, '{}') <@ a.allowed_fields) then 'insufficient_fields'
      else 'shorter_than_share'
    end,
    public.find_covering_authorization(org, p.id, target, coalesce(p_fields, '{}'), coalesce(p_expires_at, now()))
  from public.people p
  where p.organization_id = org and p.id = any(person_ids)
  order by p.full_name;
end $$;
