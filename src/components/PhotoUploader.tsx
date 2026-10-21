"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

// 原則は元ファイルのまま送り、回転補正・メタデータ除去・縮小はサーバーで行う。
// 15MB を超えるものだけ、ブラウザで縮小してから送る。
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_EDGE = 4800;

async function downscale(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("JPEG / PNG / WebP の画像を選んでください。");
  if (file.size <= MAX_BYTES) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("画像を変換できません"))), "image/jpeg", 0.88));
}

export function PhotoUploader({ orgId, events, defaultEventId }: { orgId: string; events: { id: string; title: string }[]; defaultEventId?: string }) {
  const router = useRouter();
  const [eventId, setEventId] = useState(defaultEventId ?? "");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const supabase = createBrowserSupabase();
    const out: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const blob = await downscale(f);
        const mime = blob.type || f.type;
        const res = await fetch(`/api/orgs/${orgId}/photos`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: f.name, mime, size: blob.size, eventId: eventId || null }),
        });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error);
        const { error } = await supabase.storage.from("photos").uploadToSignedUrl(r.path, r.token, blob, { contentType: mime });
        if (error) throw new Error("アップロードに失敗しました。");
        const done = await fetch(`/api/orgs/${orgId}/photos/${r.photoId}/complete`, { method: "POST" });
        const d = await done.json();
        if (!done.ok) throw new Error(d.error);
        out.push(d.duplicateOf
          ? `✓ ${f.name}：解析待ちに登録しました（同じ写真ファイルがすでに登録されています。写真ファイルの重複であり、写っている人物の重複判定ではありません）`
          : `✓ ${f.name}：解析待ちに登録しました`);
      } catch (e) {
        out.push(`✗ ${f.name}：${e instanceof Error ? e.message : e}`);
      }
      setLog([...out]);
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>写真をアップロード</h2>
      <div className="row">
        <select value={eventId} onChange={(e) => setEventId(e.target.value)} style={{ maxWidth: 280 }} aria-label="イベント">
          <option value="">イベントを選ぶ（任意）</option>
          {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={(e) => upload(e.target.files)} style={{ maxWidth: 320 }} />
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        写真は非公開で保存されます。解析には向きを補正し、位置情報などのメタデータを除いた画像を使います。
        保存期限を過ぎると画像だけ削除されます（人数の記録は残ります）。
      </p>
      {log.length > 0 && <ul className="small">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </div>
  );
}
