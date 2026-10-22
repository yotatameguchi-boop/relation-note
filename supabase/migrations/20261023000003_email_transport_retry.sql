-- メールサーバーにつながらない（接続できない・名前解決できない）ときは、確実に未送信なので宛先を「送信待ち」に戻す。
-- ジョブは指数バックオフで再試行し、上限を超えたら配信を「停止（要確認）」にする。
create or replace function public.worker_mark_email(recipient uuid, ok boolean, err text default null, message_id text default null,
                                                     requeue boolean default false)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  r public.email_recipients;
  c public.email_campaigns;
begin
  select * into r from public.email_recipients where id = recipient for update;
  if r.id is null or r.status <> 'sending' then return; end if;
  select * into c from public.email_campaigns where id = r.campaign_id;
  if ok then
    update public.email_recipients set status = 'sent', sent_at = now(), provider_message_id = message_id, error = null where id = r.id;
    if r.person_id is not null then
      insert into public.interactions (organization_id, kind, direction, occurred_at, subject, body, person_id, email_recipient_id, created_by)
        values (r.organization_id, 'email', 'outbound', now(), c.subject, '一斉配信「' || c.name || '」', r.person_id, r.id, c.sent_by);
    end if;
  elsif requeue then
    update public.email_recipients set status = 'queued', claimed_at = null, error = left(err, 500) where id = r.id;
    update public.email_campaigns set last_error = '一時的に送信できません（自動で再試行します）：' || left(err, 300) where id = c.id;
  else
    update public.email_recipients set status = 'failed', error = left(err, 500) where id = r.id;
  end if;
end $$;
drop function if exists public.worker_mark_email(uuid, boolean, text, text);
revoke execute on function public.worker_mark_email(uuid, boolean, text, text, boolean) from public, anon, authenticated;
grant execute on function public.worker_mark_email(uuid, boolean, text, text, boolean) to service_role;

-- 再試行の上限で隔離されたら、配信を「停止（要確認）」にする
create or replace function public.trg_campaign_job_dead() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.kind = 'send_campaign' and new.status = 'dead' and old.status <> 'dead' then
    update public.email_campaigns set status = 'failed', last_error = coalesce(new.last_error, last_error)
      where id = new.target_id and status = 'sending';
  end if;
  return null;
end $$;
create trigger jobs_campaign_dead after update of status on public.jobs
  for each row execute function public.trg_campaign_job_dead();
