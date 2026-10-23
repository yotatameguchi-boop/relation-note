// Storage（写真・出力ファイル）のバックアップと復元。
//   ENV_FILE=.env.remote node scripts/storage-sync.mjs download <フォルダ>
//   ENV_FILE=<復元先の env> node scripts/storage-sync.mjs upload <フォルダ>   （同じパスに上書き）
//   ENV_FILE=<env> node scripts/storage-sync.mjs verify <フォルダ>            （復元先の中身とハッシュを比べる）
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

process.loadEnvFile(process.env.ENV_FILE ?? ".env.local");
const [mode, dir] = process.argv.slice(2);
if (!["download", "upload", "verify"].includes(mode) || !dir) throw new Error("usage: storage-sync.mjs download|upload|verify <dir>");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BUCKETS = ["photos", "exports"];
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function listAll(bucket, prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw error;
    for (const f of data) {
      const p = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.id === null) out.push(...(await listAll(bucket, p))); // フォルダ
      else out.push(p);
    }
    if (data.length < 1000) return out;
  }
}

if (mode === "download") {
  const index = [];
  for (const bucket of BUCKETS) {
    for (const p of await listAll(bucket)) {
      const { data, error } = await db.storage.from(bucket).download(p);
      if (error) throw error;
      const buf = Buffer.from(await data.arrayBuffer());
      const dest = path.join(dir, bucket, p);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      index.push({ bucket, path: p, bytes: buf.length, sha256: sha(buf), type: data.type });
    }
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 1));
  console.log(`storage: ${index.length}件 ${(index.reduce((s, f) => s + f.bytes, 0) / 1e6).toFixed(1)}MB`);
} else {
  const index = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
  let ok = 0;
  const bad = [];
  for (const f of index) {
    if (mode === "upload") {
      const buf = await readFile(path.join(dir, f.bucket, f.path));
      const { error } = await db.storage.from(f.bucket).upload(f.path, buf, { upsert: true, contentType: f.type || undefined });
      if (error) bad.push(`${f.bucket}/${f.path}: ${error.message}`);
      else ok++;
    } else {
      const { data, error } = await db.storage.from(f.bucket).download(f.path);
      if (error || sha(Buffer.from(await data.arrayBuffer())) !== f.sha256) bad.push(`${f.bucket}/${f.path}`);
      else ok++;
    }
  }
  console.log(JSON.stringify({ mode, total: index.length, ok, bad }));
  if (bad.length) process.exit(1);
}
