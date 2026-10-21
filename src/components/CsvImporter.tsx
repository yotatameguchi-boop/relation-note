"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { chunk, decodeCsvBytes, parseCsv, suggestMapping, TARGET_FIELDS, toImportRows, type Mapping } from "@/lib/csv";
import { saveMapping } from "@/app/orgs/[orgId]/forms/actions";

const CHUNK = 300;

export function CsvImporter({ orgId, connId, savedMapping, canEditMapping }: {
  orgId: string; connId: string; savedMapping: Mapping; canEditMapping: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function onFile(f: File | null) {
    setError(""); setProgress(""); setFile(f);
    if (!f) return;
    const text = decodeCsvBytes(await f.arrayBuffer());
    const parsed = parseCsv(text);
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setParseErrors(parsed.errors);
    const guess = suggestMapping(parsed.headers);
    setMapping(Object.fromEntries(parsed.headers.map((h) => [h, savedMapping[h] ?? guess[h]])));
  }

  const hasName = useMemo(() => Object.values(mapping).includes("full_name"), [mapping]);
  const mappingChanged = useMemo(() => headers.some((h) => savedMapping[h] !== mapping[h]), [headers, mapping, savedMapping]);

  async function run() {
    setBusy(true); setError("");
    try {
      if (mappingChanged) {
        if (!canEditMapping) throw new Error("項目対応の変更は管理者のみ行えます。保存済みの対応で取り込むか、管理者に依頼してください。");
        const r = await saveMapping(orgId, connId, { ...savedMapping, ...mapping });
        if ("error" in r) throw new Error(r.error);
      }
      const post = async (url: string, body: unknown) => {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "送信に失敗しました。");
        return json;
      };
      const { batchId } = await post(`/api/orgs/${orgId}/imports`, { connectionId: connId, filename: file?.name });
      const parts = chunk(toImportRows(rows, mapping), CHUNK);
      let dup = 0;
      for (let i = 0; i < parts.length; i++) {
        setProgress(`送信中… ${Math.min((i + 1) * CHUNK, rows.length)} / ${rows.length} 行`);
        const r = await post(`/api/orgs/${orgId}/imports/${batchId}`, { rows: parts[i] });
        dup += r.duplicates;
      }
      await post(`/api/orgs/${orgId}/imports/${batchId}`, { start: true });
      setProgress(`送信完了（取り込み済みの回答 ${dup} 行はスキップ）。処理を開始しました。`);
      router.push(`/orgs/${orgId}/imports/${batchId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>CSVを取り込む</h2>
      <p className="small muted">UTF-8 と Excel の Shift_JIS に対応しています。同じ回答（回答IDまたは内容が同じ行）は二重に取り込まれません。</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0] ?? null)} disabled={busy} />
      {parseErrors.length > 0 && (
        <div className="notice notice-warn small" style={{ marginTop: 10 }}>
          CSVの読み取りで注意があります：<ul>{parseErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {headers.length > 0 && (
        <>
          <h3>項目の対応（{rows.length} 行）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>CSVの列</th><th>取り込み先</th><th>1行目の値</th></tr></thead>
              <tbody>
                {headers.map((h) => {
                  const v = mapping[h] ?? "ignore";
                  const isAttr = v.startsWith("attr:");
                  return (
                    <tr key={h}>
                      <td>{h}</td>
                      <td>
                        <select value={isAttr ? "attr" : v} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value === "attr" ? `attr:${h}` : e.target.value })}>
                          {TARGET_FIELDS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          <option value="attr">その他の項目として保存</option>
                        </select>
                      </td>
                      <td className="small muted">{rows[0]?.[h]?.slice(0, 60)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasName && <div className="notice notice-warn" style={{ marginTop: 10 }}>「氏名」に対応する列を選んでください。氏名のない行はエラーになります。</div>}
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={run} disabled={busy || !hasName || rows.length === 0}>
              {mappingChanged ? "対応を保存して取り込む" : "取り込む"}
            </button>
            <span className="small muted">{progress}</span>
          </div>
        </>
      )}
      {error && <div className="notice notice-danger" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}
