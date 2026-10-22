-- 差し込みの {{氏名}} と {{表示名}} を区別するため、宛先の氏名・表示名を別々に返す

drop function public.worker_claim_recipients(uuid, int);
create or replace function public.worker_claim_recipients(job uuid, max_rows int default 20)
returns table (recipient_id uuid, email text, name text, full_name text, display_name text, token text, subject text,
               body_text text, from_name text, reply_to text, org_name text, sender_info text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  j public.jobs;
  c public.email_campaigns;
begin
  select * into j from public.jobs where id = job;
  if j.kind <> 'send_campaign' then raise exception 'wrong_job_kind'; end if;
  select * into c from public.email_campaigns where id = j.target_id and organization_id = j.organization_id;
  if c.id is null then raise exception 'not_found'; end if;
  update public.email_recipients set status = 'unknown', error = '送信中に処理が止まったため、二重送信を避けて再送していません'
    where campaign_id = c.id and status = 'sending' and claimed_at < now() - interval '10 minutes';
  return query
  with picked as (
    select r.id from public.email_recipients r
    where r.campaign_id = c.id and r.organization_id = c.organization_id and r.status = 'queued'
    order by r.id limit max_rows for update skip locked
  ), upd as (
    update public.email_recipients r set status = 'sending', claimed_at = now()
    from picked where r.id = picked.id
    returning r.id, r.email, r.name, r.token, r.person_id
  )
  -- 差し込み用に、送信時点の氏名・表示名を使う（人物が削除されていれば宛先作成時の名前）
  select u.id, u.email, u.name, coalesce(p.full_name, u.name), coalesce(p.display_name, p.full_name, u.name), u.token,
         c.subject, c.body_text, c.from_name, c.reply_to, o.name, o.email_sender_info
  from upd u
  join public.organizations o on o.id = c.organization_id
  left join public.people p on p.organization_id = c.organization_id and p.id = u.person_id;
end $$;
revoke execute on function public.worker_claim_recipients(uuid, int) from public, anon, authenticated;
grant execute on function public.worker_claim_recipients(uuid, int) to service_role;
