#!/usr/bin/env bash
# バックアップからの復元試験。手元に「空の Supabase」を別に立て、バックアップを流し込み、件数・ログイン・権限・ファイルを確かめる。
#   scripts/restore-test.sh <バックアップのフォルダ> [ログイン確認に使う env（DEMO_LOGIN_* か DEV_LOGIN_*）]
# 復元先は使い捨て（ポート 566xx・project_id npo-crm-restore）。終わったら止めて消す（KEEP=1 なら残す）。
# 本番の障害時も同じ手順で、新しい Supabase プロジェクトへ復元する（README「バックアップと復元」）。
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$(cd "$1" && pwd)"
LOGIN_ENV="${2:-.env.remote}"
WORK="${RESTORE_WORKDIR:-$(mktemp -d -t npo-crm-restore)}"
t0=$(date +%s)
step() { echo "[$(( $(date +%s) - t0 ))s] $*"; }

step "復元先を起動（$WORK）"
mkdir -p "$WORK/supabase"
sed -E -e 's/^project_id = .*/project_id = "npo-crm-restore"/' -e 's/^(port|shadow_port) = 556([0-9]+)/\1 = 566\2/' \
  supabase/config.toml > "$WORK/supabase/config.toml"
# 本番と同じ版の Postgres・Auth・Storage を使う（supabase link 時に記録された版。表の形が本番と揃う）
mkdir -p "$WORK/supabase/.temp"
for f in postgres-version gotrue-version storage-version rest-version; do
  [ -f "supabase/.temp/$f" ] && cp "supabase/.temp/$f" "$WORK/supabase/.temp/$f"
done
supabase start --workdir "$WORK" -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,realtime,postgres-meta >/dev/null
trap '[ "${KEEP:-0}" = 1 ] || supabase stop --workdir "$WORK" --no-backup >/dev/null 2>&1 || true' EXIT
eval "$(supabase status --workdir "$WORK" -o env | grep -E '^(API_URL|DB_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
t_up=$(date +%s)

step "データベースを復元（roles → schema → data）"
# Supabase の手順どおり、データは参照整合性のトリガーを止めて（replica）流し込む
# ロールの設定は Supabase 管理のロール（realtime 等）を含むため、手元の復元先に無いものは警告だけで続ける
psql "$DB_URL" -q -f "$SRC/roles.sql" 2>&1 | sed 's/^/  (roles) /' || true
psql "$DB_URL" -At -c "select table_schema || '.' || table_name from information_schema.tables where table_schema in ('auth', 'storage')" > "$WORK/target-tables.txt"
grep -oE '^CREATE TABLE IF NOT EXISTS "[^"]+"\."[^"]+"' "$SRC/schema.sql" | sed -E 's/.*"([^"]+)"\."([^"]+)"/\1.\2/' >> "$WORK/target-tables.txt"
# ジョブのキュー（pgmq）の表は schema.sql に含まれないので、復元時に pgmq.create('jobs') で作る
echo "pgmq.q_jobs
pgmq.a_jobs" >> "$WORK/target-tables.txt"
python3 scripts/filter-data-dump.py "$SRC/data.sql" "$WORK/target-tables.txt" > "$WORK/data.sql"
PGOPTIONS="-c client_min_messages=error" psql "$DB_URL" -q -v ON_ERROR_STOP=1 --single-transaction \
  -c "set statement_timeout = 0" \
  -f "$SRC/schema.sql" \
  -c "select pgmq.create('jobs')" \
  -c "set session_replication_role = replica" -f "$WORK/data.sql" >/dev/null
t_db=$(date +%s)

step "件数を比べる"
expected="$(sed -n '/^## counts/,/^## /p' "$SRC/manifest.txt" | grep -v '^##' | sort)"
actual="$(psql "$DB_URL" -At -c "select 'organizations', count(*) from organizations union all select 'users', count(*) from users
    union all select 'people', count(*) from people union all select 'event_participations', count(*) from event_participations
    union all select 'interactions', count(*) from interactions union all select 'audit_logs', count(*) from audit_logs
    union all select 'auth.users', count(*) from auth.users union all select 'storage.objects', count(*) from storage.objects order by 1" | tr '|' ' ' | sort)"
if [ "$expected" != "$actual" ]; then echo "件数が一致しません"; diff <(echo "$expected") <(echo "$actual"); exit 1; fi
echo "$actual" | sed 's/^/  /'

step "関数・RLS・定期処理の確認"
psql "$DB_URL" -At -v ON_ERROR_STOP=1 <<'SQL'
select '  RLS 無効の表: ' || coalesce(string_agg(relname, ', '), 'なし') from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
select '  public の関数: ' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
select '  pg_cron の予定: ' || count(*) || '件（復元先では migrations の cron.schedule を流し直す）' from cron.job;
select '  Vault の秘密: ' || count(*) || '件（暗号鍵が違うため復元されない。設定し直す）' from vault.secrets;
SQL

step "ストレージを復元して照合"
cat > "$WORK/.env.restore" <<EOF
NEXT_PUBLIC_SUPABASE_URL=$API_URL
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
EOF
ENV_FILE="$WORK/.env.restore" node scripts/storage-sync.mjs upload "$SRC/storage"
ENV_FILE="$WORK/.env.restore" node scripts/storage-sync.mjs verify "$SRC/storage"
t_files=$(date +%s)

step "復元したデータに元のアカウントでログインし、RLS 越しに読めるか"
LOGIN_ENV="$LOGIN_ENV" API_URL="$API_URL" ANON_KEY="$ANON_KEY" node --input-type=module <<'JS'
import { createClient } from "@supabase/supabase-js";
const env = {};
for (const l of (await import("node:fs")).readFileSync(process.env.LOGIN_ENV, "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
const email = env.DEMO_LOGIN_EMAIL ?? env.DEV_LOGIN_EMAIL, password = env.DEMO_LOGIN_PASSWORD ?? env.DEV_LOGIN_PASSWORD;
const c = createClient(process.env.API_URL, process.env.ANON_KEY, { auth: { persistSession: false } });
const { error } = await c.auth.signInWithPassword({ email, password });
if (error) { console.error("  ログインできません:", error.message); process.exit(1); }
const { data: orgs, error: e2 } = await c.from("memberships").select("organization_id, role, organizations(name)");
if (e2) throw e2;
for (const o of orgs) {
  const { count } = await c.from("people").select("id", { count: "exact", head: true }).eq("organization_id", o.organization_id);
  const { error: e3 } = await c.rpc("org_metrics", { org: o.organization_id, from_ts: new Date(Date.now() - 365 * 86400e3).toISOString(), to_ts: new Date().toISOString() });
  console.log(`  ${o.organizations.name}（${o.role}）：人物 ${count}件、ダッシュボード集計 ${e3 ? "失敗 " + e3.message : "OK"}`);
  if (e3) process.exit(1);
}
JS
t_end=$(date +%s)
echo "復元試験 OK：起動 $(( t_up - t0 ))秒／DB $(( t_db - t_up ))秒／ファイル $(( t_files - t_db ))秒／合計 $(( t_end - t0 ))秒（$(du -sh "$SRC" | cut -f1)）"
