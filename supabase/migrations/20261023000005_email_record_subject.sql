-- 送信記録（やりとりの履歴）には、差し込み後の実際の件名を残す
create or replace function public.worker_mark_email(recipient uuid, ok boolean, err text default null, message_id text default null,
                                                     requeue boolean default false, sent_subject text default null)
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
        values (r.organization_id, 'email', 'outbound', now(), left(coalesce(sent_subject, c.subject), 200), '一斉配信「' || c.name || '」', r.person_id, r.id, c.sent_by);
    end if;
  elsif requeue then
    update public.email_recipients set status = 'queued', claimed_at = null, error = left(err, 500) where id = r.id;
    update public.email_campaigns set last_error = '一時的に送信できません（自動で再試行します）：' || left(err, 300) where id = c.id;
  else
    update public.email_recipients set status = 'failed', error = left(err, 500) where id = r.id;
  end if;
end $$;
drop function if exists public.worker_mark_email(uuid, boolean, text, text, boolean);
revoke execute on function public.worker_mark_email(uuid, boolean, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.worker_mark_email(uuid, boolean, text, text, boolean, text) to service_role;

-- 一斉配信の送信記録は、利用者が削除・編集できない（送信の事実の記録）
drop policy interactions_update on public.interactions;
drop policy interactions_delete on public.interactions;
create policy interactions_update on public.interactions for update to authenticated
  using (email_recipient_id is null and (public.has_role(organization_id, 'admin') or (created_by = auth.uid() and public.has_role(organization_id, 'editor'))))
  with check (public.has_role(organization_id, 'editor'));
create policy interactions_delete on public.interactions for delete to authenticated
  using (email_recipient_id is null and (public.has_role(organization_id, 'admin') or (created_by = auth.uid() and public.has_role(organization_id, 'editor'))));
