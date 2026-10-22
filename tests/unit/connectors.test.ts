import { describe, expect, it } from "vitest";
import {
  googleFormColumns, googleFormResponsesToRows, parseGoogleFormId, parseSpreadsheetId, RESPONDENT_EMAIL_COLUMN,
  sheetValuesToRows, suggestGoogleFormMapping, tallyToRow, typeformToRow,
} from "@shared/connectors";

const form = {
  formId: "f1", info: { title: "ボランティア募集" },
  items: [
    { title: "お名前", questionItem: { question: { questionId: "q1" } } },
    { title: "電話番号", questionItem: { question: { questionId: "q2" } } },
    { title: "参加できる曜日", questionItem: { question: { questionId: "q3" } } },
    { title: "満足度", questionGroupItem: { questions: [{ questionId: "g1", rowQuestion: { title: "内容" } }] } },
    { title: "説明文だけの項目" },
  ],
};

describe("Google フォーム", () => {
  it("質問名を列にし、回答者のメールを列に足す", () => {
    expect(googleFormColumns(form)).toEqual(["お名前", "電話番号", "参加できる曜日", "満足度：内容", RESPONDENT_EMAIL_COLUMN]);
  });
  it("回答を質問名つきの行に変換する（複数選択はカンマでつなぐ）", () => {
    const rows = googleFormResponsesToRows(form, [{
      responseId: "r1", lastSubmittedTime: "2026-10-20T01:00:00Z", respondentEmail: "taro@example.org",
      answers: {
        q1: { questionId: "q1", textAnswers: { answers: [{ value: "山田 太郎" }] } },
        q3: { questionId: "q3", textAnswers: { answers: [{ value: "土" }, { value: "日" }] } },
        g1: { questionId: "g1", textAnswers: { answers: [{ value: "5" }] } },
      },
    }]);
    expect(rows).toEqual([{ external_id: "r1", submitted_at: "2026-10-20T01:00:00Z",
      raw: { "お名前": "山田 太郎", "参加できる曜日": "土, 日", "満足度：内容": "5", [RESPONDENT_EMAIL_COLUMN]: "taro@example.org" } }]);
  });
  it("対応の提案：お名前→氏名、回答者のメール→メール", () => {
    const m = suggestGoogleFormMapping(googleFormColumns(form));
    expect(m["お名前"]).toBe("full_name");
    expect(m["電話番号"]).toBe("phone");
    expect(m[RESPONDENT_EMAIL_COLUMN]).toBe("email");
    expect(m["参加できる曜日"]).toBe("attr:参加できる曜日");
  });
  it("編集用・回答用のどちらの URL からもフォームIDを取り出す", () => {
    const id = "1FAIpQLSd_abcdefghijklmnopqrstuvwxyz0123";
    expect(parseGoogleFormId(`https://docs.google.com/forms/d/${id}/edit`)).toBe(id);
    expect(parseGoogleFormId(`https://docs.google.com/forms/d/e/${id}/viewform`)).toBe(id);
    expect(parseGoogleFormId("https://example.com")).toBeNull();
    expect(parseSpreadsheetId("https://docs.google.com/spreadsheets/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ012345/edit#gid=0")).toBe("1aBcDeFgHiJkLmNoPqRsTuVwXyZ012345");
  });
});

describe("Google スプレッドシート", () => {
  it("1行目を見出しにし、空行を飛ばし、見出しのない列には名前を付ける", () => {
    const { columns, rows } = sheetValuesToRows([["氏名", "メール", ""], ["山田", "a@example.org", "x"], ["", "", ""], ["佐藤"]]);
    expect(columns).toEqual(["氏名", "メール", "列3"]);
    expect(rows.map((r) => r.raw)).toEqual([{ 氏名: "山田", メール: "a@example.org", 列3: "x" }, { 氏名: "佐藤", メール: "", 列3: "" }]);
  });
});

describe("Typeform", () => {
  it("回答の種類ごとに値を取り出し、質問名を項目名にする", () => {
    const row = typeformToRow({ event_id: "ev", form_response: {
      token: "tok1", submitted_at: "2026-10-20T01:00:00Z",
      definition: { fields: [{ id: "a", title: "お名前" }, { id: "b", title: "メール" }, { id: "c", title: "関心" }, { id: "d", title: "同意" }] },
      answers: [
        { type: "text", field: { id: "a" }, text: "山田 花子" },
        { type: "email", field: { id: "b" }, email: "hanako@example.org" },
        { type: "choices", field: { id: "c" }, choices: { labels: ["環境", "子ども"] } },
        { type: "boolean", field: { id: "d" }, boolean: true },
      ],
      hidden: { source: "lp" },
    } });
    expect(row).toEqual({ external_id: "tok1", submitted_at: "2026-10-20T01:00:00Z",
      raw: { "お名前": "山田 花子", "メール": "hanako@example.org", "関心": "環境, 子ども", "同意": "はい", source: "lp" } });
  });
});

describe("Tally", () => {
  it("選択肢のIDを表示名に置き換える", () => {
    const row = tallyToRow({ eventId: "e1", createdAt: "2026-10-20T01:00:00Z", data: { responseId: "resp1", fields: [
      { key: "k1", label: "お名前", type: "INPUT_TEXT", value: "鈴木 一郎" },
      { key: "k2", label: "参加区分", type: "MULTIPLE_CHOICE", value: ["o2"], options: [{ id: "o1", text: "一般" }, { id: "o2", text: "学生" }] },
      { key: "k3", label: "", type: "CHECKBOXES", value: true },
    ] } });
    expect(row).toEqual({ external_id: "resp1", submitted_at: "2026-10-20T01:00:00Z", raw: { "お名前": "鈴木 一郎", "参加区分": "学生", k3: "はい" } });
  });
});
