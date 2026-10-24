import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { can, requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { nowMs } from "@/lib/format";
import { EXAMPLES, METRICS, RANGES, isSpec, normalizeSpec, parseQuestion, specFromParams, specTitle, specToParams, type Spec } from "@/lib/insights";
import { loadFields, runInsight } from "@/lib/insights-server";
import { InsightCard, SpecControls } from "@/components/InsightView";
import { Flash } from "@/components/ui";

async function saveChart(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const spec = JSON.parse(String(fd.get("spec") ?? "null"));
  const title = String(fd.get("title") ?? "").trim().slice(0, 80);
  const back = `/orgs/${orgId}/insights?${String(fd.get("qs") ?? "")}`;
  if (!isSpec(spec) || !title) redirect(`${back}&error=${encodeURIComponent("保存できませんでした。")}`);
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("saved_charts").insert({ organization_id: orgId, title, spec, created_by: u.user?.id });
  if (error) redirect(`${back}&error=${encodeURIComponent("保存できませんでした（編集者以上が保存できます）。")}`);
  revalidatePath(`/orgs/${orgId}`);
  redirect(`${back}&ok=${encodeURIComponent("ダッシュボードに追加しました。")}`);
}

export default async function InsightsPage({ params, searchParams }: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const fields = await loadFields(supabase, orgId);
  const now = nowMs();
  const base = `/orgs/${orgId}/insights`;

  // 入力文があれば読み取って条件にし、URL を条件の形に置き換える（戻る・共有ができるように）
  if (sp.q && !sp.m) {
    const parsed = parseQuestion(sp.q, fields, now);
    const u = new URLSearchParams(specToParams(parsed.spec));
    u.set("q", sp.q);
    if (parsed.unknown) u.set("unknown", "1");
    redirect(`${base}?${u}`);
  }
  const spec: Spec = normalizeSpec(specFromParams(sp) ?? { metric: "people_total", dim: "month", range: "last12m" }, now);
  const { shaped, kind, error } = await runInsight(supabase, orgId, spec, fields, now);
  const title = specTitle(spec, fields);
  const understood = sp.q ? parseQuestion(sp.q, fields, now).understood : [];
  const qs = specToParams(spec);

  return (
    <>
      <h1>グラフ分析</h1>
      <Flash sp={{ error: sp.error ?? error ?? undefined, ok: sp.ok }} />
      <form className="card" action={base}>
        <label htmlFor="q" className="small muted">知りたいことを入力してください</label>
        <div className="ask" style={{ marginTop: 6 }}>
          <input id="q" name="q" defaultValue={sp.q ?? ""} placeholder="例：今年の新規登録数を月別に / 地域別の人数 / 参加回数別の人数" maxLength={100} autoComplete="off" />
          <button>グラフにする</button>
        </div>
        <div className="chips" aria-label="入力の例">
          {EXAMPLES.map((e) => <Link key={e} className="chip" href={`${base}?q=${encodeURIComponent(e)}`}>{e}</Link>)}
        </div>
      </form>

      {sp.q && (
        <div className="understood" aria-label="読み取った条件">
          {sp.unknown
            ? <span style={{ background: "var(--warn-weak)", color: "var(--warn)" }}>うまく読み取れませんでした。下の条件で選び直してください</span>
            : understood.map((u) => <span key={u}>{u}</span>)}
        </div>
      )}

      <div className="card">
        <SpecControls spec={spec} fields={fields} base={base} />
      </div>

      <InsightCard
        title={title}
        sub={`${RANGES[spec.range]}${METRICS[spec.metric].note ? `・${METRICS[spec.metric].note}` : ""}`}
        data={shaped} kind={kind} unit={METRICS[spec.metric].unit} spec={spec} base={base}
        actions={can(m, "editor") ? (
          <form action={saveChart} className="row">
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="spec" value={JSON.stringify(spec)} />
            <input type="hidden" name="qs" value={qs} />
            <input name="title" defaultValue={title} maxLength={80} aria-label="グラフの名前" style={{ width: 200 }} />
            <button className="btn-small">ダッシュボードに追加</button>
          </form>
        ) : null}
      />
      <p className="small muted">
        集計は、このページを開いた時点のデータです。期間は日本時間の暦で区切ります。人数を表す指標は、人物を統合すると統合後の1人として数えます。
      </p>
    </>
  );
}
