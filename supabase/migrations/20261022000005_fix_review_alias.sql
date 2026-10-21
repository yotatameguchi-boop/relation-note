-- 修正・確定：削除対象IDの別名が photo_detections.x（座標）と衝突していたのを修正

create or replace function public.submit_photo_count_review(photo uuid, result_id uuid, removed uuid[], added jsonb,
                                                            moved jsonb, p_confirmed int, p_note text, p_seconds int default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  ph public.photos;
  r public.photo_analysis_results;
  kept int;
  rid uuid;
  b jsonb;
begin
  select * into ph from public.photos where id = photo;
  if ph.id is null then raise exception 'not_found'; end if;
  perform public.require_role(ph.organization_id, 'editor');
  select * into r from public.photo_analysis_results where id = result_id and photo_id = photo and organization_id = ph.organization_id;
  if r.id is null then raise exception 'not_found'; end if;
  -- 削除・移動の対象は、このランの検出枠に限る
  -- 注意：photo_detections には座標の列 x があるので、別名は rm(det_id) にする
  if exists (select 1 from unnest(coalesce(removed, '{}')) rm(det_id)
             where not exists (select 1 from public.photo_detections d where d.id = rm.det_id and d.analysis_result_id = r.id)) then
    raise exception 'invalid_adjustment';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(moved, '[]')) m
             where not exists (select 1 from public.photo_detections d where d.id = (m->>'id')::uuid and d.analysis_result_id = r.id)) then
    raise exception 'invalid_adjustment';
  end if;
  for b in select * from jsonb_array_elements(coalesce(added, '[]') || coalesce(moved, '[]')) loop
    if (b->>'x')::numeric not between 0 and 1 or (b->>'y')::numeric not between 0 and 1
       or (b->>'w')::numeric not between 0 and 1 or (b->>'h')::numeric not between 0 and 1 then
      raise exception 'invalid_adjustment';
    end if;
  end loop;
  if p_confirmed is null or p_confirmed < 0 or p_confirmed > 10000 then raise exception 'invalid_count'; end if;
  select count(*) into kept from public.photo_detections where analysis_result_id = r.id and status = 'kept';
  if r.pipeline = 'v1' then kept := r.estimated_count; end if;
  insert into public.photo_reviews (organization_id, photo_id, analysis_result_id, confirmed_count, note, reviewed_by,
                                    detected_count, adjustments, review_seconds)
    values (ph.organization_id, photo, r.id, p_confirmed, nullif(btrim(p_note), ''), auth.uid(), kept,
            jsonb_build_object('removed', to_jsonb(coalesce(removed, '{}')), 'added', coalesce(added, '[]'), 'moved', coalesce(moved, '[]')),
            case when p_seconds between 0 and 86400 then p_seconds end)
    returning id into rid;
  return rid;
end $$;
