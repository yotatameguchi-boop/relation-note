import { describe, expect, it } from "vitest";
import { csvCell, decodeCsvBytes, parseCsv, suggestMapping, toImportRows } from "@/lib/csv";

describe("CSV", () => {
  it("Shift_JIS と UTF-8(BOM付き) を読める", () => {
    const sjis = new Uint8Array([0x8e, 0x81, 0x96, 0xbc, 0x0d, 0x0a, 0x8e, 0x52, 0x93, 0x63]); // 氏名\r\n山田
    expect(decodeCsvBytes(sjis.buffer)).toBe("氏名\r\n山田");
    const utf8 = new TextEncoder().encode("﻿氏名\n山田");
    expect(decodeCsvBytes(utf8.buffer as ArrayBuffer)).toBe("氏名\n山田");
  });

  it("改行やカンマを含むセルを解釈し、空行を飛ばす", () => {
    const { headers, rows } = parseCsv('氏名,ご意見\n"山田, 太郎","1行目\n2行目"\n\n');
    expect(headers).toEqual(["氏名", "ご意見"]);
    expect(rows).toEqual([{ 氏名: "山田, 太郎", ご意見: "1行目\n2行目" }]);
  });

  it("Googleフォーム風の列名から対応先を推測する", () => {
    const m = suggestMapping(["タイムスタンプ", "お名前", "ふりがな", "メールアドレス", "電話番号", "お住まいの市区町村", "関心のある分野", "参加の動機"]);
    expect(m).toEqual({
      タイムスタンプ: "submitted_at", お名前: "full_name", ふりがな: "full_name_kana", メールアドレス: "email",
      電話番号: "phone", お住まいの市区町村: "region", 関心のある分野: "tags", 参加の動機: "attr:参加の動機",
    });
  });

  it("回答IDの列があれば重複判定キーにする", () => {
    const rows = toImportRows([{ id: "r1", n: "a" }, { id: "", n: "b" }], { id: "external_id", n: "full_name" });
    expect(rows.map((r) => r.dedupe_key)).toEqual(["r1", null]);
  });

  it("出力時に数式として解釈されないようにする", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe("");
  });
});
