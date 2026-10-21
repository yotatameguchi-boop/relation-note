import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toMessage } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { Flash, StatusBadge } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";

type Det = { x: number; y: number; w: number; h: number; confidence: number };

async function review(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const photoId = String(fd.get("photoId"));
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("photo_reviews").insert({
    organization_id: orgId, photo_id: photoId, analysis_result_id: String(fd.get("resultId") ?? "") || null,
    confirmed_count: Number(fd.get("confirmed_count")), note: String(fd.get("note") ?? "") || null, reviewed_by: u.user?.id,
  });
  const url = `/orgs/${orgId}/photos/${photoId}`;
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url);
  redirect(`${url}?ok=${encodeURIComponent("写真内の人数を確定しました。")}`);
}

async function reanalyze(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const photoId = String(fd.get("photoId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("reanalyze_photo", { photo: photoId });
  const url = `/orgs/${orgId}/photos/${photoId}`;
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url}?ok=${encodeURIComponent("再解析を受け付けました（解析枠を1枚使用します）。")}`);
}

async function remove(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const photoId = String(fd.get("photoId"));
  const supabase = await createClient();
  const { data: path, error } = await supabase.rpc("delete_photo", { photo: photoId });
  if (error) redirect(`/orgs/${orgId}/photos/${photoId}?error=${encodeURIComponent(toMessage(error))}`);
  if (typeof path === "string" && path.startsWith(`${orgId}/`)) await createAdminClient().storage.from("photos").remove([path]);
  redirect(`/orgs/${orgId}/photos`);
}

export default async function PhotoPage({ params, searchParams }: {
  params: Promise<{ orgId: string; photoId: string }>; searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { orgId, photoId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const { data: p } = await supabase.from("photos").select("*, events(id, title)").eq("organization_id", orgId).eq("id", photoId).maybeSingle();
  if (!p) notFound();
  const [{ data: results }, { data: reviews }, { data: jobs }, signed] = await Promise.all([
    supabase.from("photo_analysis_results").select("*").eq("organization_id", orgId).eq("photo_id", photoId).order("analyzed_at", { ascending: false }),
    supabase.from("photo_reviews").select("*, users(display_name)").eq("organization_id", orgId).eq("photo_id", photoId).order("reviewed_at", { ascending: false }),
    supabase.from("jobs").select("id, status, attempts, last_error, created_at").eq("organization_id", orgId).eq("target_id", photoId).order("created_at", { ascending: false }).limit(5),
    // 閲覧は所属メンバーのみ（ストレージのRLS）。期限付きURLで表示する
    p.status === "expired" || p.status === "uploading" ? Promise.resolve({ data: null }) : supabase.storage.from("photos").createSignedUrl(p.storage_path, 600),
  ]);
  const r = results?.[0];
  const v = reviews?.[0];
  const dets = (r?.detections ?? []) as Det[];
  const editor = can(m, "editor");
  const ev = p.events as unknown as { id: string; title: string } | null;
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="photoId" value={photoId} /></>);

  return (
    <>
      {["queued", "analyzing"].includes(p.status) && <AutoRefresh seconds={4} />}
      <div className="spread"><h1>{p.original_filename ?? "写真"}</h1><Link href={`/orgs/${orgId}/photos`}>← 写真一覧</Link></div>
      <p className="small muted">
        <StatusBadge status={p.status} />{ev && <>・<Link href={`/orgs/${orgId}/events/${ev.id}`}>{ev.title}</Link></>}・保存期限 {fmtDateTime(p.expires_at)}
      </p>
      <Flash sp={sp} />
      {p.status === "failed" && <div className="notice notice-danger">解析に失敗しました：{p.failure_reason}</div>}

      <div className="grid grid-2">
        <div className="card">
          {signed.data?.signedUrl ? (
            <div className="photo-stage">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={signed.data.signedUrl} alt="イベント写真" />
              {dets.map((d, i) => (
                <div key={i} className="box" style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%`, width: `${d.w * 100}%`, height: `${d.h * 100}%` }}>
                  <span>{Math.round(d.confidence)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{p.status === "expired" ? "保存期限を過ぎたため画像は削除されました。人数の記録は残っています。" : "画像を表示できません。"}</p>
          )}
        </div>
        <div>
          <div className="grid grid-4">
            <div className="stat"><div className="label">写真内推定人数</div><div className="value">{r?.estimated_count ?? "—"}</div></div>
            <div className="stat"><div className="label">写真内確定人数</div><div className="value">{v?.confirmed_count ?? "—"}</div></div>
          </div>
          {r && (
            <p className="small muted" style={{ marginTop: 8 }}>
              モデル: {r.model_provider} / {r.model_name}{r.model_version && ` (${r.model_version})`}・信頼度{r.min_confidence}以上・解析 {fmtDateTime(r.analyzed_at)}
              {r.model_provider === "mock" && <><br /><strong>開発用のダミー検出です。実際の人数ではありません。</strong></>}
            </p>
          )}
          {editor && r && (
            <form action={review} className="card" style={{ marginTop: 12 }}>
              {hidden}
              <input type="hidden" name="resultId" value={r.id} />
              <h3 style={{ marginTop: 0 }}>人数を確認・修正して確定</h3>
              <p className="small muted">枠の重複・見落としを確認し、写真に写っている人数を入力してください。この値はイベント参加人数には自動で反映されません。</p>
              <div className="row">
                <input type="number" name="confirmed_count" min={0} required defaultValue={v?.confirmed_count ?? r.estimated_count} style={{ width: 120 }} />
                <input name="note" placeholder="メモ（任意）" style={{ flex: 1 }} />
                <button className="btn-small">確定</button>
              </div>
            </form>
          )}
          {(reviews ?? []).length > 0 && (
            <>
              <h3>確定の履歴</h3>
              <table className="small"><tbody>
                {(reviews ?? []).map((x) => (
                  <tr key={x.id}><td>{fmtDateTime(x.reviewed_at)}</td><td>{(x.users as { display_name: string } | null)?.display_name}</td><td className="num">{x.confirmed_count}人</td><td>{x.note}</td></tr>
                ))}
              </tbody></table>
            </>
          )}
          <h3>解析ジョブ</h3>
          <table className="small"><tbody>
            {(jobs ?? []).map((j) => (
              <tr key={j.id}><td>{fmtDateTime(j.created_at)}</td><td><StatusBadge status={j.status} /></td><td>試行{j.attempts}回</td><td>{j.last_error}</td></tr>
            ))}
          </tbody></table>
          {editor && (
            <div className="row" style={{ marginTop: 12 }}>
              {["analyzed", "failed"].includes(p.status) && (
                <form action={reanalyze}>{hidden}<button className="btn-secondary btn-small">再解析</button></form>
              )}
              <form action={remove}>{hidden}<button className="btn-danger btn-small">写真を削除</button></form>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
