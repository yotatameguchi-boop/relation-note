import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chartKind, rangeBounds, shapeResult, type FieldDef, type Row, type Shaped, type Spec } from "@/lib/insights";

export type FieldWithOptions = FieldDef & { options: string[] };

export async function loadFields(supabase: SupabaseClient, orgId: string): Promise<FieldWithOptions[]> {
  const { data } = await supabase.from("custom_field_definitions").select("key, label, field_type, options")
    .eq("organization_id", orgId).eq("entity", "person").eq("archived", false).order("position");
  return (data ?? []) as FieldWithOptions[];
}

/** 集計して、グラフ用に整える（RLS の効くスタッフの権限で実行） */
export async function runInsight(supabase: SupabaseClient, orgId: string, spec: Spec, fields: FieldWithOptions[], now: number)
  : Promise<{ shaped: Shaped; kind: "line" | "column" | "bar" | "pie"; error: string | null }> {
  const { from, to } = rangeBounds(spec.range, now);
  const { data, error } = await supabase.rpc("insight_query", {
    org: orgId, metric: spec.metric, dim: spec.dim, series: spec.series ?? null,
    from_ts: new Date(from).toISOString(), to_ts: new Date(to).toISOString(),
    field_key: spec.fieldKey ?? null, series_field_key: spec.seriesFieldKey ?? null,
  });
  const options = spec.dim === "field" ? fields.find((f) => f.key === spec.fieldKey)?.options ?? [] : [];
  const shaped = shapeResult(spec, (data ?? []) as Row[], now, options);
  return {
    shaped,
    kind: chartKind(spec, shaped),
    error: error ? (error.message === "invalid_field" ? "この追加項目ではグラフにできません（選択式・チェックの項目のみ）。" : "集計できませんでした。条件を変えてお試しください。") : null,
  };
}
