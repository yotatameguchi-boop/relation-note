import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { URL as SB_URL, must, newOrg, newUser } from "./helpers";
import { csvCell } from "@shared/csv";

describe("脆弱性診断での指摘への対応", () => {
  it("未ログインでは、どの表も関数も使えない", async () => {
    const owner = await newUser("sec-owner");
    const org = await newOrg(owner);
    must(await owner.client.rpc("create_person", { org, data: { full_name: "公開されてはいけない人" } }));
    const anon = createClient(SB_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    for (const t of ["people", "organizations", "users", "audit_logs", "person_contacts", "form_submissions", "saved_charts"]) {
      const r = await anon.from(t).select("*").limit(1);
      expect(r.error, t).not.toBeNull();
    }
    for (const [fn, args] of [["search_people", { org }], ["org_usage", { org }], ["insight_query", { org, metric: "people_total", dim: "region" }], ["create_organization", { org_name: "x" }]] as const) {
      expect((await anon.rpc(fn, args)).error, fn).not.toBeNull();
    }
  });

  it("所属していない組織の利用量を内部関数から読めない", async () => {
    const a = await newUser("sec-a");
    const org = await newOrg(a);
    const b = await newUser("sec-b");
    expect((await b.client.rpc("usage_in_use", { org, m: "photo_analysis" })).error).not.toBeNull();
    expect((await a.client.rpc("usage_in_use", { org, m: "photo_analysis" })).error).not.toBeNull();
    expect(must(await a.client.rpc("org_usage", { org }))).toBeTruthy(); // 画面用の関数（権限確認あり）は使える
  });

  it("CSV のセルが数式として実行されないようにする", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+81")).toBe("'+81");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("北区")).toBe("北区");
  });
});
