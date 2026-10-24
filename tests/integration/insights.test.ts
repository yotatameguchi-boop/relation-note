import { describe, expect, it } from "vitest";
import { admin, join, must, newOrg, newUser } from "./helpers";

const range = { from_ts: new Date(Date.now() - 365 * 86400e3).toISOString(), to_ts: new Date(Date.now() + 86400e3).toISOString() };

describe("グラフ分析", () => {
  it("地域・タグ・参加回数・追加項目で集計し、指標に合わない切り口や他組織は拒否する", async () => {
    const o = await newUser("ins-owner");
    const org = await newOrg(o);
    const tag = must(await o.client.from("tags").insert({ organization_id: org, name: "ボランティア" }).select("id").single()).id;
    must(await o.client.from("custom_field_definitions").insert({ organization_id: org, entity: "person", key: "kind", label: "会員種別", field_type: "select", options: ["正会員", "賛助会員"] }));
    const ids: string[] = [];
    for (const [name, region, kind] of [["A", "北区", "正会員"], ["B", "北区", "賛助会員"], ["C", "南区", null], ["D", "", null]] as const) {
      ids.push(must(await o.client.rpc("create_person", { org, data: { full_name: name, region } })) as string);
      if (kind) must(await o.client.rpc("set_custom_fields", { p_entity: "person", record_id: ids.at(-1), vals: { kind } }));
    }
    must(await o.client.from("person_tags").insert([{ organization_id: org, person_id: ids[0], tag_id: tag }, { organization_id: org, person_id: ids[1], tag_id: tag }]));
    const ev = must(await o.client.from("events").insert({ organization_id: org, title: "清掃", starts_at: new Date(Date.now() - 86400e3).toISOString() }).select("id").single()).id;
    must(await o.client.from("event_participations").insert([
      { organization_id: org, event_id: ev, person_id: ids[0], status: "attended" },
      { organization_id: org, event_id: ev, person_id: ids[2], status: "attended" },
      { organization_id: org, event_id: ev, person_id: ids[3], status: "applied" },
    ]));

    const q = async (metric: string, dim: string, extra: Record<string, unknown> = {}) =>
      Object.fromEntries((must(await o.client.rpc("insight_query", { org, metric, dim, ...range, ...extra })) as { x: string; s: string | null; value: number }[])
        .map((r) => [r.s ? `${r.x}/${r.s}` : r.x, Number(r.value)]));

    expect(await q("people_total", "region")).toEqual({ 北区: 2, 南区: 1, 未設定: 1 });
    expect(await q("people_total", "tag")).toEqual({ ボランティア: 2, タグなし: 2 });
    expect(await q("people_total", "attendance_band")).toEqual({ "0回": 2, "1回": 2 });
    expect(await q("people_total", "field", { field_key: "kind" })).toEqual({ 正会員: 1, 賛助会員: 1, 未設定: 2 });
    expect(await q("attendances", "region")).toEqual({ 北区: 1, 南区: 1 });
    expect(await q("participants", "event")).toEqual({ 清掃: 2 });
    const month = new Date(Date.now() - 86400e3 + 9 * 3600e3).toISOString().slice(0, 7);
    expect(await q("attendances", "month", { series: "tag" })).toEqual({ [`${month}/ボランティア`]: 1, [`${month}/タグなし`]: 1 });

    for (const [metric, dim, extra] of [["events", "region", {}], ["people_total", "kind", {}], ["people_total", "field", { field_key: "nope" }], ["people_total", "x; drop table people", {}]] as const) {
      const r = await o.client.rpc("insight_query", { org, metric, dim, ...range, ...extra });
      expect(r.error, `${metric}/${dim}`).not.toBeNull();
    }
    const other = await newUser("ins-other");
    const r = await other.client.rpc("insight_query", { org, metric: "people_total", dim: "region", ...range });
    expect(r.error?.message).toBe("forbidden");
  });

  it("人数の推移は期間前の人数を __base__ で返す", async () => {
    const o = await newUser("ins-cum");
    const org = await newOrg(o);
    must(await o.client.rpc("create_person", { org, data: { full_name: "古い人" } }));
    const rows = must(await o.client.rpc("insight_query", { org, metric: "people_total", dim: "month",
      from_ts: new Date(Date.now() + 3600e3).toISOString(), to_ts: new Date(Date.now() + 86400e3).toISOString() })) as { x: string; value: number }[];
    expect(rows).toEqual([{ x: "__base__", s: null, value: 1 }]);
  });

  it("ダッシュボードのグラフ：編集者以上が追加でき、閲覧者は見るだけ。外せるのは作った人か管理者", async () => {
    const o = await newUser("sc-owner");
    const org = await newOrg(o);
    const ed = await newUser("sc-editor");
    const vw = await newUser("sc-viewer");
    await join(org, o, ed, "editor");
    await join(org, o, vw, "viewer");
    const spec = { metric: "people_total", dim: "region", range: "last12m" };
    const id = must(await ed.client.from("saved_charts").insert({ organization_id: org, title: "地域別", spec, created_by: ed.id }).select("id").single()).id;
    expect((await vw.client.from("saved_charts").insert({ organization_id: org, title: "x", spec, created_by: vw.id })).error).not.toBeNull();
    expect((await vw.client.from("saved_charts").select("id").eq("organization_id", org)).data!.length).toBe(1);
    const ed2 = await newUser("sc-editor2");
    await join(org, o, ed2, "editor");
    await ed2.client.from("saved_charts").delete().eq("id", id);
    expect((await admin.from("saved_charts").select("id").eq("id", id)).data!.length).toBe(1);
    await o.client.from("saved_charts").delete().eq("id", id);
    expect((await admin.from("saved_charts").select("id").eq("id", id)).data!.length).toBe(0);
  });
});
