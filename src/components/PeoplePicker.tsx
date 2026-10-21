import { createClient } from "@/lib/supabase/server";

/** 共有画面で使う人物の選択欄。?people=（カンマ区切り）で選択済み、?q= で検索して追加する */
export async function PeoplePicker({ orgId, selected, q, name = "people" }: { orgId: string; selected: string[]; q?: string; name?: string }) {
  const supabase = await createClient();
  const [{ data: chosen }, search] = await Promise.all([
    selected.length
      ? supabase.from("people").select("id, full_name, region").eq("organization_id", orgId).in("id", selected.slice(0, 200))
      : Promise.resolve({ data: [] as { id: string; full_name: string; region: string | null }[] }),
    q ? supabase.rpc("search_people", { org: orgId, q, page_size: 30, page: 1 }) : Promise.resolve({ data: null }),
  ]);
  const extra = ((search.data ?? []) as { id: string; full_name: string; region: string | null }[]).filter((p) => !selected.includes(p.id));
  return (
    <div className="field">
      <label>対象の活動者（{(chosen ?? []).length}人選択中）</label>
      <div className="stack" style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
        {(chosen ?? []).map((p) => (
          <label key={p.id} className="row" style={{ margin: 0, color: "var(--text)" }}>
            <input type="checkbox" name={name} value={p.id} defaultChecked />{p.full_name}<span className="small muted">{p.region}</span>
          </label>
        ))}
        {extra.map((p) => (
          <label key={p.id} className="row" style={{ margin: 0, color: "var(--text)" }}>
            <input type="checkbox" name={name} value={p.id} />{p.full_name}<span className="small muted">{p.region}（検索結果）</span>
          </label>
        ))}
        {!(chosen ?? []).length && !extra.length && <span className="small muted">上の検索欄で活動者を探すか、人物一覧で選んでから開いてください。</span>}
      </div>
    </div>
  );
}
