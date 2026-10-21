# つながり台帳（NPO向け 顧客・関係人口管理SaaS）

基本設計書 v0.1（2026-10-21）に沿った実装です。複数のNPOが共通基盤を使うマルチテナント型で、
応募フォームの回答を人物単位に整理し、イベント参加履歴と、写真からの人数推定を管理します。

## 構成

| 設計書 | 実装 |
| --- | --- |
| 画面・業務API | Next.js 16（App Router / Server Actions / Route Handlers）・TypeScript |
| DB・団体分離 | Supabase PostgreSQL。全主要テーブルに `organization_id`、外部キーにも団体IDを含め、RLS で参照・追加・更新・削除を制御 |
| 認証・権限 | Supabase Auth ＋ `memberships`（オーナー／管理者／編集者／閲覧者 ＋ 一括出力・一括削除・人物統合・権限変更の個別権限） |
| 写真保存 | Supabase Storage の非公開バケット。アップロードは期限付きURL、閲覧は所属メンバーのみ期限付きURL |
| 非同期処理 | Supabase Queues（pgmq）＋ Edge Function `process-jobs` ＋ Supabase Cron（毎分起動） |
| 人物検出 | Amazon Rekognition DetectLabels（Person）。開発用にダミー検出器（`DETECTOR=mock`） |

ディレクトリ:

- `supabase/migrations/` … スキーマ・RLS・業務ロジック（名寄せ、統合、利用枠、ジョブ、集計）
- `supabase/functions/process-jobs/` … ワーカー（写真解析・回答の取り込み・一括出力・期限切れ整理）
- `src/app/orgs/[orgId]/` … 管理画面
- `src/app/api/` … アップロード・取り込み・外部フォーム受信・出力ダウンロード
- `tests/` … 単体テストと、ローカルSupabaseに対する受け入れテスト

## ローカルで動かす

```bash
npm install
supabase start -x studio,postgres-meta,imgproxy,vector,logflare,realtime,supavisor
supabase status -o env   # 値を .env.local に転記（.env.example 参照）
cp supabase/functions/.env.example supabase/functions/.env   # WORKER_SECRET を設定
supabase functions serve --env-file supabase/functions/.env --no-verify-jwt   # ワーカー
./scripts/setup-local-cron.sh   # Cron から毎分ワーカーを呼ぶための Vault 登録
node scripts/seed-dev.mjs       # デモ団体とサンプルデータ（任意）
npm run dev                     # http://localhost:3080
```

ポートは他プロジェクトと衝突しないよう API 55621 / DB 55622 にしています。
CSV取り込みの試験用ファイル: `scripts/sample-volunteer-form.csv`

## テスト

```bash
npm test
```

ローカルの Supabase が起動している必要があります。設計書 §16 の受け入れ条件のうち、自動で確かめられるものを網羅しています。

- 別団体のデータを API・DB・ストレージから取得・変更できない（他団体IDでの登録、外部キーでの越境、organization_id の付け替え、他団体の写真・出力ファイル、ワーカー専用関数）
- 退会・権限変更が即座に反映される／最後のオーナーは削除・脱退できない
- 同じ回答・ジョブを再送しても二重登録されない（回答ID・原文ハッシュ、Webhook 再送、解析結果の保存の繰り返し、同じ写真のジョブ）
- 名寄せが曖昧な人物（連絡先だけ一致、氏名だけ一致）を自動統合しない
- 推定人数と確定人数を別に保存し、写真人数を参加人数・実参加者数に合算しない
- 利用上限到達時は新規処理を止め（CSV は保留）、既存データは閲覧できる／停止中の団体は閲覧のみ
- 失敗ジョブの再試行・隔離・再実行、隔離分は利用枠に計上しない

## 名寄せのルール（§4.2）

| 状況 | 結果 |
| --- | --- |
| メールまたは電話が一致し、氏名も一致する人物が1人 | 既存人物に紐づけ（空欄の補完と連絡先・タグの追加のみ。上書きしない） |
| メール・電話は一致するが氏名が違う | 確認待ち（家族で共有している可能性） |
| 氏名だけ一致 | 確認待ち（同姓同名の可能性） |
| 一致なし | 新規作成 |

確認待ちは「確認待ちの回答」画面でスタッフが判断します。登録済み人物どうしの重複は「重複候補」画面で統合でき、統合前の状態は履歴に残ります。

## 集計の扱い（§5）

- イベント参加人数 = スタッフ確定値があればそれ、なければ「参加確認済みの記録＋匿名参加者」
- 延べ参加人数 = 期間内のイベント参加人数の合計
- 実参加者数 = 参加確認済みの人物の重複除外（匿名参加者は含められない）
- 継続参加者数・関係人口 = 団体設定の回数・期間で判定
- 写真の人数はイベントごとの最大値を参考表示するだけで、合算も自動転記もしない

## 本番に向けて人が行う作業

1. Supabase プロジェクト（東京リージョン想定）を作成し `supabase db push`、`supabase functions deploy process-jobs`
2. Edge Function のシークレット: `WORKER_SECRET`、`DETECTOR=rekognition`、`AWS_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`
3. Vault に `project_url`（`https://<ref>.supabase.co`）と `worker_secret` を登録（`scripts/setup-local-cron.sh` と同じ内容）
4. Vercel に Next.js をデプロイし、`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_APP_URL` を設定
5. Supabase Auth のメール送信（SMTP）とリダイレクトURLを本番ドメインに設定

## 未実施・未確定（設計書 §17 ほか）

- **Rekognition の実写真評価は未実施**（AWS 認証情報がないため）。少人数・混雑・暗所・重なりの実写真で、正解人数との誤差と修正時間を測ってから採用を決める。縮小率（現在は長辺2560px）もその結果で決める
- 課金・契約（決済連携、プラン変更の申し込み、解約時の出力猶予・削除）は未実装。プランと利用枠は DB の `plans` で管理し、変更はサービスロールのみ
- 招待はリンクを画面に表示する方式で、メール送信はしていない
- 外部フォーム連携は汎用 Webhook（JSON）のみ。対応サービスは実際の利用に合わせて追加する
- 負荷試験（§6 の想定データ量）、バックアップの復元試験、監視（キュー滞留・解析失敗・費用）の設定は未実施
- 料金・利用上限・保存期間・関係人口の定義はすべて仮案（設定や `plans` で変更可能）
