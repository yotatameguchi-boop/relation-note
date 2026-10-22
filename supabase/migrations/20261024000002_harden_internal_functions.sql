-- 内部用の関数を、利用者（anon / authenticated）から直接呼べないようにする。
-- いずれも security definer の関数の中からだけ使う。
--   audit：任意の組織の操作履歴に書き込めてしまうため
--   refresh_person_stats：任意の組織の集計を書き換えられるため
--   staff_seats_used / partnership_active / feature_enabled / validate_custom_fields：他組織の情報の推測に使えるため
do $$
declare f text;
begin
  foreach f in array array[
    'audit(uuid, text, text, text, jsonb)', 'refresh_person_stats(uuid, uuid)', 'staff_seats_used(uuid)',
    'partnership_active(uuid, uuid)', 'feature_enabled(uuid, text)', 'validate_custom_fields(uuid, text, jsonb, jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
