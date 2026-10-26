-- 脆弱性診断（2026-10-26）での指摘への対応
-- 1) 未ログイン（anon）は、どの表も関数も使わない（公開ページはサーバー側でサービスロールを使う）。
--    行単位の制御（RLS）で守られてはいたが、権限そのものを外して二重に守る。
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- 2) 内部用の関数を利用者から直接呼べないようにする
--    usage_in_use：組織IDを指定すると、所属していない組織の利用量（写真の枚数・容量）が分かった
--    share_grant_state / authorization_state：共有の状態の計算（画面からは集計関数経由でだけ使う）
revoke execute on function public.usage_in_use(uuid, text) from public, authenticated;
revoke execute on function public.share_grant_state(public.person_share_grants) from public, authenticated;
revoke execute on function public.authorization_state(public.sharing_authorizations) from public, authenticated;
grant execute on function public.usage_in_use(uuid, text) to service_role;
grant execute on function public.share_grant_state(public.person_share_grants) to service_role;
grant execute on function public.authorization_state(public.sharing_authorizations) to service_role;
