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
import { PhotoReviewer, type ReviewDetection } from "@/components/PhotoReviewer";
import { REVIEW_REASON_LABEL } from "@shared/counting";
import { submitPhotoReview } from "./actions";

type Det = { x: number; y: number; w: number; h: number; confidence: number };

async function reviewV1(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const photoId = String(fd.get("photoId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_photo_count_review", {
    photo: photoId, result_id: String(fd.get("resultId")), removed: [], added: [], moved: [],
    p_confirmed: Number(fd.get("confirmed_count")), p_note: String(fd.get("note") ?? ""),
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
  redirect(`${url}?ok=${encodeURIComponent("再解析を受け付けました（解析枠を1枚使用します）。確定済みの人数は上書きされません。")}`);
}

async function remove(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const photoId = String(fd.get("photoId"));
  const supabase = await createClient();
  const { data: ph } = await supabase.from("photos").select("analysis_path, analysis_meta").eq("organization_id", orgId).eq("id", photoId).maybeSingle();
  const { data: path, error } = await supabase.rpc("delete_photo", { photo: photoId });
  if (error) redirect(`/orgs/${orgId}/photos/${photoId}?error=${encodeURIComponent(toMessage(error))}`);
  const tiles = ((ph?.analysis_meta as { tiles?: { path: string }[] } | null)?.tiles ?? []).map((t) => t.path);
  const paths = [path as string, ph?.analysis_path, ...tiles].filter((p): p is string => typeof p === "string" && p.startsWith(`${orgId}/`));
  if (paths.length) await createAdminClient().storage.from("photos").remove(paths);
  redirect(`/orgs/${orgId}/photos`);
}

/** 外部APIの停止などの失敗理由を、次に何をすればよいかと一緒に示す */
function failureHelp(reason: string | null) {
  if (!reason) return null;
  if (/Throttl|ServiceUnavailable|InternalServer|timeout|ECONN|fetch failed|mock outage/i.test(reason)) {
    return "人物検出APIが一時的に利用できませんでした。自動で再試行し、続けて失敗した場合は「処理状況」から管理者が再実行できます。";
  }
  if (/設定されていません|AccessDenied|Unrecognized|Signature/i.test(reason)) {
    return "人物検出APIの設定（認証情報）に問題があります。運営者に連絡してください。設定後に「再解析」で解析できます。";
  }
  if (/deadline_exceeded/.test(reason)) return "実行期限を過ぎたため中止しました。「再解析」で再度解析できます。";
  return "「再解析」で再度解析できます。";
}

export default async function PhotoPage({ params, searchParams }: {
  params: Promise<{ orgId: string; photoId: string }>; searchParams: Promise<{ error?: string; ok?: string; run?: string }>;
}) {
  const { orgId, photoId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const { data: p } = await supabase.from("photos").select("*, events(id, title)").eq("organization_id", orgId).eq("id", photoId).maybeSingle();
  if (!p) notFound();
  const [{ data: runs }, { data: reviews }, { data: jobs }, { data: dup }] = await Promise.all([
    supabase.from("photo_analysis_results").select("*").eq("organization_id", orgId).eq("photo_id", photoId).order("version_no", { ascending: false }),
    supabase.from("photo_reviews").select("*, users(display_name)").eq("organization_id", orgId).eq("photo_id", photoId).order("reviewed_at", { ascending: false }),
    supabase.from("jobs").select("id, status, attempts, last_error, created_at").eq("organization_id", orgId).eq("target_id", photoId).order("created_at", { ascending: false }).limit(5),
    p.duplicate_of ? supabase.from("photos").select("id, original_filename").eq("organization_id", orgId).eq("id", p.duplicate_of).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const latest = runs?.[0];
  const run = (sp.run && runs?.find((r) => r.id === sp.run)) || latest;
  const review = reviews?.[0];
  const reviewedRun = review ? runs?.find((r) => r.id === review.analysis_result_id) : null;
  const newerUnadopted = review && latest && reviewedRun && latest.version_no > reviewedRun.version_no;
  const editor = can(m, "editor");
  const ev = p.events as unknown as { id: string; title: string } | null;
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="photoId" value={photoId} /></>);

  const isV2 = run?.pipeline === "v2";
  const imagePath = isV2 ? p.analysis_path : p.storage_path;
  const signed = p.status === "expired" || p.status === "uploading" || !imagePath
    ? { data: null } : await supabase.storage.from("photos").createSignedUrl(imagePath, 600);
  const { data: dets } = isV2 && run
    ? await supabase.from("photo_detections").select("id, idx, x, y, w, h, score, source, status, suppressed_reason")
        .eq("organization_id", orgId).eq("analysis_result_id", run.id).order("idx")
    : { data: null };
  const { data: calls } = await supabase.from("analysis_usage_records").select("provider, provider_calls, billable_units, job_id")
    .eq("organization_id", orgId).in("job_id", (jobs ?? []).map((j) => j.id));
  const totalCalls = (calls ?? []).reduce((s, c) => s + c.provider_calls, 0);
  const isMock = run?.model_provider === "mock" || run?.model_provider === "test";

  return (
    <>
      {["queued", "analyzing"].includes(p.status) && <AutoRefresh seconds={4} />}
      <div className="spread"><h1>{p.original_filename ?? "写真"}</h1><Link href={`/orgs/${orgId}/photos`}>← 写真一覧</Link></div>
      <p className="small muted">
        <StatusBadge status={p.status} />{ev && <>・<Link href={`/orgs/${orgId}/events/${ev.id}`}>{ev.title}</Link></>}
        ・{p.width && p.height ? `${p.width}×${p.height}px・` : ""}保存期限 {fmtDateTime(p.expires_at)}
        ・{!review ? <span className="badge badge-warn">未確認</span> : <span className="badge badge-ok">確認済み</span>}
      </p>
      <Flash sp={sp} />
      {dup && (
        <div className="notice notice-info small">
          同じ写真ファイルが <Link href={`/orgs/${orgId}/photos/${dup.id}`}>{dup.original_filename ?? "別の写真"}</Link> として登録済みです。
          写真ファイルの重複であり、写っている人物の重複を判定したものではありません。
        </div>
      )}
      {p.status === "failed" && (
        <div className="notice notice-danger">解析に失敗しました：{p.failure_reason}<br /><span className="small">{failureHelp(p.failure_reason)}</span></div>
      )}
      {newerUnadopted && (
        <div className="notice notice-warn small">
          新しい解析結果（第{latest.version_no}版）があります。確定済みの人数（{review.confirmed_count}人・第{reviewedRun.version_no}版で確認）は自動では変わりません。
          内容を確認して採用する場合は、第{latest.version_no}版で確定し直してください。
        </div>
      )}
      {isMock && (
        <div className="notice notice-warn small">
          この解析は開発用のダミー検出（{run?.model_provider}）の結果です。実際の人物検出ではなく、人数として利用できません。
        </div>
      )}

      {run && (
        <div className="grid grid-4" style={{ marginBottom: 12 }}>
          <div className="stat"><div className="label">写真内推定人数（第{run.version_no}版）</div><div className="value">{run.estimated_count}</div>
            <div className="note">{run.raw_detection_count != null ? `整理前の検出 ${run.raw_detection_count}件` : "推定値"}</div></div>
          <div className="stat"><div className="label">写真内確定人数</div><div className="value">{review?.confirmed_count ?? "—"}</div>
            <div className="note">{review ? `${(review.users as { display_name: string } | null)?.display_name ?? ""}・${fmtDateTime(review.reviewed_at)}` : "未確認"}</div></div>
          <div className="stat"><div className="label">外部API呼び出し（この写真）</div><div className="value">{calls ? totalCalls : "—"}</div>
            <div className="note">利用枠の消費（解析枚数）とは別に記録しています</div></div>
          <div className="stat"><div className="label">処理時間</div><div className="value" style={{ fontSize: 18 }}>{run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}秒` : "—"}</div>
            <div className="note">{run.tiles_used > 0 ? `領域分割 ${run.tiles_used}領域を使用` : "全体画像のみ"}</div></div>
        </div>
      )}
      {run && run.review_reasons?.length > 0 && (
        <div className="notice notice-warn small">
          確認してほしい点：{(run.review_reasons as string[]).map((r) => REVIEW_REASON_LABEL[r] ?? r).join("／")}
        </div>
      )}

      {run && isV2 && signed.data?.signedUrl && dets && (
        <PhotoReviewer key={run.id} orgId={orgId} photoId={photoId} resultId={run.id} imageUrl={signed.data.signedUrl}
          detections={dets as ReviewDetection[]} canEdit={editor} submit={submitPhotoReview}
          alreadyConfirmed={review?.confirmed_count ?? null} />
      )}

      {run && !isV2 && (
        <div className="grid grid-2">
          <div className="card">
            {signed.data?.signedUrl ? (
              <div className="photo-stage">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={signed.data.signedUrl} alt="イベント写真" />
                {((run.detections ?? []) as Det[]).map((d, i) => (
                  <div key={i} className="box" style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%`, width: `${d.w * 100}%`, height: `${d.h * 100}%` }}>
                    <span>{Math.round(d.confidence)}</span>
                  </div>
                ))}
              </div>
            ) : <p className="muted">画像を表示できません。</p>}
            <p className="small muted">旧方式（v1）の解析です。向きの補正や重複の整理は行っていません。</p>
          </div>
          {editor && (
            <form action={reviewV1} className="card">
              {hidden}<input type="hidden" name="resultId" value={run.id} />
              <h3 style={{ marginTop: 0 }}>人数を確認して確定</h3>
              <div className="row">
                <input type="number" name="confirmed_count" min={0} required defaultValue={review?.confirmed_count ?? run.estimated_count} style={{ width: 120 }} />
                <input name="note" placeholder="メモ（任意）" style={{ flex: 1 }} />
                <button className="btn-small">確定</button>
              </div>
            </form>
          )}
        </div>
      )}
      {!run && p.status !== "failed" && <div className="card muted">解析待ちです。</div>}
      {p.status === "expired" && <div className="card muted">保存期限を過ぎたため画像は削除されました。人数の記録は残っています。</div>}

      {(runs ?? []).length > 0 && (
        <>
          <h2>解析結果の版</h2>
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>版</th><th>解析日時</th><th>方式・モデル</th><th className="num">推定人数</th><th className="num">整理前</th><th className="num">API呼び出し</th><th>確認</th></tr></thead>
              <tbody>
                {(runs ?? []).map((r) => (
                  <tr key={r.id} style={r.id === run?.id ? { background: "var(--accent-weak)" } : undefined}>
                    <td><Link href={`/orgs/${orgId}/photos/${photoId}?run=${r.id}`}>第{r.version_no}版</Link></td>
                    <td>{fmtDateTime(r.analyzed_at)}</td>
                    <td>{r.pipeline}・{r.model_provider}/{r.model_name}{r.model_version ? ` (${r.model_version})` : ""}</td>
                    <td className="num">{r.estimated_count}</td>
                    <td className="num">{r.raw_detection_count ?? "—"}</td>
                    <td className="num">{r.provider_calls || "—"}</td>
                    <td>{reviews?.some((v) => v.analysis_result_id === r.id) ? <span className="badge badge-ok">この版で確定</span> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {run && (
            <details style={{ marginTop: 8 }}>
              <summary className="small">この版の処理設定</summary>
              <pre>{JSON.stringify(run.settings, null, 2)}</pre>
            </details>
          )}
        </>
      )}

      {(reviews ?? []).length > 0 && (
        <>
          <h2>確定の履歴</h2>
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>日時</th><th>確定者</th><th className="num">検出</th><th>修正内容</th><th className="num">確定人数</th><th>メモ</th></tr></thead>
              <tbody>
                {(reviews ?? []).map((x) => {
                  const adj = (x.adjustments ?? {}) as { removed?: string[]; added?: unknown[]; moved?: unknown[] };
                  const ver = runs?.find((r) => r.id === x.analysis_result_id)?.version_no;
                  return (
                    <tr key={x.id}>
                      <td>{fmtDateTime(x.reviewed_at)}</td>
                      <td>{(x.users as { display_name: string } | null)?.display_name}</td>
                      <td className="num">{x.detected_count ?? "—"}{ver ? `（第${ver}版）` : ""}</td>
                      <td>削除{adj.removed?.length ?? 0}・追加{adj.added?.length ?? 0}・位置修正{adj.moved?.length ?? 0}{x.review_seconds != null ? `・${x.review_seconds}秒` : ""}</td>
                      <td className="num"><strong>{x.confirmed_count}</strong></td>
                      <td>{x.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>解析ジョブ</h2>
      <table className="small"><tbody>
        {(jobs ?? []).map((j) => (
          <tr key={j.id}><td>{fmtDateTime(j.created_at)}</td><td><StatusBadge status={j.status} /></td><td>試行{j.attempts}回</td><td>{j.last_error}</td></tr>
        ))}
      </tbody></table>
      {editor && (
        <div className="row" style={{ marginTop: 12 }}>
          {["analyzed", "failed"].includes(p.status) && (
            <form action={reanalyze}>{hidden}<button className="btn-secondary btn-small">再解析（新しい版として保存）</button></form>
          )}
          <form action={remove}>{hidden}<button className="btn-danger btn-small">写真を削除</button></form>
        </div>
      )}
    </>
  );
}
