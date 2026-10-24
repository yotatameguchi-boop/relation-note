-- グラフ分析：「何を（指標）」×「どう分けるか（切り口）」×「内訳（系列）」×「期間」で集計する。
-- 指標・切り口は下の一覧にあるものだけを受け付け、SQL を組み立てる（利用者の入力が SQL になることはない）。
-- security invoker なので、読める範囲は RLS（自分の所属組織）のまま。

create or replace function public.insight_query(
  org uuid,
  metric text,
  dim text,
  series text default null,
  from_ts timestamptz default now() - interval '1 year',
  to_ts timestamptz default now(),
  field_key text default null,          -- dim / series が 'field' のときの追加項目
  series_field_key text default null
) returns table (x text, s text, value numeric)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  facts text;
  agg text := 'count(*)';
  timed boolean := true;               -- 期間で絞る指標か（人数の現在値だけは「to_ts 時点までの全員」）
  has_person boolean := true;
  cumulative boolean := false;
  dims text[] := array[dim, coalesce(series, '')];
  xs text;
  ss text;
  q text;
begin
  if not exists (select 1 from public.my_org_ids('viewer') m where m = org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 指標ごとの元データ：ts（日時）・person_id・kind（種類）・title（イベント名）
  case metric
    when 'people_total' then
      facts := 'select p.created_at ts, p.id person_id, null::text kind, null::text title from public.people p where p.organization_id = $1';
      timed := false;
      cumulative := dim in ('month', 'week', 'day');
    when 'people_new' then
      facts := 'select p.created_at ts, p.id person_id, null::text kind, null::text title from public.people p where p.organization_id = $1';
    when 'attendances', 'participants' then
      facts := 'select e.starts_at ts, ep.person_id, null::text kind, e.title from public.event_participations ep
                join public.events e on e.id = ep.event_id where ep.organization_id = $1 and ep.status = ''attended''';
      if metric = 'participants' then agg := 'count(distinct f.person_id)'; end if;
    when 'events' then
      facts := 'select e.starts_at ts, null::uuid person_id, null::text kind, e.title from public.events e where e.organization_id = $1';
      has_person := false;
    when 'interactions' then
      facts := 'select i.occurred_at ts, i.person_id, i.kind, null::text title from public.interactions i where i.organization_id = $1';
    when 'submissions' then
      facts := 'select coalesce(fs.submitted_at, fs.received_at) ts, fs.person_id, fs.source kind, null::text title
                from public.form_submissions fs where fs.organization_id = $1';
    when 'tasks_done' then
      facts := 'select t.completed_at ts, t.person_id, t.priority kind, null::text title from public.tasks t
                where t.organization_id = $1 and t.status = ''done'' and t.completed_at is not null';
    when 'emails_sent' then
      facts := 'select r.sent_at ts, r.person_id, null::text kind, null::text title from public.email_recipients r
                where r.organization_id = $1 and r.status = ''sent'' and r.sent_at is not null';
    else
      raise exception 'invalid_metric' using errcode = '22023';
  end case;

  -- 人物の属性は1回の結合でまとめて付ける（1行ずつ引くと10万人規模で遅い）
  if has_person then
    facts := 'select b.*, p.region, p.interests, p.attendance_count, p.custom_fields'
      || case when 'tag' = any(dims) then ', tg.names tag_names' else '' end
      || case when 'industry' = any(dims) then ', ind.industry' else '' end
      || ' from (' || facts || ') b left join public.people p on p.id = b.person_id'
      || case when 'tag' = any(dims) then
           ' left join (select pt.person_id, array_agg(t.name) names from public.person_tags pt
              join public.tags t on t.id = pt.tag_id where pt.organization_id = $1 group by 1) tg on tg.person_id = b.person_id'
         else '' end
      || case when 'industry' = any(dims) then
           $s$ left join (select distinct on (l.person_id) l.person_id,
              coalesce(nullif(btrim(c.industry), ''), '業種未設定') industry from public.person_company_links l
              join public.companies c on c.id = l.company_id where l.organization_id = $1
              order by l.person_id, l.is_primary desc) ind on ind.person_id = b.person_id$s$
         else '' end;
  end if;

  xs := public.insight_dim_sql(org, dim, field_key, metric, has_person);
  ss := case when series is null then 'select null::text v' else public.insight_dim_sql(org, series, series_field_key, metric, has_person) end;

  q := format($q$
    with f as (%1$s)
    select dx.v x, ds.v s, (%4$s)::numeric
    from f cross join lateral (%2$s) dx cross join lateral (%3$s) ds
    where %5$s
    group by 1, 2
  $q$, facts, xs, ss, agg,
    case when timed or cumulative then 'f.ts >= $2 and f.ts < $3' else 'f.ts < $3' end);
  if cumulative then
    -- 人数の推移：期間の始まりより前の人数を x = '__base__' で返し、画面側で累計にする
    q := q || format($q$
      union all
      select '__base__', ds.v, count(*)::numeric from f cross join lateral (%1$s) ds where f.ts < $2 group by 2
    $q$, ss);
  end if;
  return query execute q using org, from_ts, to_ts;
end $$;

-- 切り口ごとの値（1行の事実 f に対して、0個以上の値 v を返す副問い合わせ）。f には人物の属性が付いている
create or replace function public.insight_dim_sql(org uuid, dim text, field_key text, metric text, has_person boolean)
returns text language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  ftype text;
  person_dims constant text[] := array['region', 'tag', 'field', 'interest', 'attendance_band', 'industry'];
begin
  if dim = any(person_dims) and not has_person then
    raise exception 'invalid_dimension' using errcode = '22023';
  end if;
  case dim
    when 'total' then return $s$select '合計'::text v$s$;
    when 'month' then return $s$select to_char(f.ts at time zone 'Asia/Tokyo', 'YYYY-MM') v$s$;
    when 'week' then return $s$select to_char(date_trunc('week', f.ts at time zone 'Asia/Tokyo'), 'YYYY-MM-DD') v$s$;
    when 'day' then return $s$select to_char(f.ts at time zone 'Asia/Tokyo', 'YYYY-MM-DD') v$s$;
    when 'weekday' then return $s$select extract(isodow from f.ts at time zone 'Asia/Tokyo')::int::text v$s$;
    when 'region' then return $s$select coalesce(nullif(btrim(f.region), ''), '未設定') v where f.person_id is not null$s$;
    when 'tag' then return $s$select unnest(coalesce(f.tag_names, array['タグなし'])) v where f.person_id is not null$s$;
    when 'interest' then
      return $s$select unnest(case when cardinality(f.interests) > 0 then f.interests else array['未設定'] end) v where f.person_id is not null$s$;
    when 'attendance_band' then
      return $s$select case when f.attendance_count = 0 then '0回' when f.attendance_count = 1 then '1回'
                when f.attendance_count <= 3 then '2〜3回' when f.attendance_count <= 9 then '4〜9回' else '10回以上' end v
              where f.person_id is not null$s$;
    when 'industry' then return $s$select coalesce(f.industry, '企業なし') v where f.person_id is not null$s$;
    when 'kind' then
      if metric not in ('interactions', 'submissions', 'tasks_done') then raise exception 'invalid_dimension' using errcode = '22023'; end if;
      return $s$select coalesce(f.kind, '未設定') v$s$;
    when 'event' then
      if metric not in ('attendances', 'participants', 'events') then raise exception 'invalid_dimension' using errcode = '22023'; end if;
      return 'select f.title v';
    when 'field' then
      select d.field_type into ftype from public.custom_field_definitions d
      where d.organization_id = org and d.entity = 'person' and d.key = field_key and not d.archived;
      if ftype is null or ftype not in ('select', 'multi_select', 'checkbox') then
        raise exception 'invalid_field' using errcode = '22023';
      end if;
      if ftype = 'multi_select' then
        return format($s$select coalesce(e.v, '未設定') v
          from jsonb_array_elements_text(case when jsonb_typeof(f.custom_fields->%1$L) = 'array'
            and jsonb_array_length(f.custom_fields->%1$L) > 0 then f.custom_fields->%1$L else '[null]'::jsonb end) e(v)
          where f.person_id is not null$s$, field_key);
      elsif ftype = 'checkbox' then
        return format($s$select case when (f.custom_fields->>%1$L)::boolean then 'はい' else 'いいえ' end v where f.person_id is not null$s$, field_key);
      else
        return format($s$select coalesce(nullif(f.custom_fields->>%1$L, ''), '未設定') v where f.person_id is not null$s$, field_key);
      end if;
    else
      raise exception 'invalid_dimension' using errcode = '22023';
  end case;
end $$;

revoke execute on function public.insight_dim_sql(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.insight_dim_sql(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.insight_query(uuid, text, text, text, timestamptz, timestamptz, text, text) to authenticated;

-- ダッシュボードに置くグラフ
create table public.saved_charts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  spec jsonb not null,
  position integer not null default 0,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index saved_charts_org_idx on public.saved_charts(organization_id, position, created_at);
alter table public.saved_charts enable row level security;
create policy saved_charts_read on public.saved_charts for select to authenticated
  using (organization_id in (select public.my_org_ids('viewer')));
create policy saved_charts_insert on public.saved_charts for insert to authenticated
  with check (organization_id in (select public.my_org_ids('editor')) and created_by = auth.uid());
create policy saved_charts_update on public.saved_charts for update to authenticated
  using (organization_id in (select public.my_org_ids('editor')));
create policy saved_charts_delete on public.saved_charts for delete to authenticated
  using (organization_id in (select public.my_org_ids('admin')) or (created_by = auth.uid() and organization_id in (select public.my_org_ids('editor'))));
revoke update on public.saved_charts from authenticated;
grant update (title, position) on public.saved_charts to authenticated;
create trigger saved_charts_no_org_change before update on public.saved_charts for each row execute function public.prevent_org_change();
