#!/usr/bin/env bash
# ローカル開発用：Supabase Cron（pg_cron）が毎分ワーカー（Edge Function）を起動できるよう、
# 起動先URLと秘密を Vault に登録する。本番では project_url に https://<ref>.supabase.co を登録する。
set -euo pipefail
cd "$(dirname "$0")/.."
SECRET=$(grep '^WORKER_SECRET=' supabase/functions/.env | cut -d= -f2-)
DB_URL=$(supabase status -o env 2>/dev/null | grep '^DB_URL=' | cut -d= -f2- | tr -d '"')
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -v secret="$SECRET" <<'SQL'
delete from vault.secrets where name in ('project_url', 'worker_secret');
select vault.create_secret('http://host.docker.internal:55621', 'project_url');
select vault.create_secret(:'secret', 'worker_secret');
SQL
echo "registered project_url / worker_secret in Vault"
