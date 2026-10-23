-- 負荷試験用の大量データ（手元のDB専用。本番では実行しない）
--   psql "$DB" -v org=<組織ID> -v owner=<オーナーのユーザーID> -v n=100000 -f scripts/loadtest-seed.sql
-- 1組織に上位プランの上限いっぱい（既定10万人）を入れる。参加集計は最後にまとめて計算する。
\set ON_ERROR_STOP on
set statement_timeout = 0;
set session_replication_role = replica;  -- 1行ごとのトリガー（上限確認・参加集計）を止めて一括投入

update organizations set plan_id = 'large', subscription_status = 'complimentary' where id = :'org';

-- 人物（氏名は姓×名の組み合わせ。重複候補が実際に出るよう、同姓同名も混ぜる）
with sei as (select array['佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤','吉田','山田','佐々木','山口','松本','井上','木村','林','斎藤','清水','山崎','森','池田','橋本','阿部','石川','山下','中島','石井','小川'] a),
     mei as (select array['太郎','花子','健','さくら','翔','陽菜','大輔','美咲','拓也','結衣','蓮','葵','悠真','凛','颯','芽依','湊','結菜','樹','莉子','一郎','真由美','誠','恵子','学','裕子','亮','由美','隆','明美','直樹','愛','剛','舞','聡','彩'] a)
insert into people (id, organization_id, full_name, full_name_kana, display_name, region, interests, skills, custom_fields, first_seen_at, created_at, created_by)
select gen_random_uuid(), :'org',
       sei.a[1 + (i % 30)] || ' ' || mei.a[1 + ((i / 30) % 36)] || case when i % 7 = 0 then '' else to_char(i, 'FM000000') end,
       null,
       case when i % 3 = 0 then sei.a[1 + (i % 30)] || 'さん' end,
       (array['北区','南区','東区','西区','中央区','みどり市','あおば町','県外'])[1 + (i % 8)],
       array[(array['環境','福祉','子ども','防災','まちづくり','国際交流'])[1 + (i % 6)]],
       case when i % 5 = 0 then array['運転'] else '{}' end,
       jsonb_build_object('member_type', (array['正会員','賛助会員','学生会員'])[1 + (i % 3)], 'joined_on', (date '2020-01-01' + (i % 2000))::text),
       now() - (i % 1500) * interval '1 day', now() - (i % 1500) * interval '1 day', :'owner'
from generate_series(1, :n) i, sei, mei;

-- 連絡先（全員メール、半数は電話）
insert into person_contacts (organization_id, person_id, kind, value)
select :'org', id, 'email', 'lt-' || replace(id::text, '-', '') || '@example.com' from people where organization_id = :'org';
insert into person_contacts (organization_id, person_id, kind, value)
select :'org', id, 'phone', '090-' || lpad((row_number() over ())::text, 8, '0') from people where organization_id = :'org' and random() < 0.5;

-- タグ（30個、1人あたり平均2.5個）
insert into tags (organization_id, name, color)
select :'org', '負荷タグ' || g, '#1F6F8B' from generate_series(1, 30) g;
insert into person_tags (organization_id, person_id, tag_id)
select distinct on (p.id, t.id) :'org', p.id, t.id
from people p cross join lateral (select id from tags where organization_id = :'org' order by random() + (p.attendance_count * 0) limit 1 + (abs(hashtext(p.id::text)) % 4)) t
where p.organization_id = :'org';

-- イベント（3年間で1,000回）と参加（40万件）
insert into events (organization_id, title, starts_at, location, created_by)
select :'org', '定例活動 第' || g || '回', now() - (g * interval '26 hours'), (array['河川敷','公民館','駅前広場'])[1 + g % 3], :'owner'
from generate_series(1, 1000) g;
with ev as (select id, row_number() over (order by starts_at) rn from events where organization_id = :'org'),
     pp as (select id, row_number() over (order by created_at, id) rn from people where organization_id = :'org')
insert into event_participations (organization_id, event_id, person_id, status, status_changed_at)
select :'org', ev.id, pp.id, (array['attended','attended','attended','applied','absent','cancelled'])[1 + ((pp.rn + ev.rn) % 6)::int], now()
from ev join pp on (pp.rn * 7 + ev.rn * 13) % 250 = 0
on conflict do nothing;

-- 企業（5,000社）・担当者（3万件）
insert into companies (organization_id, name, industry, created_by)
select :'org', '株式会社 負荷' || to_char(g, 'FM00000'), (array['建設業','金融','小売','製造','IT','教育'])[1 + g % 6], :'owner'
from generate_series(1, 5000) g;
with c as (select id, row_number() over (order by name) rn from companies where organization_id = :'org'),
     p as (select id, row_number() over (order by id) rn from people where organization_id = :'org' limit 30000)
insert into person_company_links (organization_id, person_id, company_id, is_primary)
select :'org', p.id, c.id, true from p join c on c.rn = 1 + (p.rn % 5000);

-- やりとり（20万件）・タスク（2万件）・操作履歴（10万件）
with p as (select id, row_number() over (order by id) rn from people where organization_id = :'org')
insert into interactions (organization_id, kind, direction, occurred_at, person_id, subject, body, created_by)
select :'org', (array['meeting','call','email','visit'])[1 + (g % 4)], 'outbound', now() - (g % 1000) * interval '1 day', p.id,
       '負荷試験のやりとり ' || g, '本文 ' || repeat('あ', 80), :'owner'
from generate_series(1, 200000) g join p on p.rn = 1 + (g % :n);
with p as (select id, row_number() over (order by id) rn from people where organization_id = :'org')
insert into tasks (organization_id, title, due_date, priority, status, assignee_id, person_id, created_by)
select :'org', '負荷試験のタスク ' || g, (now() + ((g % 120) - 60) * interval '1 day')::date,
       (array['low','normal','high'])[1 + g % 3], case when g % 3 = 0 then 'done' else 'open' end, :'owner', p.id, :'owner'
from generate_series(1, 20000) g join p on p.rn = 1 + (g % :n);
insert into audit_logs (organization_id, actor_id, action, target_type, target_id, detail, created_at)
select :'org', :'owner', 'person.update', 'person', gen_random_uuid()::text, '{}', now() - (g % 1000) * interval '1 hour'
from generate_series(1, 100000) g;

-- 参加集計をまとめて計算
set session_replication_role = origin;
update people p set attendance_count = s.cnt, last_attended_at = s.last_at
from (select ep.person_id, count(*) cnt, max(e.starts_at) last_at from event_participations ep join events e on e.id = ep.event_id
      where ep.organization_id = :'org' and ep.status = 'attended' group by ep.person_id) s
where p.id = s.person_id;

analyze people, person_contacts, person_tags, tags, events, event_participations, companies, person_company_links, interactions, tasks, audit_logs;
select (select count(*) from people where organization_id = :'org') people,
       (select count(*) from event_participations where organization_id = :'org') participations,
       (select count(*) from person_tags where organization_id = :'org') person_tags,
       (select count(*) from interactions where organization_id = :'org') interactions;
