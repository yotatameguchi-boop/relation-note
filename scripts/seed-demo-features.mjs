// ローカル開発用：団体間共有と写真解析 v2 のデモデータ（scripts/seed-dev.mjs の後に実行。本番では実行しない）
//   - 連携相手のデモ団体を作り、両団体で機能フラグを有効にする
//   - 連携 → 共有根拠 → 共有（1人）まで済ませ、もう1人は根拠未記録のまま残す
//   - 回転情報付きの写真を、本番と同じ前処理で登録して解析待ちにする（ワーカーが動いていれば1分以内に解析される）
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { preprocessPhoto, analysisMeta } from "../src/lib/photo/preprocess.ts";

// ENV_FILE で読み込む設定を切り替えられる（クラウドのデモ環境に入れる場合は .env.remote ＋ ALLOW_NON_LOCAL=1）
process.loadEnvFile(process.env.ENV_FILE ?? ".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url) && process.env.ALLOW_NON_LOCAL !== "1") {
  throw new Error("ローカル以外では実行しません（デモ環境に入れる場合は ALLOW_NON_LOCAL=1）");
}
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const user = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: le } = await user.auth.signInWithPassword({ email: process.env.DEV_LOGIN_EMAIL, password: process.env.DEV_LOGIN_PASSWORD });
if (le) throw le;
const must = (r) => { if (r.error) throw r.error; return r.data; };

const A_NAME = "みどり川クリーン会（デモ）";
const B_NAME = "あおば子ども食堂（デモ）";
const orgA = must(await admin.from("organizations").select("id").eq("name", A_NAME).single()).id;
await admin.from("organizations").delete().eq("name", B_NAME);
const orgB = must(await user.rpc("create_organization", { org_name: B_NAME }));
for (const org of [orgA, orgB]) {
  must(await admin.from("organization_features").upsert({ organization_id: org, partner_sharing: true, photo_pipeline_v2: true }));
}

// 連携（A が申請 → B が承認。デモでは同じオーナーが両方の団体に所属している）
const codeB = must(await user.from("organizations").select("partner_code").eq("id", orgB).single()).partner_code;
const pid = must(await user.rpc("request_partnership", { org: orgA, code: codeB, msg: "合同イベントのボランティア調整のため" }));
must(await user.rpc("respond_partnership", { partnership: pid, accept: true }));

// 共有する人（山田 太郎）に表示名・関心分野・スキルを入れる
const taro = must(await user.from("people").select("id").eq("organization_id", orgA).eq("full_name", "山田 太郎").single()).id;
const hanako = must(await user.from("people").select("id").eq("organization_id", orgA).eq("full_name", "佐藤 花子").single()).id;
must(await user.from("people").update({ display_name: "たろうさん", interests: ["環境", "子ども"], skills: ["応急手当", "車の運転"] }).eq("id", taro));
must(await user.from("person_notes").insert({ organization_id: orgA, person_id: taro, body: "（内部メモ）共有されないことの確認用" }));

const fields = ["display_name", "region", "interests", "skills", "tags", "activities"];
must(await user.rpc("record_sharing_authorizations", {
  org: orgA, person_ids: [taro], target: orgB, p_basis_type: "consent", p_basis_detail: "登録時の同意書に団体間共有の項目あり",
  p_purpose: "合同イベントでのボランティア配置の調整", p_allowed_fields: fields,
  p_evidence_ref: "ボランティア登録同意書（2026年度・事務所保管）", p_confirmed_at: new Date().toISOString(),
  p_valid_until: new Date(Date.now() + 365 * 86400e3).toISOString(),
}));
const tag = must(await user.from("tags").select("id").eq("organization_id", orgA).eq("name", "ボランティア").single()).id;
const events = must(await user.from("events").select("id").eq("organization_id", orgA)).map((e) => e.id);
const r = must(await user.rpc("create_share_grants", {
  org: orgA, target: orgB, person_ids: [taro, hanako], p_fields: fields, p_tag_ids: [tag], p_event_ids: events,
  p_expires_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
}));
// 共有後に元の情報を変える（共有先には「更新版を公開」するまで反映されない）
must(await user.from("people").update({ region: "あおば町（転居）" }).eq("id", taro));

// 写真：横長で撮った画像に「右に90度回転」の情報と位置情報が付いたもの
const figure = (cx) => `<circle cx="${cx}" cy="120" r="24" fill="#2b2f36"/><rect x="${cx - 20}" y="146" width="40" height="120" rx="8" fill="#2b2f36"/>`;
const svg = Buffer.from(`<svg width="960" height="600"><rect width="100%" height="100%" fill="#a9d3e6"/><rect y="400" width="960" height="200" fill="#6aa55a"/>${[110, 260, 400, 540, 700, 850].map(figure).join("")}</svg>`);
const img = await sharp(svg).jpeg({ quality: 85 }).withMetadata({ orientation: 6 })
  .withExifMerge({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 40/1 0/1" } }).toBuffer();
const ev = must(await user.from("events").select("id").eq("organization_id", orgA).like("title", "%夏%").single()).id;
const pre = await preprocessPhoto(img);
const res = must(await user.rpc("reserve_photo_upload", { org: orgA, event: ev, file_name: "summer-cleanup-rotated.jpg", mime: pre.mime, size_bytes: img.byteLength }));
must(await admin.storage.from("photos").upload(res.path, img, { contentType: pre.mime }));
const apath = `${orgA}/analysis/${res.photo_id}.jpg`;
must(await admin.storage.from("photos").upload(apath, pre.analysis.buffer, { contentType: "image/jpeg" }));
must(await admin.rpc("complete_photo_upload_v2", {
  photo: res.photo_id, org: orgA, actual_size: pre.bytes, actual_mime: pre.mime, sha256: pre.sha256,
  p_width: pre.upright.width, p_height: pre.upright.height, p_orientation: pre.orientation,
  p_analysis_path: apath, p_analysis_meta: analysisMeta(pre, { analysis: apath, tiles: [] }),
}));

console.log(JSON.stringify({ orgA, orgB, shared: r.created.length, skipped: r.skipped, photo: res.photo_id }));
