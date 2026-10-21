import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { snapshotRows } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { SharingDisabled, SharingTabs } from "@/components/SharingTabs";

export default async function ReceivedDetail({ params }: { params: Promise<{ orgId: string; grantId: string }> }) {
  const { orgId, grantId } = await params;
  const { enabled, manage, view } = await sharingContext(orgId, "view");
  if (!enabled) return <SharingDisabled />;
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("shared_person_detail", { org: orgId, p_grant: grantId });
  // 理由（停止・期限切れ・存在しない等）を区別して見せない
  if (error || !data) notFound();
  const d = data as { source_name: string; version: number; published_at: string; expires_at: string; snapshot: Record<string, unknown> };
  const rows = snapshotRows(d.snapshot);
  const title = (d.snapshot.display_name as string) || (d.snapshot.full_name as string) || "（氏名は共有されていません）";
  return (
    <>
      <div className="spread"><h1><span className="shared-badge">他団体から共有</span> {title}</h1><Link href={`/orgs/${orgId}/sharing/received`}>← 一覧</Link></div>
      <SharingTabs orgId={orgId} current="received" manage={manage} view={view} />
      <div className="card shared-card">
        <p className="small">
          共有元：<strong>{d.source_name}</strong>・公開日時 {fmtDateTime(d.published_at)}（第{d.version}版）・共有期限 {fmtDate(d.expires_at)}
        </p>
        <table><tbody>
          {rows.map((r) => (
            <tr key={r.label}><th style={{ width: "30%" }}>{r.label}{r.contact && <span className="badge badge-warn" style={{ marginLeft: 4 }}>連絡先</span>}</th><td>{r.value}</td></tr>
          ))}
        </tbody></table>
        <p className="small muted" style={{ marginTop: 10 }}>
          共有元が公開した時点の内容です（元の情報が最新とは限りません）。共有の目的の範囲で利用してください。
          この情報は自団体の人物台帳には取り込まれず、編集・出力・再共有はできません。閲覧は記録されています。
        </p>
      </div>
    </>
  );
}
