// 監視のしきい値。ops_health() の数値から状態を決める（純粋な関数。テストあり）
export type OpsHealth = {
  worker_minutes_since_run: number | string;
  queue_length: number;
  queue_oldest_minutes: number;
  jobs_dead_24h: number;
  jobs_running_stuck: number;
  cron_failures_1h: number;
  emails_failed_24h: number;
  connectors_in_error: number;
  db_size_mb: number;
  orgs: { active: number; suspended: number; past_due: number };
};

// 無料プランの DB 容量は 500MB。8割で知らせる
export const LIMITS = {
  workerStaleMinutes: 10,
  queueOldestMinutes: 15,
  deadJobs24h: 5,
  stuckJobs: 1,
  cronFailures1h: 3,
  emailsFailed24h: 20,
  dbSizeMb: 400,
};

export function evaluateHealth(h: OpsHealth) {
  const problems: string[] = [];
  const since = Number(h.worker_minutes_since_run);
  if (!Number.isFinite(since) || since > LIMITS.workerStaleMinutes) problems.push(`worker_stale:${Number.isFinite(since) ? `${since}min` : "never"}`);
  if (h.queue_oldest_minutes > LIMITS.queueOldestMinutes) problems.push(`queue_backlog:${h.queue_length}jobs/${h.queue_oldest_minutes}min`);
  if (h.jobs_dead_24h >= LIMITS.deadJobs24h) problems.push(`dead_jobs_24h:${h.jobs_dead_24h}`);
  if (h.jobs_running_stuck >= LIMITS.stuckJobs) problems.push(`stuck_jobs:${h.jobs_running_stuck}`);
  if (h.cron_failures_1h >= LIMITS.cronFailures1h) problems.push(`cron_failures_1h:${h.cron_failures_1h}`);
  if (h.emails_failed_24h >= LIMITS.emailsFailed24h) problems.push(`emails_failed_24h:${h.emails_failed_24h}`);
  if (h.db_size_mb >= LIMITS.dbSizeMb) problems.push(`db_size:${h.db_size_mb}MB`);
  // down は「DB に届かない」ときだけ（route 側で判定）。ここでは画面は使えるが裏の処理に問題がある状態を degraded とする
  return { status: problems.length ? "degraded" : "ok", problems } as { status: "ok" | "degraded" | "down"; problems: string[] };
}
