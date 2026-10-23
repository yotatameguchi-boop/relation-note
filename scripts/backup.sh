#!/usr/bin/env bash
# 本番（Supabase）のバックアップを手元に取る。個人情報を含むので、リポジトリの外に保存し、他人と共有しない。
#   scripts/backup.sh [保存先の親フォルダ]   （既定：~/Claude/npo-crm-backups）
# 取得するもの
#   roles.sql   … ロール
#   schema.sql  … 表・関数・RLS（Supabase 管理のスキーマは除く）
#   data.sql    … データ（auth.users などを含む。COPY 形式）
#   storage/    … 写真・出力ファイル（Storage）
#   manifest.txt… 各ファイルの SHA-256 と、主要な表の件数
# 含まれないもの（復元先で設定し直す）：Vault の秘密（暗号鍵がプロジェクトごとに違う）、pg_cron の予定、Edge Function の秘密
#   SOURCE=local scripts/backup.sh <保存先> … 手元のDBから取る（大きなデータで復元時間を測るとき）
# 必要：.env.local の REMOTE_DB_PASSWORD、.env.remote の SUPABASE_SERVICE_ROLE_KEY、supabase CLI、docker
set -euo pipefail
cd "$(dirname "$0")/.."

PARENT="${1:-$HOME/Claude/npo-crm-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$PARENT/$STAMP"
umask 077
mkdir -p "$OUT"

if [ "${SOURCE:-remote}" = local ]; then
  # 手元のDB（復元にかかる時間を大きなデータで測るとき）
  POOLER="postgresql://postgres@127.0.0.1:55622/postgres"
  DB_URL="postgresql://postgres:postgres@127.0.0.1:55622/postgres"
  STORAGE_ENV=.env.local
else
  PASS="$(grep '^REMOTE_DB_PASSWORD=' .env.local | cut -d= -f2-)"
  POOLER="$(cat supabase/.temp/pooler-url)"   # postgresql://postgres.<ref>@<host>:5432/postgres（supabase link で作られる）
  DB_URL="${POOLER/@/:$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PASS")@}"
  STORAGE_ENV=.env.remote
fi

started=$(date +%s)
echo "→ $OUT"
supabase db dump --db-url "$DB_URL" --role-only -f "$OUT/roles.sql"
supabase db dump --db-url "$DB_URL" -f "$OUT/schema.sql"
supabase db dump --db-url "$DB_URL" --data-only --use-copy -f "$OUT/data.sql"

ENV_FILE=$STORAGE_ENV node scripts/storage-sync.mjs download "$OUT/storage"

{
  echo "# RelationNote backup $STAMP"
  echo "# source: $(sed 's/:[^:@]*@/@/' <<<"${POOLER#postgresql://}")"
  echo "## counts"
  psql "$DB_URL" -At -c "select 'organizations', count(*) from organizations union all select 'users', count(*) from users
    union all select 'people', count(*) from people union all select 'event_participations', count(*) from event_participations
    union all select 'interactions', count(*) from interactions union all select 'audit_logs', count(*) from audit_logs
    union all select 'auth.users', count(*) from auth.users union all select 'storage.objects', count(*) from storage.objects order by 1" | tr '|' ' '
  echo "## sha256"
  (cd "$OUT" && find . -type f ! -name manifest.txt -print0 | sort -z | xargs -0 shasum -a 256)
} > "$OUT/manifest.txt"

echo "完了（$(( $(date +%s) - started ))秒）：$(du -sh "$OUT" | cut -f1)"
# 古いバックアップを整理（既定：30日より古いものを削除）
find "$PARENT" -mindepth 1 -maxdepth 1 -type d -mtime +"${KEEP_DAYS:-30}" -exec rm -rf {} +
